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
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { ensureLocalWorkerVars } from '../scripts/dev-vars.ts';
import { ensureLocalWorkerVars as checkPreparation } from '../scripts/check.ts';
import { startDevServer } from './support/dev-server.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/dev-vars-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test('explicit Worker-variable preparation is re-exported and preserves existing local bytes', () => {
  const directory = join(temporary, 'helper');
  mkdirSync(directory);
  const example = readFileSync(join(app, '.dev.vars.example'), 'utf8');
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

function sandbox(name: string): { checkout: string; directory: string } {
  const checkout = join(temporary, name);
  const directory = join(checkout, 'apps/web');
  mkdirSync(directory, { recursive: true });
  const excluded = new Set([
    'node_modules',
    '.cache',
    '.cloudflare',
    '.wrangler',
    '.tanstack',
    '.temp',
    'dist',
    '.output',
  ]);
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
    if (!name.startsWith('.vite')) symlinkSync(join(app, 'node_modules', name), join(directory, 'node_modules', name));
  }
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'));
  symlinkSync(join(root, 'packages'), join(checkout, 'packages'));
  cpSync(join(root, 'tsconfig.base.json'), join(checkout, 'tsconfig.base.json'));
  symlinkSync(join(root, 'scripts'), join(checkout, 'scripts'));
  return { checkout, directory };
}

async function runIsolated(checkout: string, args: string[]) {
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

test('isolated startup leaves shared Worker vars absent while an explicitly bound cold Worker renders without missing secrets', async () => {
  const { checkout, directory } = sandbox('worker');
  const varsPath = join(directory, '.dev.vars');
  expect(existsSync(varsPath)).toBe(false);

  const probe = await runIsolated(checkout, [
    'bun',
    '-e',
    "process.stdout.write(String(await Bun.file('.dev.vars').exists()))",
  ]);
  expect(probe.code, probe.output).toBe(0);
  expect(probe.stdout).toBe('false');
  expect(existsSync(varsPath)).toBe(false);

  const kernel = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ code: 'not_found' }, { status: 404 }),
  });
  const stateDirectory = mkdtempSync(join(tmpdir(), 'rezics-web-dev-vars-state-'));
  const serverLog = join(temporary, 'worker-startup.log');
  let devServer: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    const clientKeys = await generateKeyPair('ES256', { extractable: true });
    const clientKey = {
      ...(await exportJWK(clientKeys.privateKey)),
      alg: 'ES256',
      kid: 'dev-vars-private-fixture',
      use: 'sig',
    };
    devServer = await startDevServer({
      cwd: directory,
      warmUpPaths: ['/en'],
      budgets: { ready: 150_000, firstResponse: 60_000, warmUp: 60_000 },
      command: ({ port }) => [
        'sh',
        '-c',
        'bun run dev --host 127.0.0.1 --port "$1" --strictPort 2>&1 | tee "$2"',
        'sh',
        String(port),
        serverLog,
      ],
      env: {
        AUTH_ISSUER: 'http://127.0.0.1:3100/auth',
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'openid offline_access',
        WEBSITE_CLIENT_ID: 'rezics-web-test',
        WEBSITE_CLIENT_KEY: JSON.stringify(clientKey),
        PUBLIC_ORIGIN: 'https://rezics.com',
        SITE_ORIGINS: 'https://rezics.com',
        KERNEL_ORIGIN: kernel.url.origin,
        WEB_TEST_STATE_DIR: stateDirectory,
      },
    });

    const response = await fetch(`${devServer.origin}/en`, { redirect: 'manual' });
    const body = await response.text();
    const output = readFileSync(serverLog, 'utf8');
    expect(response.status).toBe(200);
    expect(body).not.toContain('Missing required secrets');
    expect(output).not.toContain('Missing required secrets');
    expect(existsSync(varsPath)).toBe(false);
  } finally {
    await devServer?.stop();
    await kernel.stop(true);
    rmSync(stateDirectory, { recursive: true, force: true });
  }
}, 240_000);
