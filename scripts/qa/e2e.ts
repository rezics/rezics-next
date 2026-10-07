import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isLocalQaRun, qaMemoryDeadline, qaMemoryNeed, waitForMemory } from './memory-admission.ts';
import { discoverJourneyPreparations, selectJourneyPreparations } from './e2e-preparation.ts';

const claimRoot = join(tmpdir(), 'rezics-e2e-web-ports');

export interface BrowserStepResult {
  step: string; budgetMs: number; elapsedMs: number; passed: boolean; admissionWaitMs?: number; error?: string; skipped?: string;
}
export interface BrowserStepOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  deadline: number;
  now?: () => number;
  admission?: typeof waitForMemory;
  record?: (result: BrowserStepResult) => void;
}

/** Admission has the run deadline; the step keeps its full execution budget once admitted. */
export async function measuredBrowserStep(step: string, budgetMs: number, run: (budgetMs: number) => Promise<void>,
  options: BrowserStepOptions): Promise<BrowserStepResult> {
  const now = options.now ?? Date.now;
  const result: BrowserStepResult = { step, budgetMs, elapsedMs: 0, admissionWaitMs: 0, passed: false };
  let started: number | undefined;
  try {
    if (await isLocalQaRun(options.root, options.env)) {
      await (options.admission ?? waitForMemory)(qaMemoryNeed(options.root, 'browser', undefined, options.env), {
        root: options.root, env: options.env, deadline: options.deadline, now,
        onAdmissionWait: ms => { result.admissionWaitMs = (result.admissionWaitMs ?? 0) + ms; },
      });
    }
    started = now();
    await run(budgetMs);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    result.elapsedMs = started === undefined ? 0 : now() - started;
    options.record?.(result);
  }
  return result;
}

export interface WebPortReservation { port: number; pid: number; release(): void }

export function webOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function claimDirectory(port: number): string {
  return join(claimRoot, String(port));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function claimPid(port: number): number | undefined {
  const path = join(claimDirectory(port), 'pid');
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8'));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function writeClaimPid(port: number, pid: number): void {
  const path = join(claimDirectory(port), 'pid');
  const next = `${path}.next`;
  writeFileSync(next, String(pid), { mode: 0o600 });
  renameSync(next, path);
}

function holderCommand(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/cmdline`).includes('REZICS_WEB_PORT_FILE'); }
  catch { return false; }
}

function stopHolder(pid: number): void {
  if (!holderCommand(pid)) return;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

function tryClaim(port: number, pid: number): boolean {
  const dir = claimDirectory(port);
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = claimPid(port);
    if (owner !== undefined && pidAlive(owner)) return false;
    rmSync(dir, { recursive: true, force: true });
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch { return false; }
  }
  writeClaimPid(port, pid);
  return claimPid(port) === pid;
}

const holderSource = [
  "import { createServer } from 'node:net';",
  "import { writeFileSync } from 'node:fs';",
  'const file = process.env.REZICS_WEB_PORT_FILE;',
  'if (!file) process.exit(1);',
  'const server = createServer();',
  "server.once('error', () => process.exit(1));",
  "server.listen(0, '127.0.0.1', () => {",
  '  const address = server.address();',
  "  if (!address || typeof address === 'string') process.exit(1);",
  '  writeFileSync(file, String(address.port));',
  '});',
  "process.stdin.resume();",
  "process.stdin.on('end', () => process.exit(0));",
  "process.on('SIGTERM', () => process.exit(0));",
  "process.on('SIGINT', () => process.exit(0));",
].join('\n');

async function startHolder(): Promise<{ port: number; pid: number; directory: string; child: ChildProcess }> {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-web-port-'));
  const portFile = join(directory, 'port');
  const child = spawn(process.execPath, ['-e', holderSource], {
    env: { ...process.env, REZICS_WEB_PORT_FILE: portFile },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.once('error', () => { /* The wait below reports a holder that never writes a port. */ });
  const pid = child.pid;
  if (!pid) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('Could not start a web port holder');
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`Web port holder exited (${child.exitCode})`);
    }
    if (existsSync(portFile)) {
      const text = readFileSync(portFile, 'utf8').trim();
      if (!/^\d+$/.test(text)) {
        await new Promise(resolveWait => setTimeout(resolveWait, 20));
        continue;
      }
      const port = Number(text);
      if (port < 1 || port > 65535) {
        child.kill('SIGTERM');
        rmSync(directory, { recursive: true, force: true });
        throw new Error('Web port holder reported an invalid port');
      }
      return { port, pid, directory, child };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  child.kill('SIGTERM');
  rmSync(directory, { recursive: true, force: true });
  throw new Error('Web port holder did not report a port');
}

/** Bind a free loopback port and keep it until `release`. A second call in the
 * same process, or another e2e run, gets a different port. */
export async function allocateWebPort(): Promise<WebPortReservation> {
  mkdirSync(claimRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 30; attempt++) {
    const started = await startHolder();
    if (!tryClaim(started.port, started.pid)) {
      started.child.stdin?.end();
      started.child.kill('SIGTERM');
      rmSync(started.directory, { recursive: true, force: true });
      continue;
    }
    let released = false;
    return {
      port: started.port,
      pid: started.pid,
      release() {
        if (released) return;
        released = true;
        started.child.stdin?.end();
        stopHolder(started.pid);
        const owner = claimPid(started.port);
        if (owner === undefined || owner === started.pid || !pidAlive(owner)) {
          rmSync(claimDirectory(started.port), { recursive: true, force: true });
        }
        rmSync(started.directory, { recursive: true, force: true });
      },
    };
  }
  throw new Error('Could not allocate a free web port');
}

/** The e2e process owns the claim while the holder keeps the socket through the web build. */
export function adoptWebPort(port: number, holderPid: number): void {
  if (claimPid(port) !== holderPid) throw new Error(`Web port ${port} is not reserved by holder ${holderPid}`);
  writeClaimPid(port, process.pid);
}

function bindAndClose(port: number): Promise<void> {
  const server = createServer();
  return new Promise((resolveBind, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.close(error => error ? reject(error) : resolveBind());
    });
  });
}

/** Drop the reservation socket so the web worker can listen on the same port. */
export async function releaseHeldWebPort(holderPid: number, port: number): Promise<void> {
  stopHolder(holderPid);
  const deadline = Date.now() + 5_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await bindAndClose(port); return; }
    catch (error) { last = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(`Web port ${port} stayed occupied after its holder exited (${detail})`);
}

function releaseOwnedClaim(port: number): void {
  if (claimPid(port) === process.pid) rmSync(claimDirectory(port), { recursive: true, force: true });
}

function requiredWebOrigin(): { origin: string; port: number; holderPid: number } {
  const origin = process.env.REZICS_WEB_E2E_BASE_URL;
  const holderPid = Number(process.env.REZICS_WEB_E2E_PORT_HOLDER);
  if (!origin || !Number.isInteger(holderPid) || holderPid <= 0) {
    throw new Error('e2e requires REZICS_WEB_E2E_BASE_URL and REZICS_WEB_E2E_PORT_HOLDER from the QA runner');
  }
  const url = new URL(origin);
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port)
    || String(port) !== url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('REZICS_WEB_E2E_BASE_URL must be an http://127.0.0.1:<port> origin');
  }
  return { origin: url.origin, port, holderPid };
}

async function runE2e(): Promise<void> {
  const { Pool } = await import('pg');
  const { initializeRelayCheckpoint } = await import('../../services/main/src/modules/outbox/relay.ts');
  const { readEnv } = await import('../dev/config.ts');
  const { browserBudgets, browserFileCounts, browserProjectCount, e2eBrowserPlan, storybookCommands } = await import('./browser-budget.ts');
  const root = resolve(import.meta.dir, '../..');
  const rawArgs = process.argv.slice(2);
  const storybookRequested = rawArgs.includes('--storybook') || process.env.REZICS_E2E_STORYBOOK === '1';
  const [appsPath, artifactDir, runId, ...playwrightArgs] = rawArgs.filter(arg => arg !== '--storybook');
  if (!appsPath || !artifactDir || !runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) {
    throw new Error('e2e requires an apps file, artifact directory and isolated run ID');
  }
  const web = requiredWebOrigin();
  const apps = JSON.parse(readFileSync(appsPath, 'utf8')) as Record<string, string>;
  const plan = e2eBrowserPlan(playwrightArgs, storybookRequested);
  const counts = browserFileCounts(root, playwrightArgs);
  const budgets = browserBudgets(counts.playwright, counts.storybook, browserProjectCount(), {
    playwright: plan.accountsJourneys ? counts.accountsPlaywright : 0,
    stories: plan.stories ? counts.accountsStories : 0,
  });
  writeFileSync(join(artifactDir, 'e2e-browser-plan.json'), JSON.stringify(plan, null, 2));
  if (!plan.stories) console.log(`Storybook: skipped (${plan.storySkipReason})`);
  const authDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'web-auth');
  const runtime = readEnv(join(authDir, 'runtime.env'));
  const publicConfig = JSON.parse(readFileSync(join(authDir, 'public.json'), 'utf8')) as { clientId: string };
  // Journeys that verify an email read this stack's Mailpit, not the shared dev stack's.
  const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
  const env: NodeJS.ProcessEnv = { ...process.env, ...apps, ...runtime, WEB_OAUTH_CLIENT_ID: publicConfig.clientId,
    ...(compose.MAILPIT_HTTP_PORT ? { MAILPIT_URL: `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}` } : {}),
    REZICS_QA_RUN_ID: runId,
    REZICS_WEB_AUTH_PUBLIC_PATH: join(authDir, 'public.json'),
    REZICS_WEB_AUTH_PRIVATE_PATH: join(authDir, 'private.json'),
    REZICS_WEB_E2E_BASE_URL: web.origin,
    REZICS_WEB_E2E_PORT_HOLDER: String(web.holderPid) };
  const children: ChildProcess[] = [];
  const launchErrors = new WeakMap<ChildProcess, Error>();
  const runDeadline = qaMemoryDeadline(env);
  const steps: BrowserStepResult[] = [];
  let ownedPort: number | undefined;

  async function measured(step: string, budgetMs: number, run: () => Promise<void>): Promise<void> {
    console.log(`${step}: ${budgetMs / 1000}s budget`);
    await measuredBrowserStep(step, budgetMs, run, { root, env, deadline: runDeadline, record: result => {
      steps.push(result);
      writeFileSync(join(artifactDir, 'e2e-steps.json'), JSON.stringify(steps, null, 2));
    } });
  }

  function launch(name: string, program: string, args: string[], extraEnv: NodeJS.ProcessEnv = {},
    workdir = root): ChildProcess {
    const log = openSync(join(artifactDir, 'logs', `e2e-${name}.log`), 'w', 0o600);
    try {
      const child = spawn(program, args, { cwd: workdir, env: { ...env, ...extraEnv },
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

  async function ready(name: string, url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'no response';
    while (Date.now() < deadline) {
      const launchError = launchErrors.get(child);
      if (launchError) throw new Error(`${name} could not start: ${launchError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${name} exited before readiness (code ${child.exitCode}, signal ${child.signalCode})`);
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))) });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
        await response.body?.cancel();
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
      await new Promise(resolveWait => setTimeout(resolveWait, 400));
    }
    throw new Error(`${name} did not become ready at ${url} within ${timeoutMs / 1000}s (${last})`);
  }

  async function completed(name: string, child: ChildProcess, timeoutMs: number): Promise<number> {
    return await new Promise<number>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        stop(child);
        reject(new Error(`${name} exceeded its ${timeoutMs / 1000}s budget`));
      }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`${name} ended with ${signal}`));
        else resolveExit(code ?? 1);
      });
    });
  }

  try {
    adoptWebPort(web.port, web.holderPid);
    ownedPort = web.port;
    console.log(`Web origin: ${web.origin}`);
    const preparations = selectJourneyPreparations(await discoverJourneyPreparations(root), playwrightArgs);
    await measured('Application setup', budgets.setup, async () => {
      if (!env.MAIN_RELAY_DATABASE_URL || !env.MAIN_RELAY_CONSUMER || !env.MAIN_DATA_EPOCH) {
        throw new Error('The e2e stack needs a Main relay checkpoint');
      }
      const relay = new Pool({ connectionString: env.MAIN_RELAY_DATABASE_URL });
      try { await initializeRelayCheckpoint(relay, env.MAIN_RELAY_CONSUMER, env.MAIN_DATA_EPOCH); }
      finally { await relay.end(); }
      const account = launch('account', 'bun', ['services/account/src/index.ts']);
      await ready('Account', `http://127.0.0.1:${apps.ACCOUNT_PORT}/health/ready`, account, 30_000);
      if (!apps.ACCOUNTS_PORT) throw new Error('The e2e stack has no public Accounts origin');
      const accounts = launch('accounts', 'bun', ['scripts/dev/accounts-preview.ts', '--profile', 'qa', '--run-id', runId], {
        REZICS_WEB_E2E_BASE_URL: web.origin,
      });
      await ready('Accounts', `http://127.0.0.1:${apps.ACCOUNTS_PORT}/sign-in`, accounts, 240_000);
      if (!env.PLATFORM_FIRST_ADMIN_ACCOUNT) {
        throw new Error('The e2e stack has no first platform administrator');
      }
      const main = launch('main', 'bun', ['services/main/src/index.ts']);
      await ready('Main', `http://127.0.0.1:${apps.MAIN_PORT}/health/ready`, main, 30_000);
      const preview = launch('preview', 'bun', ['scripts/dev/web-preview.ts', '--profile', 'qa', '--run-id', runId]);
      await ready('Web Worker', `${web.origin}/search`, preview, 240_000);
    });
    for (const preparation of preparations) {
      await measured(preparation.step, preparation.budgetMs, async () => {
        const [program, ...commandArgs] = preparation.command;
        const child = launch(preparation.slug, program, commandArgs);
        const code = await completed(preparation.step, child, preparation.budgetMs);
        if (code !== 0) throw new Error(`${preparation.step} failed (${code}); see logs/e2e-${preparation.slug}.log`);
      });
    }
    await measured('Playwright', budgets.playwright, async () => {
      const browser = launch('playwright', 'node_modules/.bin/playwright', ['test', '--config', 'apps/web/playwright.config.ts', ...playwrightArgs,
        '--reporter=junit', '--output', join(artifactDir, 'playwright')], {
        PLAYWRIGHT_JUNIT_OUTPUT_FILE: join(artifactDir, 'e2e.xml'),
        REZICS_WEB_E2E_BASE_URL: web.origin,
      });
      const code = await completed('Playwright', browser, budgets.playwright);
      if (code !== 0) throw new Error(`Playwright failed (${code}); see logs/e2e-playwright.log`);
    });
    if (plan.accountsJourneys) {
      await measured('Accounts Playwright', budgets.accountsPlaywright, async () => {
        const browser = launch('accounts-playwright', 'node_modules/.bin/playwright', ['test', '--config', 'apps/accounts/playwright.config.ts',
          '--reporter=junit', '--output', join(artifactDir, 'accounts-playwright')], {
          PLAYWRIGHT_JUNIT_OUTPUT_FILE: join(artifactDir, 'accounts-e2e.xml'),
          ACCOUNTS_URL: `http://127.0.0.1:${apps.ACCOUNTS_PORT}`,
          WEB_URL: web.origin,
        });
        const code = await completed('Accounts Playwright', browser, budgets.accountsPlaywright);
        if (code !== 0) throw new Error(`Accounts Playwright failed (${code}); see logs/e2e-accounts-playwright.log`);
      });
    } else {
      console.log('Accounts journeys: skipped (selected journey files; a full e2e tier runs them)');
    }
    console.log('Built Workers, Main, Account and Playwright completed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    stopAll();
    if (ownedPort !== undefined) releaseOwnedClaim(ownedPort);
  }

  // The browser suite has finished using the services. Release them before
  // Storybook and give each workspace its own deadline, even if Playwright failed.
  // A selected journey file skips both suites and records that in the run summary.
  const storySteps = storybookCommands(plan);
  if (!storySteps.length) {
    const reason = plan.storySkipReason ?? 'not a full e2e tier';
    console.log(`Storybook: skipped (${reason})`);
    steps.push({ step: 'Storybook', budgetMs: 0, elapsedMs: 0, passed: true, skipped: reason });
    writeFileSync(join(artifactDir, 'e2e-steps.json'), JSON.stringify(steps, null, 2));
  }
  try {
    for (const story of storySteps) {
      const label = story.root === 'apps/accounts' ? 'Accounts Storybook' : 'Storybook';
      const budgetMs = story.root === 'apps/accounts' ? budgets.accountsStorybook : budgets.storybook;
      await measured(label, budgetMs, async () => {
        const stories = launch(story.name, 'node_modules/.bin/vitest',
          ['run', '--root', story.root, '--project', 'storybook'],
          { STORYBOOK_MAX_WORKERS: process.env.STORYBOOK_MAX_WORKERS ?? '2' });
        const code = await completed(label, stories, budgetMs);
        if (code !== 0) throw new Error(`${label} failed (${code}); see logs/e2e-${story.name}.log`);
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally { stopAll(); }
}

if (import.meta.main) await runE2e();
