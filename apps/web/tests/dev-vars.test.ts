import { afterAll, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ensureLocalWorkerVars } from '../scripts/dev-vars.ts';
import { ensureLocalWorkerVars as checkPreparation } from '../scripts/check.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/dev-vars-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test('the shared preparation copies the example only when local Worker vars are absent', () => {
  const directory = join(temporary, 'helper');
  mkdirSync(directory);
  const example = 'WEBSITE_CLIENT_KEY=development-only\n';
  writeFileSync(join(directory, '.dev.vars.example'), example);
  expect(checkPreparation).toBe(ensureLocalWorkerVars);
  ensureLocalWorkerVars(directory);
  expect(readFileSync(join(directory, '.dev.vars'), 'utf8')).toBe(example);

  const existing = 'WEBSITE_CLIENT_KEY=keep-my-local-key\n';
  writeFileSync(join(directory, '.dev.vars'), existing);
  rmSync(join(directory, '.dev.vars.example'));
  ensureLocalWorkerVars(directory);
  expect(readFileSync(join(directory, '.dev.vars'), 'utf8')).toBe(existing);
});

function sandbox(name: string, fullApp = false) {
  const checkout = join(temporary, name);
  const directory = join(checkout, 'apps/web');
  mkdirSync(directory, { recursive: true });
  if (fullApp) {
    const excluded = new Set(['node_modules', '.cache', '.cloudflare', '.wrangler', '.tanstack', 'dist', '.output']);
    cpSync(app, directory, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return (
          !excluded.has(name) &&
          (!name.startsWith('.dev.vars') || name === '.dev.vars.example') &&
          !name.startsWith('.env')
        );
      },
    });
    mkdirSync(join(directory, 'node_modules'));
    for (const name of readdirSync(join(app, 'node_modules'))) {
      if (!name.startsWith('.vite'))
        symlinkSync(join(app, 'node_modules', name), join(directory, 'node_modules', name));
    }
    symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'));
    symlinkSync(join(root, 'packages'), join(checkout, 'packages'));
    cpSync(join(root, 'tsconfig.base.json'), join(checkout, 'tsconfig.base.json'));
  } else {
    cpSync(join(app, 'scripts'), join(directory, 'scripts'), { recursive: true });
    cpSync(join(app, '.dev.vars.example'), join(directory, '.dev.vars.example'));
  }
  symlinkSync(join(root, 'scripts'), join(checkout, 'scripts'));
  return { checkout, directory };
}

async function isolated(checkout: string, args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/isolated.ts', ...args], {
    cwd: join(checkout, 'apps/web'),
    env: { ...process.env, WEBSITE_CLIENT_KEY: undefined },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, output: `${stdout}\n${stderr}` };
}

test('isolated prepares Worker vars before any command and preserves existing bytes', async () => {
  const { checkout, directory } = sandbox('commands');
  const probe = ['bun', '-e', "process.stdout.write(await Bun.file('.dev.vars').text())"];
  const first = await isolated(checkout, probe);
  expect(first.code, first.output).toBe(0);
  expect(first.stdout).toBe(readFileSync(join(directory, '.dev.vars.example'), 'utf8'));
  const existing = 'WEBSITE_CLIENT_KEY=unchanged-local-value\n';
  writeFileSync(join(directory, '.dev.vars'), existing);
  const second = await isolated(checkout, probe);
  expect(second.code, second.output).toBe(0);
  expect(second.stdout).toBe(existing);
});

test('a test under isolated starts the real local Worker in a worktree without dev vars', async () => {
  const { checkout, directory } = sandbox('worker', true);
  expect(existsSync(join(directory, '.dev.vars'))).toBe(false);
  writeFileSync(
    join(directory, 'tests/local-worker.test.ts'),
    `
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

test('the default dev server receives local Worker configuration', async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const kernel = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json({ code: 'not_found' }, { status: 404 }) });
  const env = { ...process.env, KERNEL_ORIGIN: kernel.url.origin };
  for (const name of ['WEBSITE_CLIENT_KEY', 'AUTH_ISSUER', 'WEBSITE_CLIENT_ID', 'API_RESOURCE', 'WEBSITE_SCOPES', 'WORKER_INSPECTOR_PORT']) delete env[name];
  let output = '';
  const child = spawn('bun', ['--no-env-file', 'run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/en', { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        await response.text();
        if (response.status === 200) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error('Worker startup timed out:\\n' + output);
      await Bun.sleep(250);
    }
    expect(output).not.toContain('Missing required secrets');
  } finally {
    if (child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
    const stopped = await Promise.race([closed.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!stopped) { process.kill(-child.pid, 'SIGKILL'); await closed; }
    await kernel.stop(true);
    expect(stopped, output).toBe(true);
  }
}, 180_000);
`,
  );
  const result = await isolated(checkout, ['bun', 'test', './tests/local-worker.test.ts']);
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain('Missing required secrets');
  expect(readFileSync(join(directory, '.dev.vars'), 'utf8')).toBe(
    readFileSync(join(directory, '.dev.vars.example'), 'utf8'),
  );
}, 240_000);
