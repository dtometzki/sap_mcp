import assert from "node:assert/strict";
import test from "node:test";
import { applyEnv, parseDotEnv } from "./env.js";

test("parseDotEnv reads plain assignments and ignores comments and blank lines", () => {
  const parsed = parseDotEnv("# comment\n\nSAPUSER=S0001234567\n  SAPPASSWORD = secret \n");
  assert.deepEqual(parsed, { SAPUSER: "S0001234567", SAPPASSWORD: "secret" });
});

test("parseDotEnv handles quotes, export prefixes and '=' inside the value", () => {
  const parsed = parseDotEnv(
    ['export SAPUSER="S000"', "SAPPASSWORD='a=b#c'", 'MULTI="line1\\nline2"'].join("\n"),
  );
  assert.equal(parsed.SAPUSER, "S000");
  // Single quotes stay literal: '#' and '=' are valid password characters.
  assert.equal(parsed.SAPPASSWORD, "a=b#c");
  assert.equal(parsed.MULTI, "line1\nline2");
});

test("parseDotEnv strips inline comments only from unquoted values", () => {
  const parsed = parseDotEnv('A=value # trailing\nB="value # kept"\nC=pass#word\n');
  assert.equal(parsed.A, "value");
  assert.equal(parsed.B, "value # kept");
  // No whitespace before '#', so it belongs to the password.
  assert.equal(parsed.C, "pass#word");
});

test("parseDotEnv skips malformed lines instead of throwing", () => {
  const parsed = parseDotEnv("NOT_AN_ASSIGNMENT\n=novalue\n1BAD=x\nGOOD=y\n");
  assert.deepEqual(parsed, { GOOD: "y" });
});

test("applyEnv never overwrites a real environment variable", () => {
  const key = "SAP_TEST_APPLY_ENV";
  try {
    process.env[key] = "from-environment";
    assert.deepEqual(applyEnv({ [key]: "from-file" }), []);
    assert.equal(process.env[key], "from-environment");

    delete process.env[key];
    assert.deepEqual(applyEnv({ [key]: "from-file" }), [key]);
    assert.equal(process.env[key], "from-file");
  } finally {
    delete process.env[key];
  }
});
