import assert from "node:assert/strict";
import test from "node:test";
import { intFromEnv, loadConfig } from "./config.js";

const TEST_VAR = "SAP_TEST_INT_FROM_ENV";

test("loadConfig surfaces SAP_USERNAME and SAP_PASSWORD for the unattended login", () => {
  const savedUser = process.env.SAP_USERNAME;
  const savedPassword = process.env.SAP_PASSWORD;
  try {
    process.env.SAP_USERNAME = "s0001234567";
    process.env.SAP_PASSWORD = "secret";
    const config = loadConfig();
    assert.equal(config.username, "s0001234567");
    assert.equal(config.password, "secret");

    delete process.env.SAP_PASSWORD;
    assert.equal(loadConfig().password, undefined);
  } finally {
    if (savedUser === undefined) delete process.env.SAP_USERNAME;
    else process.env.SAP_USERNAME = savedUser;
    if (savedPassword === undefined) delete process.env.SAP_PASSWORD;
    else process.env.SAP_PASSWORD = savedPassword;
  }
});

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
