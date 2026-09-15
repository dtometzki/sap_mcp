import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = {
  'server.js': 'mcp/server.js',
  'login.js': 'mcp/login.js',
  'test-search.js': 'mcp/test-search.js',
  'diagnose-search.js': 'mcp/diagnose-search.js',
  'web/main.js': 'web/main.js',
  'web/daemon.js': 'web/daemon.js',
};
for (const [legacy, target] of Object.entries(entries)) {
  const prefix = legacy.startsWith('web/') ? '../../' : '../';
  const [app, file] = target.split('/');
  const output = join(root, 'dist', legacy);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `// Generated compatibility entrypoint. No output on the MCP protocol channel.
import { fileURLToPath } from 'node:url';
import { run } from '${prefix}packages/${app}/dist/${file}';
await run([fileURLToPath(new URL('${prefix}', import.meta.url)), process.cwd()]);
`);
}
