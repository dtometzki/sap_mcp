import assert from "node:assert/strict";
import test from "node:test";
import { boolFromEnv, intFromEnv, loadConfig } from "./config.js";
import { applyEnv, resetEnvKeysFromFile } from "./env.js";

const TEST_VAR = "SAP_TEST_INT_FROM_ENV";

test("intFromEnv returns the fallback when the variable is unset", () => {
  delete process.env[TEST_VAR];
  assert.equal(intFromEnv(TEST_VAR, 42), 42);
});

test("intFromEnv parses plain integers, also with surrounding whitespace", () => {
  try {
    process.env[TEST_VAR] = "60000";
    assert.equal(intFromEnv(TEST_VAR, 1), 60_000);
    process.env[TEST_VAR] = " 7 ";
    assert.equal(intFromEnv(TEST_VAR, 1), 7);
    // minimum 0 lets the user disable a feature explicitly.
    process.env[TEST_VAR] = "0";
    assert.equal(intFromEnv(TEST_VAR, 1, 0), 0);
  } finally {
    delete process.env[TEST_VAR];
  }
});

test("intFromEnv rejects junk instead of silently truncating it", () => {
  try {
    // parseInt would silently turn all of these into numbers.
    process.env[TEST_VAR] = "60000ms";
    assert.throws(() => intFromEnv(TEST_VAR, 1), /must be an integer >= 1, got: 60000ms/);
    process.env[TEST_VAR] = "12abc";
    assert.throws(() => intFromEnv(TEST_VAR, 1), /must be an integer/);
    process.env[TEST_VAR] = "12.5";
    assert.throws(() => intFromEnv(TEST_VAR, 1), /must be an integer/);
    process.env[TEST_VAR] = "";
    assert.throws(() => intFromEnv(TEST_VAR, 1), /must be an integer/);
    process.env[TEST_VAR] = "0";
    assert.throws(() => intFromEnv(TEST_VAR, 1), /must be an integer >= 1, got: 0/);
    process.env[TEST_VAR] = "-5";
    assert.throws(() => intFromEnv(TEST_VAR, 1), /must be an integer/);
  } finally {
    delete process.env[TEST_VAR];
  }
});

const CREDENTIAL_VARS = ["SAPUSER", "SAPPASSWORD", "SAP_USERNAME", "SAP_PASSWORD", "SAP_AUTO_LOGIN"];

function clearCredentialVars(): void {
  resetEnvKeysFromFile();
  for (const name of CREDENTIAL_VARS) delete process.env[name];
}

test("credentials are read from the real environment, with or without a .env file", () => {
  try {
    clearCredentialVars();
    process.env.SAPUSER = "S0001234567";
    process.env.SAPPASSWORD = "secret";
    const config = loadConfig();
    assert.equal(config.username, "S0001234567");
    assert.equal(config.password, "secret");
    assert.equal(config.autoLoginEnabled, true);
  } finally {
    clearCredentialVars();
  }
});

test("an exported alias beats a preferred name that only came from the .env file", () => {
  try {
    clearCredentialVars();
    // The file supplies SAPUSER...
    applyEnv({ SAPUSER: "S-FROM-FILE", SAPPASSWORD: "file-secret" });
    // ...while the shell exports the older spelling. Origin wins over spelling.
    process.env.SAP_USERNAME = "S-FROM-SHELL";
    assert.equal(loadConfig().username, "S-FROM-SHELL");
    // The password only exists in the file, so it is still used.
    assert.equal(loadConfig().password, "file-secret");
  } finally {
    clearCredentialVars();
  }
});

test("within one origin the preferred spelling wins", () => {
  try {
    clearCredentialVars();
    process.env.SAPUSER = "S-NEW";
    process.env.SAP_USERNAME = "S-OLD";
    assert.equal(loadConfig().username, "S-NEW");
  } finally {
    clearCredentialVars();
  }
});

test("auto-login stays off without a password, and SAP_AUTO_LOGIN=0 overrides it", () => {
  try {
    clearCredentialVars();
    process.env.SAPUSER = "S0001234567";
    assert.equal(loadConfig().autoLoginEnabled, false, "no password, nothing to automate");

    process.env.SAPPASSWORD = "secret";
    assert.equal(loadConfig().autoLoginEnabled, true);

    process.env.SAP_AUTO_LOGIN = "0";
    assert.equal(loadConfig().autoLoginEnabled, false);
    process.env.SAP_AUTO_LOGIN = "vielleicht";
    assert.throws(() => boolFromEnv("SAP_AUTO_LOGIN", true), /must be one of/);
  } finally {
    clearCredentialVars();
  }
});
