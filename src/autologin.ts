import type { Page } from "playwright";

/**
 * Non-interactive login support.
 *
 * This is deliberately isolated from the MCP server: the server never reads a
 * password (see config.ts / README). Only the login CLI opts into reading
 * `SAP_PASSWORD`, and only when the user has explicitly provided that secret.
 * The flow assumes an S-user WITHOUT MFA — a second factor cannot be satisfied
 * from stored credentials alone.
 */
export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * CSS selectors for the SAP identity-provider login form. Configurable via ENV
 * for the same reason the portal URLs are: SAP reworks the sign-in frontend
 * without notice, and a changed field id must be fixable without a code change.
 * Each value may list several comma-separated candidates; the first visible
 * match wins.
 */
export interface LoginSelectors {
  username: string;
  password: string;
  submit: string;
}

export const DEFAULT_LOGIN_SELECTORS: LoginSelectors = {
  username: [
    "input[name='j_username']",
    "#j_username",
    "input[type='email']",
    "input[autocomplete='username']",
    "input[name='username']",
  ].join(", "),
  password: [
    "input[name='j_password']",
    "#j_password",
    "input[type='password']",
    "input[autocomplete='current-password']",
  ].join(", "),
  submit: [
    "#logOnFormSubmit",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Log On')",
    "button:has-text('Sign In')",
    "button:has-text('Continue')",
    "button:has-text('Weiter')",
    "button:has-text('Anmelden')",
  ].join(", "),
};

/**
 * Reads the login credentials from the environment, or returns undefined when
 * they are not both present. The username is trimmed (S-users never contain
 * surrounding spaces); the password is used verbatim so a legitimate leading or
 * trailing space is never silently dropped.
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): LoginCredentials | undefined {
  const username = env.SAP_USERNAME?.trim();
  const password = env.SAP_PASSWORD;
  if (username === undefined || username === "" || password === undefined || password === "") {
    return undefined;
  }
  return { username, password };
}

/** Merges the configurable selector overrides over the defaults. */
export function loginSelectorsFromEnv(env: NodeJS.ProcessEnv = process.env): LoginSelectors {
  const override = (raw: string | undefined, fallback: string): string => {
    const trimmed = raw?.trim();
    return trimmed === undefined || trimmed === "" ? fallback : trimmed;
  };
  return {
    username: override(env.SAP_LOGIN_USER_SELECTOR, DEFAULT_LOGIN_SELECTORS.username),
    password: override(env.SAP_LOGIN_PASS_SELECTOR, DEFAULT_LOGIN_SELECTORS.password),
    submit: override(env.SAP_LOGIN_SUBMIT_SELECTOR, DEFAULT_LOGIN_SELECTORS.submit),
  };
}

/**
 * Drives a rendered SAP login form to completion: fills the username, advances
 * a two-step form if the password field is not shown yet, fills the password
 * and submits. Handles both the single-page (username + password together) and
 * the two-step (username, then password) variants of the SAP identity provider.
 *
 * Only the form interaction lives here; the caller is responsible for opening
 * the page, waiting for the post-login redirect and verifying/persisting the
 * session. The password is never logged.
 */
export async function submitLoginForm(
  page: Page,
  credentials: LoginCredentials,
  selectors: LoginSelectors,
  stepTimeoutMs: number,
): Promise<void> {
  const usernameField = page.locator(selectors.username).first();
  await usernameField.waitFor({ state: "visible", timeout: stepTimeoutMs });
  await usernameField.fill(credentials.username);

  const passwordField = page.locator(selectors.password).first();
  const passwordVisible = await passwordField.isVisible().catch(() => false);
  if (!passwordVisible) {
    // Two-step form: submit the username to reveal the password step.
    await page
      .locator(selectors.submit)
      .first()
      .click({ timeout: stepTimeoutMs })
      .catch(() => undefined);
    await passwordField.waitFor({ state: "visible", timeout: stepTimeoutMs });
  }

  await passwordField.fill(credentials.password);
  await page.locator(selectors.submit).first().click({ timeout: stepTimeoutMs });
}
