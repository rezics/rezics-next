/** Run the selected VNDB journey on the worker-check host, using the real development composition. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { CrossMediaSeedResult } from '../../../services/importer/src/cross-media-seed.ts';

const root = resolve(import.meta.dir, '../../..');
const evidence = resolve(root, '.temp/vndb-journey');
const privateLogs = resolve(root, '.temp/local-stack/journey');
await mkdir(evidence, { recursive: true, mode: 0o700 });
await mkdir(privateLogs, { recursive: true, mode: 0o700 });
const suffix = crypto.randomUUID().slice(0, 8);
const env = {
  ...process.env,
  NODE_ENV: 'development',
  KERNEL_DATABASE_CONTAINER: `rezics-vndb-${suffix}`,
  KERNEL_DATABASE_VOLUME: `rezics-vndb-${suffix}`,
  KERNEL_DATABASE_PORT: '54329',
  KERNEL_SEARCH_CONTAINER: `rezics-vndb-search-${suffix}`,
  KERNEL_SEARCH_VOLUME: `rezics-vndb-search-${suffix}`,
  KERNEL_SEARCH_PORT: '59200',
  REZICS_DATASETS_DUMP_CACHE: resolve(root, '.temp/vndb-dumps'),
};
delete env.REZICS_TEST_RUNTIME;
const report: { phases: string[]; visits: unknown[]; error?: string } = { phases: [], visits: [] };
let password = '';

async function command(name: string, args: string[]) {
  console.log(`VNDB journey: ${name}`);
  const log = Bun.file(resolve(privateLogs, `${name}.log`));
  const child = Bun.spawn(args, { cwd: root, env, stdout: log, stderr: log });
  const code = await child.exited;
  if (code !== 0) {
    const output = (await log.text()).replaceAll(password || '\u0000', '[redacted]');
    throw new Error(`${name} exited ${code}\n${output.slice(-12000)}`);
  }
  report.phases.push(name);
}

async function ready(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Development stack exited ${child.exitCode} before ${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Development stack readiness timed out: ${url}`);
}

let stack: Bun.Subprocess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await command('database', ['bun', 'run', '--cwd', 'services/kernel', 'db', 'up']);
  await command('search', ['bun', 'run', '--cwd', 'services/kernel', 'search', 'up']);
  await command('setup', ['bun', 'services/auth/scripts/dev-stack.ts', 'setup']);
  await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
  const keys = JSON.parse(await readFile(resolve(root, '.temp/local-stack/keys.json'), 'utf8'));
  password = keys.password;
  const stackLog = Bun.file(resolve(privateLogs, 'stack.log'));
  stack = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
    cwd: root, env, stdout: stackLog, stderr: stackLog,
  });
  await ready('http://127.0.0.1:4200/.well-known/jwks.json', stack);
  await ready('http://127.0.0.1:3000/en', stack);
  report.phases.push('stack-ready');
  const seedEnv = Object.fromEntries(
    (await readFile(resolve(root, '.temp/local-stack/seed.env'), 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  // The complete composition may report an unavailable private list; catalogue reads remain independently testable.
  const seedLog = Bun.file(resolve(privateLogs, 'seed.log'));
  const seed = Bun.spawn(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], {
    cwd: root, env: { ...env, ...seedEnv }, stdout: seedLog, stderr: seedLog,
  });
  const seedCode = await seed.exited;
  if (!(await Bun.file(resolve(root, '.temp/cross-media-seed/result.json')).exists())) {
    throw new Error(`seed exited ${seedCode}\n${(await seedLog.text()).replaceAll(password, '[redacted]').slice(-12000)}`);
  }
  const result = JSON.parse(await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8')) as
    CrossMediaSeedResult & { showcase?: unknown; developmentShowcase?: unknown };
  await writeFile(resolve(evidence, 'publication.json'), JSON.stringify({
    showcase: result.showcase, developmentShowcase: result.developmentShowcase,
    personIdentities: result.personIdentities, gaps: result.gaps,
    vndbCreditDiagnostics: result.vndbCreditDiagnostics,
  }, null, 2), { mode: 0o600 });
  report.phases.push('seed-returned');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const key of ['v2002', 'v4']) {
    const selected = result.readings.find((row) => row.source === 'vndb' && row.externalId === key);
    assert(selected, `Missing selected VNDB ${key}`);
    assert.equal(selected.selection, 'selected', `${key} must be selected independently of proposals`);
    const url = `http://127.0.0.1:3000/en${selected.route}`;
    const response = await page.goto(url);
    assert.equal(response?.status(), 200);
    await page.screenshot({ path: resolve(evidence, `anonymous-${key}.png`), fullPage: true });
    const text = await page.locator('body').innerText();
    await writeFile(resolve(evidence, `anonymous-${key}.txt`), text, { mode: 0o600 });
    report.visits.push({ persona: 'anonymous', source: key, url: page.url(), subject: selected.subject });
    assert(text.includes('STEINS') || text.includes('Steins') || text.includes('CLANNAD'), `Missing work title at ${url}`);
  }
  await context.close();
  assert.equal(seedCode, 0, 'The complete seed must finish before the journey can pass');
} catch (error) {
  report.error = String(error).replaceAll(password || '\u0000', '[redacted]');
  throw error;
} finally {
  await writeFile(resolve(evidence, 'journey.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser?.close();
  if (stack) {
    stack.kill('SIGTERM');
    await stack.exited;
  }
}
