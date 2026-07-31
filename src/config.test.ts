import assert from "node:assert/strict";
import test from "node:test";
import { intFromEnv } from "./config.js";

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
