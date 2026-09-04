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
   * Optional: logs in non-interactively and writes a fresh session state file.
   * Only wired up when credentials are configured; rejecting means "still logged out".
   * An error carrying `permanent: true` (MFA, rejected credentials) disables further
   * attempts for the process lifetime.
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
  /**
   * After a failed automatic login, suppress further attempts for this long. Without it
   * every tool call of a client that retries would hammer the SAP identity provider with
   * the same bad credentials — a reliable way to get an S-user locked.
   */
  autoLoginCooldownMs?: number;
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

/** Both error types already carry a complete, actionable message; do not bury it behind a prefix. */
function toErrorText(error: unknown): string {
  if (error instanceof SessionExpiredError || error instanceof AccessDeniedError) {
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
  /** Epoch ms before which no automatic login is attempted; Infinity = permanently off. */
  private autoLoginBlockedUntilMs = 0;

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
    try {
      await this.deps.saveState();
      // Only throttle after a successful write. A transient disk error should be retried
      // by the next tool call instead of suppressing persistence for the whole interval.
      this.lastStateSaveMs = Date.now();
    } catch {
      // State persistence is best-effort and must not turn a successful portal call into
      // a tool error. The next call will try to save again because the timestamp is unchanged.
    }
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

  /** One attempt: ensure the session, run the operation, persist refreshed cookies. */
  private async runOnce<T>(operation: () => Promise<T>, persistState: boolean): Promise<T> {
    await this.deps.ensureSession();
    const value = await operation();
    if (persistState) await this.persistSessionState();
    return value;
  }

  /**
   * Attempts a non-interactive re-login. Returns false when it is not configured, still
   * in the cooldown, or failed — the caller then reports the original expiry message,
   * which tells the user to run `npm run login`.
   *
   * Called from INSIDE the serialized queue, so it closes the session directly instead
   * of enqueuing (runSerialized here would deadlock on its own slot).
   */
  private async tryReauthenticate(): Promise<boolean> {
    const reauthenticate = this.deps.reauthenticate;
    if (!reauthenticate) return false;
    if (Date.now() < this.autoLoginBlockedUntilMs) return false;

    this.deps.resetTokenCache();
    await this.deps.close().catch(() => undefined);
    try {
      await reauthenticate();
      // The state file was just written by the login; do not overwrite it moments later
      // with the cookies of the context that is only about to be created.
      this.lastStateSaveMs = Date.now();
      return true;
    } catch (error) {
      const permanent = error instanceof Error && (error as { permanent?: boolean }).permanent;
      this.autoLoginBlockedUntilMs = permanent
        ? Number.POSITIVE_INFINITY
        : Date.now() + (this.options.autoLoginCooldownMs ?? 5 * 60_000);
      // stderr only: stdout carries the MCP protocol.
      process.stderr.write(
        `[sap-notes] automatic login failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return false;
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
        try {
          return await this.runOnce(operation, persistState);
        } catch (error) {
          // One automatic login, then one retry — inside the same serialized slot, so
          // concurrent tool calls can never trigger parallel logins.
          if (!(error instanceof SessionExpiredError)) throw error;
          if (!(await this.tryReauthenticate())) throw error;
          return await this.runOnce(operation, persistState);
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
