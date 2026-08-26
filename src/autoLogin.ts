import type { Page } from "playwright";
import type { Config } from "./config.js";
import { SapSession, looksLikeLoginPage } from "./session.js";
import { isAllowedLoginUrl } from "./urls.js";

/**
 * Non-interactive login with the credentials from .env (SAPUSER / SAPPASSWORD).
 *
 * Deliberately narrow in scope: it fills the SAP identity provider's form and reports
 * whether that was enough. Anything that needs a human — MFA, a captcha, a forced
 * password change — is detected and reported as such instead of being worked around.
 */

/** A failed automatic login. `permanent` marks causes that a retry cannot fix. */
export class AutoLoginError extends Error {
  constructor(
    message: string,
    /** Retrying with the same credentials would fail exactly the same way. */
    readonly permanent = false,
  ) {
    super(message);
    this.name = "AutoLoginError";
  }
}

/** The identity provider is asking for a second factor; only a human can supply it. */
export class MfaRequiredError extends AutoLoginError {
  constructor() {
    super(
      "The SAP identity provider requires multi-factor authentication, which cannot be " +
        "automated. Run `npm run login` once and complete MFA in the browser window; the " +
        "saved session then keeps the server going until it expires.",
      true,
    );
    this.name = "MfaRequiredError";
  }
}

export interface Credentials {
  username: string;
  password: string;
}

/** Credentials, or undefined when either half is missing (partial config is not a login). */
export function credentialsFromConfig(config: Config): Credentials | undefined {
  if (config.username === undefined || config.password === undefined) return undefined;
  return { username: config.username, password: config.password };
}

/**
 * The identity provider's own logon message: rendered only for a rejected password or a
 * locked user, so its text is a definitive answer and retrying is pointless (permanent).
 */
const LOGIN_REJECTION_SELECTOR = "#logonMessageText";

/**
 * Generic banners. They also carry cookie hints, maintenance notices and "password
 * expires soon" warnings, so their text must never abort a login on its own — it is only
 * reported when the login has not completed, and never disables the automatic login.
 */
const LOGIN_MESSAGE_SELECTOR = [
  ".sapMMessageStrip",
  "[role='alert']",
  ".messageError",
  ".errorMessage",
].join(", ");

const POLL_INTERVAL_MS = 500;

async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * Submits the current step: clicks the submit button when there is one, otherwise
 * presses Enter (some IdP variants render a link or an auto-submitting field).
 */
/**
 * Called immediately before every credential keystroke. The probe URL is already
 * allow-listed at config load, but page.goto follows redirects — a foreign final
 * URL must never receive the S-user password.
 */
function assertTrustedLoginPage(page: Page): void {
  const url = page.url();
  if (isAllowedLoginUrl(url)) return;
  throw new AutoLoginError(
    `Refusing to enter credentials on a non-SAP host (${url}). ` +
      `Automatic login only types the S-user password on https://*.sap.com / https://*.sap.cn. ` +
      `Check SAP_PROBE_URL.`,
    true,
  );
}

async function submitStep(page: Page, config: Config): Promise<void> {
  const submit = page.locator(config.loginSubmitSelector).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click({ timeout: config.loginStepTimeoutMs });
  } else {
    await page.keyboard.press("Enter");
  }
  // The step is either a navigation or an in-place SPA transition; do not insist on either.
  await page
    .waitForLoadState("domcontentloaded", { timeout: config.loginStepTimeoutMs })
    .catch(() => undefined);
}

/**
 * Fills the (usually two-step) SAP logon form: user, submit, password, submit.
 * Single-page variants that show both fields at once are handled by skipping the
 * intermediate submit.
 */
export async function fillLoginForm(
  page: Page,
  config: Config,
  credentials: Credentials,
): Promise<void> {
  const user = page.locator(config.loginUserSelector).first();
  await user
    .waitFor({ state: "visible", timeout: config.loginStepTimeoutMs })
    .catch(() => {
      throw new AutoLoginError(
        "No login form found (SAP_LOGIN_USER_SELECTOR did not match). The portal frontend " +
          "may have changed; adjust the selector in .env or run `npm run login`.",
      );
    });
  assertTrustedLoginPage(page);
  await user.fill(credentials.username);

  // Only advance a step when the password field is not on this page already.
  if (!(await isVisible(page, config.loginPasswordSelector))) {
    await submitStep(page, config);
  }

  const password = page.locator(config.loginPasswordSelector).first();
  await password.waitFor({ state: "visible", timeout: config.loginStepTimeoutMs }).catch(() => {
    throw new AutoLoginError(
      "The password field never appeared after submitting the user. Check SAPUSER, or run " +
        "`npm run login` to see what the portal is asking for.",
    );
  });
  assertTrustedLoginPage(page);
  await password.fill(credentials.password);
  await submitStep(page, config);
}

/**
 * Waits for the outcome of the submitted form.
 *
 * Resolves once the browser has left the identity provider; throws MfaRequiredError as
 * soon as a one-time-code field shows up, and AutoLoginError with the portal's own
 * message when the credentials are rejected. The password field staying visible is
 * treated as a rejection, because that is what the IdP does with a wrong password.
 */
export async function waitForLoginResult(page: Page, config: Config): Promise<void> {
  const deadline = Date.now() + config.loginStepTimeoutMs;

  while (Date.now() < deadline) {
    if (await isVisible(page, config.loginMfaSelector)) throw new MfaRequiredError();

    const onLoginPage = looksLikeLoginPage(page.url());
    const passwordVisible = await isVisible(page, config.loginPasswordSelector);
    if (!onLoginPage && !passwordVisible) return;

    const rejection = await bannerText(page, LOGIN_REJECTION_SELECTOR);
    if (rejection !== "") {
      throw new AutoLoginError(`The SAP identity provider rejected the login: ${rejection}`, true);
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  if (await isVisible(page, config.loginMfaSelector)) throw new MfaRequiredError();
  const notice = await bannerText(page, LOGIN_MESSAGE_SELECTOR);
  throw new AutoLoginError(
    "The login did not complete within SAP_LOGIN_STEP_TIMEOUT_MS. Run `npm run login` to " +
      "see what the portal is showing." +
      (notice === "" ? "" : ` The page shows: ${notice}`),
  );
}

async function bannerText(page: Page, selector: string): Promise<string> {
  const text = await page
    .locator(selector)
    .first()
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  return text.trim();
}

/**
 * Full non-interactive login: fresh browser, form, verification, saved session state.
 * Always closes its own browser — this runs on the server's error path, where a leaked
 * Chromium would accumulate with every expired session.
 */
export async function performAutoLogin(
  config: Config,
  credentials: Credentials,
  headless = true,
): Promise<void> {
  const session = new SapSession(config, headless);
  try {
    await session.start({ allowMissingState: true, ignoreStoredState: true });
    const page = await session.newPage();
    await page.goto(config.sessionProbeUrl, { waitUntil: "domcontentloaded" });
    // fillLoginForm re-checks the (possibly redirected) URL before each keystroke.
    await fillLoginForm(page, config, credentials);
    await waitForLoginResult(page, config);

    if (!(await session.isAuthenticated())) {
      throw new AutoLoginError(
        "The login form was accepted, but the portal still does not consider the session " +
          "authenticated.",
      );
    }
    await session.saveState();
  } finally {
    await session.close().catch(() => undefined);
  }
}
