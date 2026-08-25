import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import { credentialsConfigured, isMfaChallenge } from "./autoLogin.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("credentialsConfigured requires both a non-blank username and password", () => {
  withEnv({ SAP_USERNAME: "s0001234567", SAP_PASSWORD: "secret" }, () => {
    assert.equal(credentialsConfigured(loadConfig()), true);
  });
  withEnv({ SAP_USERNAME: "s0001234567", SAP_PASSWORD: undefined }, () => {
    assert.equal(credentialsConfigured(loadConfig()), false);
  });
  withEnv({ SAP_USERNAME: undefined, SAP_PASSWORD: "secret" }, () => {
    assert.equal(credentialsConfigured(loadConfig()), false);
  });
  // Whitespace-only values are treated as "not set" so a blank secret cannot half-enable it.
  withEnv({ SAP_USERNAME: "  ", SAP_PASSWORD: "secret" }, () => {
    assert.equal(credentialsConfigured(loadConfig()), false);
  });
});

test("isMfaChallenge detects second-factor prompts in several languages", () => {
  assert.equal(isMfaChallenge("Please enter your verification code"), true);
  assert.equal(isMfaChallenge("Open your authenticator app"), true);
  assert.equal(isMfaChallenge("Two-step verification required"), true);
  assert.equal(isMfaChallenge("Bitte geben Sie Ihren Bestätigungscode ein"), true);
  assert.equal(isMfaChallenge("Einmalkennwort eingeben"), true);
});

test("isMfaChallenge does not fire on a plain username/password form", () => {
  assert.equal(isMfaChallenge("Sign in with your S-user and password"), false);
  assert.equal(isMfaChallenge("Passwort vergessen? Anmelden mit E-Mail"), false);
  assert.equal(isMfaChallenge(""), false);
});
