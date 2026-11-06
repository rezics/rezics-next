/** Seeded ratings/reviews walk from apps/web so root Bun preloads cannot redirect it. */
import { resolve } from 'node:path';

const webRoot = resolve(import.meta.dir, '..');
const root = resolve(webRoot, '../..');

/** Standard question and Global population from `src/features/pages/subject-ratings.ts`. */
const INSTALLED_QUESTION = '00000000-0000-7000-8000-000000000001';
const INSTALLED_POPULATION = '00000000-0000-8000-8000-000000000000';

export function walkWorkingDirectory(): string {
  return webRoot;
}

/** Installed Subject page types: the standard question and Global population. */
export function installedRatingsPage(questionId = INSTALLED_QUESTION): { questionId: string; population: string } {
  return { questionId, population: INSTALLED_POPULATION };
}

async function run(): Promise<void> {
  if (process.cwd() !== webRoot) {
    const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
      cwd: webRoot,
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    process.exit(await child.exited);
  }
  const assert = (await import('node:assert/strict')).default;
  const { closeSync, openSync } = await import('node:fs');
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { chromium } = await import('playwright');
  const { retireStaleSeedJournals } = await import('../../../services/auth/scripts/dev-stack.ts');
  const { firstRedactedDiagnostic, isStartupTransportError, kernelLaunchCommand, nativeJwksUrl } =
    await import('../../../scripts/walk-stack.ts');
  const { GLOBAL, QUESTION } = await import('../src/features/pages/subject-ratings.ts');
  const pageTypes = installedRatingsPage();
  assert.equal(pageTypes.questionId, QUESTION);
  assert.equal(pageTypes.population, GLOBAL);

  const evidence = resolve(root, '.temp/ratings-reviews-walk');
  const privateLogs = resolve(root, '.temp/local-stack/ratings-walk');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await mkdir(privateLogs, { recursive: true, mode: 0o700 });
  const suffix = crypto.randomUUID().slice(0, 8);
  const reservations = Array.from({ length: 6 }, () =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(),
    }),
  );
  const [databasePort, searchPort, webPort, issuerPort, nativePort, kernelPort] = reservations.map(
    (server) => server.port!,
  );
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const issuerOrigin = `http://127.0.0.1:${issuerPort}`;
  const nativeOrigin = `http://127.0.0.1:${nativePort}`;
  const kernelOrigin = `http://127.0.0.1:${kernelPort}`;
  for (const server of reservations) await server.stop(true);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    KERNEL_DATABASE_CONTAINER: `rezics-ratings-${suffix}`,
    KERNEL_DATABASE_VOLUME: `rezics-ratings-${suffix}`,
    KERNEL_DATABASE_PORT: String(databasePort),
    KERNEL_SEARCH_CONTAINER: `rezics-ratings-search-${suffix}`,
    KERNEL_SEARCH_VOLUME: `rezics-ratings-search-${suffix}`,
    KERNEL_SEARCH_PORT: String(searchPort),
    REZICS_LOCAL_STACK_WEB_ORIGIN: webOrigin,
    REZICS_LOCAL_STACK_ISSUER_ORIGIN: issuerOrigin,
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: nativeOrigin,
    REZICS_LOCAL_STACK_KERNEL_ORIGIN: kernelOrigin,
    REZICS_WALK_STACK_SLOT: process.env.REZICS_WALK_STACK_SLOT ?? 'ratings',
  };
  delete env.REZICS_TEST_RUNTIME;

  const report: { phases: string[]; visits: unknown[]; error?: string } = { phases: [], visits: [] };
  let password = '';

  async function command(name: string, args: string[]) {
    const log = Bun.file(resolve(privateLogs, `${name}.log`));
    const descriptor = openSync(log.name!, 'a', 0o600);
    const child = Bun.spawn(args, { cwd: root, env, stdout: descriptor, stderr: descriptor });
    const code = await child.exited;
    closeSync(descriptor);
    if (code !== 0) {
      const output = (await log.text()).replaceAll(password || '\u0000', '[redacted]');
      throw new Error(`${name} exited ${code}\n${firstRedactedDiagnostic(output.slice(-12000), [password])}`);
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
        if (!isStartupTransportError(error)) throw error;
        lastFailure = String(error);
      }
      await Bun.sleep(500);
    }
    throw new Error(
      `Development stack readiness timed out: ${url}\n${firstRedactedDiagnostic(lastFailure, [password])}`,
    );
  }

  let stack: Bun.Subprocess | undefined;
  const pageChildren: Bun.Subprocess[] = [];
  let stackDescriptor: number | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await command('database', ['bun', 'run', '--cwd', 'services/kernel', 'db', 'up']);
    await command('search', ['bun', 'run', '--cwd', 'services/kernel', 'search', 'up']);
    const kernelEnvFile = resolve(root, 'services/kernel/.env');
    await writeFile(
      kernelEnvFile,
      (await readFile(kernelEnvFile, 'utf8'))
        .replace(/^AUTH_ISSUER=.*$/m, `AUTH_ISSUER=${issuerOrigin}`)
        .replace(/^AUTH_JWKS_URL=.*$/m, `AUTH_JWKS_URL=${nativeJwksUrl(nativeOrigin)}`),
      { mode: 0o600 },
    );
    await command('setup', ['bun', 'services/auth/scripts/dev-stack.ts', 'setup']);
    const kernelUrl = (await readFile(kernelEnvFile, 'utf8')).match(/^DATABASE_URL=(.*)$/m)?.[1];
    if (kernelUrl) await retireStaleSeedJournals(root, kernelUrl);
    await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']);
    password = JSON.parse(await readFile(resolve(root, '.temp/local-stack/keys.json'), 'utf8')).password;
    const stackLog = Bun.file(resolve(privateLogs, 'stack.log'));
    stackDescriptor = openSync(stackLog.name!, 'a', 0o600);
    stack = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
      cwd: root,
      env,
      stdout: stackDescriptor,
      stderr: stackDescriptor,
    });
    await ready(nativeJwksUrl(nativeOrigin), stack);
    await ready(`${kernelOrigin}/v1/definitions`, stack);
    report.phases.push('native-ready');
    report.phases.push(`kernel:${kernelLaunchCommand(env).join(' ')}`);
    const seedEnv = Object.fromEntries(
      (await readFile(resolve(root, '.temp/local-stack/seed.env'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    const seedLog = Bun.file(resolve(privateLogs, 'seed.log'));
    const seedDescriptor = openSync(seedLog.name!, 'a', 0o600);
    const seed = Bun.spawn(
      ['bun', '--eval', 'await (await import("./scripts/datasets/cross-media-seed.ts")).runDevelopmentSeed()'],
      {
        cwd: root,
        env: { ...env, ...seedEnv, AUTH_ORIGIN: nativeOrigin },
        stdout: seedDescriptor,
        stderr: seedDescriptor,
      },
    );
    const seedCode = await seed.exited;
    closeSync(seedDescriptor);
    if (seedCode !== 0 || !(await Bun.file(resolve(root, '.temp/cross-media-seed/result.json')).exists())) {
      throw new Error(
        `seed exited ${seedCode}\n${firstRedactedDiagnostic((await seedLog.text()).slice(-12000), [password])}`,
      );
    }
    report.phases.push('seed-returned');
    const pages = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'pages'], {
      cwd: root,
      env,
      stdout: stackDescriptor,
      stderr: stackDescriptor,
    });
    const web = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'web'], {
      cwd: root,
      env,
      stdout: stackDescriptor,
      stderr: stackDescriptor,
    });
    pageChildren.push(pages, web);
    await ready(`${issuerOrigin}/.well-known/openid-configuration`, pages);
    await ready(`${webOrigin}/en`, web);
    const result = JSON.parse(await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8')) as {
      readings: { source: string; externalId: string; route: string; subject: string }[];
    };
    const selected = result.readings.find((row) => row.source === 'vndb' && row.externalId === 'v2002');
    assert(selected, 'Missing selected VNDB v2002');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const url = `${webOrigin}/en${selected.route}`;
    const response = await page.goto(url);
    assert.equal(response?.status(), 200);
    await page.screenshot({ path: resolve(evidence, 'anonymous-v2002-ratings.png'), fullPage: true });
    report.visits.push({
      persona: 'anonymous',
      url: page.url(),
      subject: selected.subject,
      questionId: pageTypes.questionId,
      population: pageTypes.population,
    });
    report.phases.push('anonymous-ratings-page');
  } catch (error) {
    report.error = firstRedactedDiagnostic(String(error), [password]);
    if (await Bun.file(resolve(privateLogs, 'stack.log')).exists()) {
      await writeFile(
        resolve(evidence, 'stack.log'),
        firstRedactedDiagnostic(await readFile(resolve(privateLogs, 'stack.log'), 'utf8'), [password]),
        { mode: 0o600 },
      );
    }
    throw error;
  } finally {
    await writeFile(resolve(evidence, 'journey.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await browser?.close();
    for (const child of pageChildren) {
      child.kill('SIGTERM');
      await child.exited;
    }
    if (stack) {
      stack.kill('SIGTERM');
      await stack.exited;
    }
    if (stackDescriptor !== undefined) closeSync(stackDescriptor);
  }
}

if (import.meta.main) await run();
