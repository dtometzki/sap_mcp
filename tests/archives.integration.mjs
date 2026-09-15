import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, verifyIndependentProcesses } from './process-helpers.mjs';

async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // npm executable shims are intentional internal links, not workspace dependencies.
    if (entry.name === '.bin') continue;
    assert.equal(entry.isSymbolicLink(), false, join(directory, entry.name));
    if (entry.isDirectory()) await assertNoLinks(join(directory, entry.name));
  }
}

test('download archives install without a workspace or the other application', { timeout: 240000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'sap-archives-'));
  const apps = {};
  try {
    for (const app of ['mcp', 'web']) {
      const archive = join(root, 'artifacts', `sap-notes-${app}-${version}.tar.gz`);
      const listing = (await execute('tar', ['-tzf', archive])).stdout;
      assert.doesNotMatch(listing, /(?:^|\/)(?:node_modules|\.git|src|vault\.enc|session\.json|\.env)(?:\/|\n|$)/m);
      assert.doesNotMatch(listing, /\.test\.|\.xlsx|PLAN-trennung/);
      await execute('tar', ['-xzf', archive, '-C', directory]);
      const appRoot = join(directory, `sap-notes-${app}-${version}`);
      apps[app] = appRoot;
      const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
      assert.match(manifest.dependencies['@sap-notes/core'], /^file:vendor\/.+\.tgz$/);
      assert.equal(manifest.workspaces, undefined);
      // Only this archive exists when MCP is first installed; Web never needs MCP either.
      await execute('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: appRoot, timeout: 120000 });
      await execute('npm', ['ls', '--omit=dev'], { cwd: appRoot });
      await execute('npm', ['audit', '--omit=dev', '--audit-level=high'], { cwd: appRoot, timeout: 60000 });
      await assertNoLinks(appRoot);
      const forbidden = app === 'mcp' ? 'markdown-it' : '@modelcontextprotocol/sdk';
      await assert.rejects(lstat(join(appRoot, 'node_modules', forbidden)), { code: 'ENOENT' });
      await assert.rejects(lstat(join(appRoot, 'node_modules/typescript')), { code: 'ENOENT' });
      await execute(process.execPath, ['--input-type=module', '--eval', 'import { chromium } from "playwright"; if (!chromium) process.exit(1);'], { cwd: appRoot });
    }
    const state = join(directory, 'state');
    await mkdir(state);
    await verifyIndependentProcesses(join(apps.mcp, 'dist/server.js'), join(apps.web, 'dist/daemon.js'), state, version);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
