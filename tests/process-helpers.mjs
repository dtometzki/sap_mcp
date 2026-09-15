import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
export function isolatedEnv(directory) {
  return { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, SAP_ENV_FILE: join(directory, '.env'), SAP_STATE_PATH: join(directory, 'missing-session.json'), SAP_AUTO_LOGIN: '0', SAP_WEB_DATA_DIR: join(directory, 'web-data') };
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function mcpProcess(entry, directory, env) {
  const child = spawn(process.execPath, [entry], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const errors = [];
  let nextId = 0;
  child.stderr.resume();
  function fail(error) {
    errors.push(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    } catch (error) { fail(error); }
  });
  child.on('error', fail);
  child.on('exit', () => { if (pending.size) fail(new Error('MCP exited while a request was pending')); });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10000);
    const finish = fn => value => { clearTimeout(timer); fn(value); };
    pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    errors, request,
    async initialize() {
      const info = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'split-test', version: '1.0.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return info;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    },
  };
}

/** No SAP connection: missing MCP session, locked Web vault, isolated directories. */
export async function verifyIndependentProcesses(mcpEntry, webDaemon, directory, version) {
  await writeFile(join(directory, '.env'), 'SAPUSER=fixture-user\nSAPPASSWORD=fixture-password\n', { mode: 0o600 });
  const env = { ...isolatedEnv(directory), SAP_WEB_PORT: String(await freePort()) };
  const mcp = mcpProcess(mcpEntry, directory, env);
  const daemon = command => execute(process.execPath, [webDaemon, command], { cwd: directory, env, timeout: 25000 });
  try {
    const info = await mcp.initialize();
    assert.equal(info.serverInfo.version, version);
    const tools = await mcp.request('tools/list');
    assert.equal(tools.tools.length, 5);
    assert.match((await daemon('start')).stdout, /gestartet/);
    const base = `http://127.0.0.1:${env.SAP_WEB_PORT}`;
    for (const [path, expected] of [['/', /<!doctype html>/i], ['/app.css', /body/], ['/app.js', /unlock-form/]]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(await response.text(), expected);
    }
    const about = await (await fetch(base + '/api/about')).json();
    assert.equal(about.version, version);
    assert.equal((await (await fetch(base + '/api/state')).json()).unlocked, false);
    const setup = await fetch(base + '/api/setup', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'archive fixture master password' }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    await setup.body.cancel();
    const state = await (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).json();
    assert.equal(state.unlocked, true);
    assert.equal(state.username, undefined, 'Web never imports MCP credentials from .env');
    const locked = await fetch(base + '/api/lock', {
      method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(locked.status, 200);
    await locked.body.cancel();
    assert.match((await daemon('status')).stdout, /läuft \(PID/);
    assert.match(JSON.stringify(await mcp.request('tools/call', { name: 'sap_session_status', arguments: {} })), /npm run login/);
    assert.match((await daemon('stop')).stdout, /beendet/);
    // Stopping Web cannot close the MCP transport.
    assert.equal((await mcp.request('tools/list')).tools.length, 5);
    await daemon('start');
    await mcp.close();
    // Closing MCP cannot stop Web.
    assert.equal((await fetch(base + '/api/about')).status, 200);
    assert.deepEqual(mcp.errors, []);
  } finally {
    await mcp.close();
    await daemon('stop').catch(async () => {
      try { process.kill(Number(await readFile(join(env.SAP_WEB_DATA_DIR, 'server.lock'), 'utf8')), 'SIGKILL'); } catch { /* already stopped */ }
    });
  }
}
