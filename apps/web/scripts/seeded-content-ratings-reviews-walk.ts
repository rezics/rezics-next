/**
 * Seeded ratings and reviews walk. Runs inside `dev-stack.ts walk` for a worker whose brief lists native and browser
 * acceptance. It retires leftover seed journals (a walk stack always has a fresh database), provisions the developer
 * persona, seeds the development showcase, starts Auth pages and Web after the seed, then runs the journey from
 * apps/web so root bun-test preloads cannot send it to check hosts. Evidence stays under `.temp/ratings-walk/`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const webRoot = resolve(import.meta.dir, '..');
const root = resolve(webRoot, '../..');
const seedResult = join(root, '.temp/cross-media-seed/result.json');
const evidenceDir = join(root, '.temp/ratings-walk');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (!match?.groups) continue;
    values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv, cwd = root): Promise<number> {
  const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  return await child.exited;
}

function workIdentity(
  seed: { readings?: any[]; workLinks?: any[] },
  provider: string,
  externalId: string,
): string | null {
  for (const entry of seed.readings ?? []) {
    if (entry?.source !== provider || entry.externalId !== externalId) continue;
    const id = entry.subject?.subject?.id;
    if (typeof id === 'string' && uuidPattern.test(id)) return id;
  }
  for (const entry of seed.workLinks ?? []) {
    const source = entry?.source;
    if (source?.provider !== provider || source.externalId !== externalId) continue;
    const id = source.subject?.subjectId;
    if (typeof id === 'string' && uuidPattern.test(id)) return id;
  }
  return null;
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
  const { GLOBAL, QUESTION } = await import('../src/features/pages/subject-ratings.ts');
  const pageTypes = installedRatingsPage();
  assert.equal(pageTypes.questionId, QUESTION);
  assert.equal(pageTypes.population, GLOBAL);

  if (!process.env.GOAL_TASK_ID || !/native/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
    throw new Error('The ratings walk runs on a walk stack whose brief lists native and browser acceptance');
  if (!process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN || !process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN)
    throw new Error('The ratings walk needs the walk stack origins from dev-stack.ts walk');

  const { kernelEnvironment, retireDevelopmentSeedState, retireStaleSeedJournals, startSeededFrontends } =
    await import('../../../services/auth/scripts/dev-stack.ts');

  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  // Each walk stack has a fresh database; leftover journals still name the previous stack's native UUIDs.
  await retireDevelopmentSeedState(root);
  const kernelEnv = await kernelEnvironment();
  if (kernelEnv.DATABASE_URL) await retireStaleSeedJournals(root, kernelEnv.DATABASE_URL);

  if ((await runCommand(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], process.env)) !== 0)
    throw new Error('Developer persona provisioning failed');
  const stackEnv = {
    ...process.env,
    ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))),
    AUTH_ORIGIN: process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN,
    KERNEL_ORIGIN: process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN,
    REZICS_RATINGS_WALK: '1',
    TMPDIR: '/tmp/rw',
  };
  const seedCode = await runCommand(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], stackEnv);
  console.log(`ratings-walk: seed exit ${seedCode}; result ${seedResult}`);
  if (!(await Bun.file(seedResult).exists()))
    throw new Error(`Seeded ratings walk has no seed result after exit ${seedCode}`);
  const seed = JSON.parse(await readFile(seedResult, 'utf8')) as Record<string, unknown>;
  const identities = {
    vndbSteinsGate: workIdentity(seed, 'vndb', 'v2002'),
    bangumiSteinsGate: workIdentity(seed, 'bangumi', '10380'),
  };
  await writeFile(
    join(evidenceDir, 'seed-identities.json'),
    `${JSON.stringify({ seedExit: seedCode, identities, pageTypes }, null, 2)}\n`,
  );
  if (!identities.vndbSteinsGate)
    throw new Error(`Seed result has no native identity for VNDB v2002 after exit ${seedCode}`);

  const frontends = await startSeededFrontends();
  try {
    // apps/web bunfig has no root stack-lease preload, so this process keeps the walk-stack origins.
    const testCode = await runCommand(
      ['bun', 'test', 'tests/seeded-content-ratings-reviews.test.ts'],
      {
        ...stackEnv,
        REZICS_RATINGS_WALK_SEED_EXIT: String(seedCode),
      },
      webRoot,
    );
    if (testCode !== 0) throw new Error(`Seeded ratings walk exited ${testCode}`);
  } finally {
    await frontends.stop();
  }
}

if (import.meta.main) await run();
