import type { Page } from "playwright";
import type { Config } from "./config.js";
import type { SapSession } from "./session.js";

/** Base class for every failure of the unattended (env-credential) login. */
export class AutoLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoLoginError";
  }
}

/** SAP_USERNAME / SAP_PASSWORD are not both set, so no unattended login is possible. */
export class AutoLoginNotConfiguredError extends AutoLoginError {
  constructor() {
    super(
      "Automatic login is not configured. Set SAP_USERNAME and SAP_PASSWORD in the " +
        "environment, or run `npm run login` once to sign in interactively.",
    );
    this.name = "AutoLoginNotConfiguredError";
  }
}

/**
 * The identity provider asked for a second factor. An OTP/authenticator prompt cannot
 * be answered from stored credentials, so we stop instead of hanging on the form.
 */
export class MfaRequiredError extends AutoLoginError {
  constructor() {
    super(
      "Automatic login stopped: the SAP identity provider requires multi-factor " +
        "authentication (a one-time / authenticator code), which cannot be supplied from " +
        "SAP_USERNAME/SAP_PASSWORD. Run `npm run login` once on the host to sign in " +
        "interactively (including MFA); the saved session is then reused headlessly.",
    );
    this.name = "MfaRequiredError";
  }
}

/** Filled the form but the portal still shows the login page — usually wrong credentials. */
export class LoginFailedError extends AutoLoginError {
  constructor() {
    super(
      "Automatic login failed: after submitting SAP_USERNAME/SAP_PASSWORD the portal " +
        "still returns the login page. Check the credentials (and whether the S-user " +
        "requires MFA).",
    );
    this.name = "LoginFailedError";
  }
}

/** True only when both an S-user and a password are available for an unattended login. */
export function credentialsConfigured(config: Config): boolean {
  return Boolean(config.username?.trim() && config.password?.trim());
}

/**
 * Phrases that mark a page as a second-factor challenge. Deliberately specific so a
 * normal username/password form is not misread as MFA. Matched case-insensitively.
 */
const MFA_MARKERS = [
  "verification code",
  "one-time password",
  "one time password",
  "one-time passcode",
  "authenticator app",
  "authenticator",
  "two-step verification",
  "two-factor",
  "two factor",
  "second factor",
  "einmalkennwort",
  "bestätigungscode",
  "verifizierungscode",
  "zwei-faktor",
] as const;

/** Whether the rendered page text indicates a multi-factor / OTP challenge. */
export function isMfaChallenge(pageText: string): boolean {
  const text = pageText.toLowerCase();
  return MFA_MARKERS.some((marker) => text.includes(marker));
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

/** Clicks the submit button if present, otherwise falls back to pressing Enter. */
async function submitStep(page: Page, config: Config): Promise<void> {
  const button = page.locator(config.loginSubmitSelector).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    return;
  }
  await page.keyboard.press("Enter");
}

/**
 * Drives the SAP Identity Service login form. Handles both the two-step layout
 * (username → continue → password) and single-page forms. Selectors are configurable
 * so a portal change is fixable without a code change.
 */
async function fillLoginForm(page: Page, config: Config): Promise<void> {
  const timeout = config.navigationTimeoutMs;
  const username = config.username ?? "";
  const password = config.password ?? "";

  const userField = page.locator(config.loginUsernameSelector).first();
  await userField.waitFor({ state: "visible", timeout });
  await userField.fill(username);

  const passwordField = page.locator(config.loginPasswordSelector).first();
  if (!(await isVisible(page, config.loginPasswordSelector))) {
    // Two-step layout: advance from the username page to the password page.
    await submitStep(page, config);
    await passwordField.waitFor({ state: "visible", timeout });
  }

  await passwordField.fill(password);
  await submitStep(page, config);
}

/**
 * Signs in unattended with SAP_USERNAME / SAP_PASSWORD and leaves the session's context
 * authenticated. Call on a context started via SapSession.startForLogin(); the caller
 * persists the result with saveState(). Throws a specific AutoLoginError on
 * misconfiguration, an MFA prompt, or rejected credentials.
 */
export async function performAutomatedLogin(session: SapSession, config: Config): Promise<void> {
  if (!credentialsConfigured(config)) throw new AutoLoginNotConfiguredError();

  const page = await session.newPage();
  try {
    await page.goto(config.sessionProbeUrl, { waitUntil: "domcontentloaded" });
    await fillLoginForm(page, config);
    // Let the post-submit redirect / SPA settle before inspecting the result.
    await page
      .waitForLoadState("networkidle", { timeout: config.networkIdleTimeoutMs })
      .catch(() => undefined);

    const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
    if (isMfaChallenge(bodyText)) throw new MfaRequiredError();
  } finally {
    if (!page.isClosed()) await page.close();
  }

  // The probe reloads the protected page: the only trustworthy proof of a live session.
  if (!(await session.isAuthenticated())) throw new LoginFailedError();
}
