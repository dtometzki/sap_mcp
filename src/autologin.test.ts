import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOGIN_SELECTORS,
  credentialsFromEnv,
  loginSelectorsFromEnv,
} from "./autologin.js";

test("credentialsFromEnv returns undefined unless both username and password are set", () => {
  assert.equal(credentialsFromEnv({}), undefined);
  assert.equal(credentialsFromEnv({ SAP_USERNAME: "S0009000482" }), undefined);
  assert.equal(credentialsFromEnv({ SAP_PASSWORD: "secret" }), undefined);
  // Empty strings do not count as provided.
  assert.equal(credentialsFromEnv({ SAP_USERNAME: "  ", SAP_PASSWORD: "secret" }), undefined);
  assert.equal(credentialsFromEnv({ SAP_USERNAME: "S0009000482", SAP_PASSWORD: "" }), undefined);
});

test("credentialsFromEnv trims the username but keeps the password verbatim", () => {
  assert.deepEqual(credentialsFromEnv({ SAP_USERNAME: "  S0009000482 ", SAP_PASSWORD: " pw " }), {
    username: "S0009000482",
    password: " pw ",
  });
});

test("loginSelectorsFromEnv falls back to the defaults when unset or blank", () => {
  assert.deepEqual(loginSelectorsFromEnv({}), DEFAULT_LOGIN_SELECTORS);
  assert.deepEqual(
    loginSelectorsFromEnv({ SAP_LOGIN_USER_SELECTOR: "   " }),
    DEFAULT_LOGIN_SELECTORS,
  );
});

test("loginSelectorsFromEnv applies overrides and trims them", () => {
  const selectors = loginSelectorsFromEnv({
    SAP_LOGIN_USER_SELECTOR: " #user ",
    SAP_LOGIN_PASS_SELECTOR: "#pass",
    SAP_LOGIN_SUBMIT_SELECTOR: "#go",
  });
  assert.deepEqual(selectors, { username: "#user", password: "#pass", submit: "#go" });
});
