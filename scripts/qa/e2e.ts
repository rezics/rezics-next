import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const [appsPath, artifactDir, runId, ...playwrightArgs] = process.argv.slice(2);
if (!appsPath || !artifactDir || !runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) {
  throw new Error('e2e requires an apps file, artifact directory and isolated run ID');
}
const apps = JSON.parse(readFileSync(appsPath, 'utf8')) as Record<string, string>;
const authDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'web-auth');
const runtime = Object.fromEntries(readFileSync(join(authDir, 'runtime.env'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(line => {
    const at = line.indexOf('=');
    if (at < 1) throw new Error('Invalid web authorization runtime environment');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
const publicConfig = JSON.parse(readFileSync(join(authDir, 'public.json'), 'utf8')) as { clientId: string };
const env = { ...process.env, ...apps, ...runtime, WEB_OAUTH_CLIENT_ID: publicConfig.clientId,
  REZICS_WEB_AUTH_PUBLIC_PATH: join(authDir, 'public.json'),
  REZICS_WEB_AUTH_PRIVATE_PATH: join(authDir, 'private.json') };
const children: ChildProcess[] = [];
const launchErrors = new WeakMap<ChildProcess, Error>();

function launch(name: string, program: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const log = openSync(join(artifactDir, 'logs', `e2e-${name}.log`), 'w', 0o600);
  try {
    const child = spawn(program, args, { cwd: root, env: { ...env, ...extraEnv },
      detached: true, stdio: ['ignore', log, log] });
    child.on('error', error => launchErrors.set(child, error));
    children.push(child);
    return child;
  } finally { closeSync(log); }
}

function stop(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { child.kill('SIGTERM'); }
}

function stopAll(): void { for (const child of children.slice().reverse()) stop(child); }
process.once('SIGINT', () => { stopAll(); process.exit(130); });
process.once('SIGTERM', () => { stopAll(); process.exit(143); });

async function assertPortAvailable(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
  } catch {
    throw new Error(`Web preview port ${port} is already occupied; e2e cannot use another server`);
  } finally { if (server.listening) server.close(); }
}

async function ready(name: string, url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const launchError = launchErrors.get(child);
    if (launchError) throw new Error(`${name} could not start: ${launchError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} exited before readiness (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch { /* startup may still be in progress */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 400));
  }
  throw new Error(`${name} did not become ready at ${url} within ${timeoutMs / 1000}s`);
}

async function completed(child: ChildProcess, timeoutMs: number): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      stop(child);
      reject(new Error(`Playwright exceeded its ${timeoutMs / 1000}s budget`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`Playwright ended with ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
}

try {
  await assertPortAvailable(3003);
  const account = launch('account', 'bun', ['services/account/src/index.ts']);
  await ready('Account', `http://127.0.0.1:${apps.ACCOUNT_PORT}/health/ready`, account, 30_000);
  const main = launch('main', 'bun', ['services/main/src/index.ts']);
  await ready('Main', `http://127.0.0.1:${apps.MAIN_PORT}/health/ready`, main, 30_000);
  const preview = launch('preview', 'corepack', ['yarn', 'web:preview', '--profile', 'qa', '--run-id', runId]);
  await ready('Web Worker', 'http://127.0.0.1:3003/search', preview, 240_000);
  const browser = launch('playwright', 'corepack', ['yarn', 'web:e2e', ...playwrightArgs,
    '--reporter=junit', '--output', join(artifactDir, 'playwright')], {
    PLAYWRIGHT_JUNIT_OUTPUT_FILE: join(artifactDir, 'e2e.xml'),
  });
  const code = await completed(browser, 180_000);
  if (code !== 0) throw new Error(`Playwright failed (${code}); see logs/e2e-playwright.log`);
  console.log('Built Worker, Main, Account and Playwright completed');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stopAll();
}
