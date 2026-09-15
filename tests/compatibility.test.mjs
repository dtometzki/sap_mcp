import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, verifyIndependentProcesses } from './process-helpers.mjs';

test('legacy entrypoints preserve MCP stdio, Web assets and independent lifecycles from a foreign cwd', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'sap-compat-'));
  try {
    await verifyIndependentProcesses(join(root, 'dist/server.js'), join(root, 'dist/web/daemon.js'), directory, version);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cloud wrapper preserves the workspace start directory and the package starts independently', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'sap-cloud-compat-'));
  const bin = join(directory, 'bin');
  try {
    await mkdir(bin);
    // Stub npm only: exercise the real restore scripts with synthetic bytes.
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$PWD" > "$START_DIRECTORY"\n', { mode: 0o700 });
    const encoded = Buffer.from('synthetic vault bytes for restore test').toString('base64');
    const env = {
      PATH: `${bin}:${process.env.PATH}`, HOME: directory, TMPDIR: directory,
      SAP_WEB_DATA_DIR: join(directory, 'data'), START_DIRECTORY: join(directory, 'started'),
      SAP_WEB_VAULT_B64_1: encoded.slice(0, 8), SAP_WEB_VAULT_B64_2: encoded.slice(8, 16),
      SAP_WEB_VAULT_B64_3: encoded.slice(16, 24), SAP_WEB_VAULT_B64_4: encoded.slice(24),
    };
    for (const app of [root, join(root, 'packages/web')]) {
      await execute('bash', [join(app, 'scripts/cloud-web-start.sh')], { env, cwd: directory });
      assert.equal((await readFile(env.START_DIRECTORY, 'utf8')).trim(), await realpath(app));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
