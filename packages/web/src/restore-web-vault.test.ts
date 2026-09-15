import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/restore-web-vault.sh");
const payload = "vault-restore-test-bytes";
const encoded = Buffer.from(payload).toString("base64");
const parts = [
  encoded.slice(0, 8),
  encoded.slice(8, 16),
  encoded.slice(16, 24),
  encoded.slice(24),
];

function isolatedEnv(dataDir: string, vault?: [string, string, string, string]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SAP_WEB_DATA_DIR: dataDir,
  };
  if (vault) {
    env.SAP_WEB_VAULT_B64_1 = vault[0];
    env.SAP_WEB_VAULT_B64_2 = vault[1];
    env.SAP_WEB_VAULT_B64_3 = vault[2];
    env.SAP_WEB_VAULT_B64_4 = vault[3];
  }
  return env;
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

test("restore-web-vault writes vault.enc from four parts without printing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sap-vault-restore-"));
  try {
    const result = await run("bash", [script], { env: isolatedEnv(directory, parts as [string, string, string, string]) });
    const vaultPath = join(directory, "vault.enc");
    assert.equal(await readFile(vaultPath, "utf8"), payload);
    assert.equal((await stat(vaultPath)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const output = combinedOutput(result);
    assert.match(result.stdout, /SAP_WEB_VAULT_B64_1: present length=/);
    assert.match(result.stdout, /vault\.enc restored size=/);
    assert.ok(!output.includes(payload));
    for (const part of parts) {
      if (part.length > 0) assert.ok(!output.includes(part), "must not print vault part");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore-web-vault stops when any part is missing and does not ask for values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sap-vault-restore-"));
  try {
    await assert.rejects(
      () => run("bash", [script], { env: isolatedEnv(directory) }),
      (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        assert.equal(error.code, 1);
        const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        assert.match(output, /SAP_WEB_VAULT_B64_1: missing/);
        assert.match(output, /Cannot restore vault/);
        assert.ok(!output.includes(encoded));
        return true;
      },
    );
    await assert.rejects(stat(join(directory, "vault.enc")), { code: "ENOENT" });

    const partial = isolatedEnv(directory, parts as [string, string, string, string]);
    delete partial.SAP_WEB_VAULT_B64_3;
    await assert.rejects(
      () => run("bash", [script], { env: partial }),
      (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, /SAP_WEB_VAULT_B64_3: missing/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
