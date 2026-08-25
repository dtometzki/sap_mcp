import { AutoLoginError } from "./autoLogin.js";
import { AccessDeniedError, SessionExpiredError } from "./session.js";

/**
 * What ToolRunner needs from the SAP session. Kept as a narrow interface so the
 * queue/persist/recovery logic is unit-testable without a real Playwright browser.
 */
export interface ToolRunnerDeps {
  /** Starts the shared session (idempotent, concurrency-safe). */
  ensureSession(): Promise<void>;
  /** Persists the browser's refreshed cookies back to the state file. */
  saveState(): Promise<void>;
  /** Closes the browser context. */
  close(): Promise<void>;
  /** Drops cached tokens (Coveo) when the underlying session changes. */
  resetTokenCache(): void;
  /**
   * Optional: re-establishes an authenticated session unattended (env credentials).
   * Provided only when SAP_USERNAME/SAP_PASSWORD are configured. When present, an
   * expired session is repaired automatically and the failed tool call is retried
   * once, so clients never see a "session expired" error they cannot act on. Rejects
   * with an AutoLoginError (MFA required, wrong credentials) when it cannot recover.
   */
  reauthenticate?: () => Promise<void>;
}

export interface ToolRunnerOptions {
  /**
   * Close the session after this many milliseconds without a tool call
   * (frees the headless browser's RAM); the next call relaunches it lazily.
   * 0 disables the idle shutdown.
   */
  idleTimeoutMs: number;
  /** Minimum interval between state-file rewrites (throttles saveState). */
  stateSaveIntervalMs: number;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ExecuteOptions {
  /**
   * Whether a successful call may write the browser's cookies back to the state file.
   *
   * Off for the status check: it reports an expired session by RETURNING false rather
   * than throwing, so the call counts as successful and would persist the dead cookie
   * jar — overwriting a state file that `npm run login` had just refreshed in another
   * terminal, i.e. destroying the very session the user ran the check to verify.
   */
  persistState?: boolean;
}

/** These error types already carry a complete, actionable message; do not bury it behind a prefix. */
function toErrorText(error: unknown): string {
  if (
    error instanceof SessionExpiredError ||
    error instanceof AccessDeniedError ||
    error instanceof AutoLoginError
  ) {
    return error.message;
  }
  if (error instanceof Error) return `SAP portal request failed: ${error.message}`;
  return "SAP portal request failed with an unknown error.";
}

/**
 * Serializes tool calls against the shared session, persists refreshed cookies,
 * recovers from session expiry, and manages the idle browser shutdown.
 *
 * Extracted from the MCP server glue so this behavior is unit-testable offline:
 * a bug here (a deadlock, a state overwrite, a leaked browser) is the worst failure
 * mode an MCP server can have.
 */
export class ToolRunner {
  /**
   * SAP calls share one authenticated browser context and are deliberately serialized.
   * This keeps concurrent MCP clients from creating request bursts against the portal.
   */
  private requestQueue: Promise<void> = Promise.resolve();
  private lastStateSaveMs = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private isShuttingDown = false;

  constructor(
    private readonly deps: ToolRunnerDeps,
    private readonly options: ToolRunnerOptions,
  ) {}

  /** Runs an operation after all previously queued ones have settled. */
  runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation);
    // The queue must stay alive even when an operation rejects.
    this.requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The portal rotates/extends cookies while the session is used, but the browser
   * context is volatile — without writing the state back, the stored session dies at
   * the ORIGINAL cookie expiry. Throttled and best-effort: a failed save must never
   * fail the tool call that triggered it. Called from inside the serialized queue.
   */
  private async persistSessionState(): Promise<void> {
    const now = Date.now();
    if (now - this.lastStateSaveMs < this.options.stateSaveIntervalMs) return;
    this.lastStateSaveMs = now;
    await this.deps.saveState().catch(() => undefined);
  }

  /**
   * An idle headless Chromium holds roughly 200 MB of RAM. Close the session after a
   * period of inactivity; start() is lazy and idempotent, so the next tool call simply
   * relaunches the browser and re-reads the stored session state.
   */
  scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.options.idleTimeoutMs <= 0) return; // 0 disables the idle shutdown
    this.idleTimer = setTimeout(() => {
      // Enqueue via the request queue so we never close mid-operation.
      this.runSerialized(() => this.deps.close()).catch(() => undefined);
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref(); // the timer alone must not keep the process alive
  }

  /**
   * On session expiry, drop the stale browser context: the next call then re-reads
   * the state file from disk, so a fresh `npm run login` is picked up WITHOUT
   * restarting the MCP server. Serialized to avoid racing queued operations.
   */
  private async recoverFromError(error: unknown): Promise<void> {
    if (error instanceof SessionExpiredError) {
      this.deps.resetTokenCache();
      await this.runSerialized(() => this.deps.close()).catch(() => undefined);
    }
  }

  /**
   * Shared wrapper for every tool call: serializes access, ensures the session,
   * persists refreshed cookies, handles errors, and reschedules the idle timer.
   */
  async execute<T>(
    operation: () => Promise<T>,
    format: (result: T) => string,
    { persistState = true }: ExecuteOptions = {},
  ): Promise<ToolResponse> {
    try {
      const result = await this.runSerialized(async () => {
        await this.deps.ensureSession();
        try {
          const value = await operation();
          if (persistState) await this.persistSessionState();
          return value;
        } catch (error) {
          if (!(error instanceof SessionExpiredError) || !this.deps.reauthenticate) throw error;
          // Unattended credentials are configured: drop the dead context, sign back in,
          // and retry the call once so the client never sees a recoverable expiry.
          this.deps.resetTokenCache();
          await this.deps.close().catch(() => undefined);
          await this.deps.reauthenticate();
          const value = await operation();
          if (persistState) await this.persistSessionState();
          return value;
        }
      });
      return { content: [{ type: "text", text: format(result) }] };
    } catch (error) {
      await this.recoverFromError(error);
      return { isError: true, content: [{ type: "text", text: toErrorText(error) }] };
    } finally {
      this.scheduleIdleClose();
    }
  }

  /**
   * Waits for queued work to settle, then closes the session. Safe to call
   * repeatedly; a hanging browser close never keeps the process alive forever.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.deps.resetTokenCache();
    await Promise.race([
      this.runSerialized(() => this.deps.close()).catch(() => undefined),
      new Promise((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        timeout.unref();
      }),
    ]);
  }
}
