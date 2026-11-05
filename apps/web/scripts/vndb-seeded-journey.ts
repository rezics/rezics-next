/** Run the selected VNDB journey on the worker-check host, using the real development composition. */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../../services/importer/src/credentials.ts';
import { closeSync, openSync } from 'node:fs';
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
const reservations = Array.from({ length: 6 }, () => Bun.serve({
  hostname: '127.0.0.1', port: 0, fetch: () => new Response(),
}));
const [databasePort, searchPort, webPort, issuerPort, nativePort, kernelPort] = reservations.map((server) => server.port!);
const webOrigin = `http://127.0.0.1:${webPort}`;
const issuerOrigin = `http://127.0.0.1:${issuerPort}`;
const kernelOrigin = `http://127.0.0.1:${kernelPort}`;
for (const server of reservations) await server.stop(true);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  KERNEL_DATABASE_CONTAINER: `rezics-vndb-${suffix}`,
  KERNEL_DATABASE_VOLUME: `rezics-vndb-${suffix}`,
  KERNEL_DATABASE_PORT: String(databasePort),
  KERNEL_SEARCH_CONTAINER: `rezics-vndb-search-${suffix}`,
  KERNEL_SEARCH_VOLUME: `rezics-vndb-search-${suffix}`,
  KERNEL_SEARCH_PORT: String(searchPort),
  REZICS_LOCAL_STACK_WEB_ORIGIN: webOrigin,
  REZICS_LOCAL_STACK_ISSUER_ORIGIN: issuerOrigin,
  REZICS_LOCAL_STACK_NATIVE_ORIGIN: `http://127.0.0.1:${nativePort}`,
  REZICS_LOCAL_STACK_KERNEL_ORIGIN: kernelOrigin,
  REZICS_DATASETS_DUMP_CACHE: resolve(root, '.temp/vndb-dumps'),
};
delete env.REZICS_TEST_RUNTIME;
const report: { phases: string[]; visits: unknown[]; error?: string } = { phases: [], visits: [] };
let password = '';

async function command(name: string, args: string[]) {
  console.log(`VNDB journey: ${name}`);
  const log = Bun.file(resolve(privateLogs, `${name}.log`));
  const descriptor = openSync(log.name!, 'a', 0o600);
  const child = Bun.spawn(args, { cwd: root, env, stdout: descriptor, stderr: descriptor });
  const code = await child.exited;
  closeSync(descriptor);
  if (code !== 0) {
    const output = (await log.text()).replaceAll(password || '\u0000', '[redacted]');
    throw new Error(`${name} exited ${code}\n${output.slice(-12000)}`);
  }
  report.phases.push(name);
}

async function ready(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 180_000;
  let lastFailure = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Development stack exited ${child.exitCode} before ${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}\n${(await response.text()).slice(0, 16000)}`;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
      lastFailure = String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Development stack readiness timed out: ${url}\n${lastFailure}`);
}

let stack: Bun.Subprocess | undefined;
let stackDescriptor: number | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await command('reviewed-catalogue-test', ['bun', 'test', 'services/importer/tests/reviewed-catalogue-preflight.test.ts']);
  await command('database', ['bun', 'run', '--cwd', 'services/kernel', 'db', 'up']);
  await command('search', ['bun', 'run', '--cwd', 'services/kernel', 'search', 'up']);
  const kernelEnvFile = resolve(root, 'services/kernel/.env');
  await writeFile(kernelEnvFile, (await readFile(kernelEnvFile, 'utf8'))
    .replace(/^AUTH_ISSUER=.*$/m, `AUTH_ISSUER=${issuerOrigin}`)
    .replace(/^AUTH_JWKS_URL=.*$/m, `AUTH_JWKS_URL=${issuerOrigin}/.well-known/jwks.json`), { mode: 0o600 });
  await command('setup', ['bun', 'services/auth/scripts/dev-stack.ts', 'setup']);
  await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
  const keys = JSON.parse(await readFile(resolve(root, '.temp/local-stack/keys.json'), 'utf8'));
  password = keys.password;
  const stackLog = Bun.file(resolve(privateLogs, 'stack.log'));
  stackDescriptor = openSync(stackLog.name!, 'a', 0o600);
  stack = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
    cwd: root, env, stdout: stackDescriptor, stderr: stackDescriptor,
  });
  await ready(`${issuerOrigin}/.well-known/jwks.json`, stack);
  report.phases.push('auth-ready');
  const seedEnv = Object.fromEntries(
    (await readFile(resolve(root, '.temp/local-stack/seed.env'), 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  const reviewerToken = await createAccountTokenProvider({
    accountKeyPath: seedEnv.REZICS_DEV_PERSONA_ACCOUNT_KEY!,
    account: seedEnv.REZICS_DEV_PERSONA_ACCOUNT!, client: seedEnv.REZICS_DEV_PERSONA_CLIENT!,
    authOrigin: issuerOrigin, scopes: [...IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt'],
  });
  const reviewerBearer = await reviewerToken();
  const claims = JSON.parse(Buffer.from(reviewerBearer.split('.')[1]!, 'base64url').toString());
  await writeFile(resolve(evidence, 'reviewer-scope.json'), JSON.stringify({ scope: claims.scope }), { mode: 0o600 });
  // The complete composition may report an unavailable private list; catalogue reads remain independently testable.
  const seedLog = Bun.file(resolve(privateLogs, 'seed.log'));
  const seedDescriptor = openSync(seedLog.name!, 'a', 0o600);
  const seed = Bun.spawn(['bun', '--eval', 'await (await import("./scripts/datasets/cross-media-seed.ts")).runDevelopmentSeed()'], {
    cwd: root, env: { ...env, ...seedEnv }, stdout: seedDescriptor, stderr: seedDescriptor,
  });
  const seedCode = await seed.exited;
  closeSync(seedDescriptor);
  if (!(await Bun.file(resolve(root, '.temp/cross-media-seed/result.json')).exists())) {
    const database = new Database(resolve(root, '.temp/cross-media-seed/state.sqlite'), { readonly: true });
    const subjects = database.query('SELECT source, external_id, subject FROM binding_records WHERE subject IS NOT NULL').all() as
      { source: string; external_id: string; subject: string }[];
    database.close();
    const readings = [];
    for (const subject of subjects) {
      const response = await fetch(`${kernelOrigin}/v1/subjects/${subject.subject}?includeViewerActions=true`, {
        headers: { authorization: `Bearer ${reviewerBearer}` },
      });
      readings.push({ ...subject, status: response.status, reading: await response.json() });
    }
    await writeFile(resolve(evidence, 'reviewed-bootstrap-readings.json'), JSON.stringify(readings), { mode: 0o600 });
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
  await ready(`${webOrigin}/en`, stack);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const key of ['v2002', 'v4']) {
    const selected = result.readings.find((row) => row.source === 'vndb' && row.externalId === key);
    assert(selected, `Missing selected VNDB ${key}`);
    assert.equal(selected.selection, 'selected', `${key} must be selected independently of proposals`);
    const url = `${webOrigin}/en${selected.route}`;
    const response = await page.goto(url);
    assert.equal(response?.status(), 200);
    await page.screenshot({ path: resolve(evidence, `anonymous-${key}.png`), fullPage: true });
    const text = await page.locator('body').innerText();
    await writeFile(resolve(evidence, `anonymous-${key}.txt`), text, { mode: 0o600 });
    report.visits.push({ persona: 'anonymous', source: key, url: page.url(), subject: selected.subject });
    assert(text.includes('STEINS') || text.includes('Steins') || text.includes('CLANNAD'), `Missing work title at ${url}`);
  }
  await context.close();
  report.phases.push('anonymous-work-pages');
} catch (error) {
  report.error = String(error).replaceAll(password || '\u0000', '[redacted]');
  if (await Bun.file(resolve(privateLogs, 'stack.log')).exists()) {
    await writeFile(resolve(evidence, 'stack.log'),
      (await readFile(resolve(privateLogs, 'stack.log'), 'utf8')).replaceAll(password || '\u0000', '[redacted]'),
      { mode: 0o600 });
  }
  throw error;
} finally {
  await writeFile(resolve(evidence, 'journey.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await browser?.close();
  if (stack) {
    stack.kill('SIGTERM');
    await stack.exited;
  }
  if (stackDescriptor !== undefined) closeSync(stackDescriptor);
}
