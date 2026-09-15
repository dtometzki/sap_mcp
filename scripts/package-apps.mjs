import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const rootPackage = await readJson(join(root, 'package.json'));
const workspaceLock = await readJson(join(root, 'package-lock.json'));
const output = join(root, 'artifacts');
const staging = await mkdtemp(join(tmpdir(), 'sap-notes-package-'));
const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// Pin direct registry dependencies to the versions tested in this checkout.
function runtimeManifest(manifest) {
  if (manifest.version !== rootPackage.version) throw new Error(`Version mismatch: ${manifest.name}`);
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, range]) => {
    if (name === '@sap-notes/core') return [name, range];
    const locked = workspaceLock.packages[`node_modules/${name}`];
    if (!locked?.version) throw new Error(`Missing dependency in workspace lock: ${name}`);
    return [name, locked.version];
  }));
  return { name: manifest.name, version: manifest.version, private: true, type: 'module', engines: manifest.engines, description: manifest.description, dependencies };
}

async function copyRuntime(app, target) {
  const source = join(root, 'packages', app);
  await mkdir(join(target, 'dist'), { recursive: true });
  // Allowlist runtime files; never copy a checkout, local config, tests or user data.
  for (const file of await readdir(join(source, 'dist'))) {
    if (!file.includes('.test.') && (file.endsWith('.js') || file.endsWith('.d.ts'))) {
      await cp(join(source, 'dist', file), join(target, 'dist', file));
    }
  }
  await cp(join(source, 'README.md'), join(target, 'README.md'));
  await cp(join(root, 'CHANGELOG.md'), join(target, 'CHANGELOG.md'));
}

try {
  await mkdir(output, { recursive: true });
  const coreDirectory = join(staging, 'core');
  const core = await readJson(join(root, 'packages/core/package.json'));
  await copyRuntime('core', coreDirectory);
  await writeFile(join(coreDirectory, 'package.json'), JSON.stringify({ ...runtimeManifest(core), exports: core.exports }, null, 2) + '\n');
  const packResult = JSON.parse(npm(['pack', '--json', '--ignore-scripts'], coreDirectory));
  // npm <=11 returns an array; npm 12 returns an object keyed by package name.
  const packed = Array.isArray(packResult) ? packResult[0] : packResult[core.name];
  if (packed?.filename !== `sap-notes-core-${rootPackage.version}.tgz`) throw new Error('Unexpected npm pack result');
  const coreTarball = join(coreDirectory, packed.filename);

  for (const app of ['mcp', 'web']) {
    const name = `sap-notes-${app}-${rootPackage.version}`;
    const directory = join(staging, name);
    const source = join(root, 'packages', app);
    await copyRuntime(app, directory);
    await cp(join(source, '.env.example'), join(directory, '.env.example'));
    await mkdir(join(directory, 'vendor'));
    await cp(coreTarball, join(directory, 'vendor', packed.filename));
    const manifest = runtimeManifest(await readJson(join(source, 'package.json')));
    manifest.dependencies['@sap-notes/core'] = `file:vendor/${packed.filename}`;
    manifest.scripts = app === 'mcp' ? {
      start: 'node dist/server.js', login: 'node dist/login.js',
      'test-search': 'node dist/test-search.js', 'diagnose-search': 'node dist/diagnose-search.js',
    } : {
      start: 'node dist/main.js', web: 'node dist/main.js',
      'web:start': 'node dist/daemon.js start', 'web:stop': 'node dist/daemon.js stop', 'web:status': 'node dist/daemon.js status',
      'web:restore-vault': 'bash scripts/restore-web-vault.sh', 'web:cloud-start': 'bash scripts/cloud-web-start.sh',
    };
    manifest.scripts['browser:install'] = 'playwright install chromium';
    if (app === 'web') {
      for (const file of ['index.html', 'app.css']) {
        await mkdir(join(directory, 'public'), { recursive: true });
        await cp(join(source, 'public', file), join(directory, 'public', file));
      }
      await mkdir(join(directory, 'scripts'));
      for (const file of ['restore-web-vault.sh', 'cloud-web-start.sh']) await cp(join(source, 'scripts', file), join(directory, 'scripts', file));
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
    const lock = await readJson(join(directory, 'package-lock.json'));
    if (Object.values(lock.packages).some(pkg => pkg.link)) throw new Error('Distribution contains workspace links');
    execFileSync('tar', ['-czf', join(output, `${name}.tar.gz`), '-C', staging, name]);
    console.log(`Created artifacts/${name}.tar.gz`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
