import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEnv,
  envFileCandidates,
  envKeysFromFile,
  inspectEnvFile,
  parseDotEnv,
  resetEnvKeysFromFile,
  scrubCredentialsFromEnv,
  scrubPasswordFromEnv,
} from "./env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("parseDotEnv allows an inline comment after a quoted value", () => {
  const parsed = parseDotEnv(
    ['A="ab#cd" # comment', "B='x y'   # note", 'C="a\\"b" # escaped quote', 'D="a" # "b"'].join("\n"),
  );
  assert.equal(parsed.A, "ab#cd");
  assert.equal(parsed.B, "x y");
  assert.equal(parsed.C, 'a"b');
  assert.equal(parsed.D, "a");
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

test("SAP_ENV_FILE is exclusive — no silent fallback to another credentials file", () => {
  const previous = process.env.SAP_ENV_FILE;
  try {
    process.env.SAP_ENV_FILE = "/etc/sap-notes/prod.env";
    // Falling back to a different .env would log in with the wrong S-user.
    assert.deepEqual(envFileCandidates(), ["/etc/sap-notes/prod.env"]);

    delete process.env.SAP_ENV_FILE;
    const candidates = envFileCandidates();
    assert.equal(candidates.length, 2, "package root and cwd");
    assert.ok(candidates.every((path) => path.endsWith(".env")));
  } finally {
    if (previous === undefined) delete process.env.SAP_ENV_FILE;
    else process.env.SAP_ENV_FILE = previous;
  }
});

test("applyEnv records which keys came from the file", () => {
  const key = "SAP_TEST_ORIGIN";
  try {
    resetEnvKeysFromFile();
    delete process.env[key];
    applyEnv({ [key]: "from-file" });
    assert.ok(envKeysFromFile().has(key));

    resetEnvKeysFromFile();
    // Already set in the real environment: not applied, so not recorded either.
    applyEnv({ [key]: "ignored" });
    assert.equal(envKeysFromFile().has(key), false);
  } finally {
    resetEnvKeysFromFile();
    delete process.env[key];
  }
});

test("scrubPasswordFromEnv removes the password from process.env and the file-origin set", () => {
  const previous = { SAPPASSWORD: process.env.SAPPASSWORD, SAP_PASSWORD: process.env.SAP_PASSWORD };
  try {
    resetEnvKeysFromFile();
    delete process.env.SAPPASSWORD;
    delete process.env.SAP_PASSWORD;
    applyEnv({ SAPPASSWORD: "file-secret" });
    process.env.SAP_PASSWORD = "shell-secret";

    assert.deepEqual(scrubPasswordFromEnv(), ["SAPPASSWORD", "SAP_PASSWORD"]);
    // Neither spelling may survive: a child process (Chromium) must not inherit it.
    assert.equal(process.env.SAPPASSWORD, undefined);
    assert.equal(process.env.SAP_PASSWORD, undefined);
    assert.equal(envKeysFromFile().has("SAPPASSWORD"), false);
    // Idempotent: a second call finds nothing to remove.
    assert.deepEqual(scrubPasswordFromEnv(), []);
  } finally {
    resetEnvKeysFromFile();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("scrubCredentialsFromEnv also removes the S-user id", () => {
  const previous = {
    SAPUSER: process.env.SAPUSER,
    SAP_USERNAME: process.env.SAP_USERNAME,
    SAPPASSWORD: process.env.SAPPASSWORD,
  };
  try {
    resetEnvKeysFromFile();
    process.env.SAPUSER = "S0001234567";
    process.env.SAPPASSWORD = "secret";
    delete process.env.SAP_USERNAME;
    const removed = scrubCredentialsFromEnv();
    assert.ok(removed.includes("SAPPASSWORD"));
    assert.ok(removed.includes("SAPUSER"));
    assert.equal(process.env.SAPUSER, undefined);
    assert.equal(process.env.SAPPASSWORD, undefined);
  } finally {
    resetEnvKeysFromFile();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("inspectEnvFile accepts regular files and rejects directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sap-notes-env-"));
  try {
    assert.equal(inspectEnvFile(directory), "not-file");
    assert.equal(inspectEnvFile(join(directory, "missing.env")), "missing");
    assert.equal(inspectEnvFile(new URL(import.meta.url).pathname), "ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
