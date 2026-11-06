/**
 * Seeded ratings and reviews walk. Runs inside `dev-stack.ts walk` for a worker whose brief lists native and browser
 * acceptance. It provisions the developer persona, seeds the development showcase, then runs the journey test with the
 * stack origins. Evidence stays under `.temp/ratings-walk/`.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const seedResult = join(root, '.temp/cross-media-seed/result.json');

async function parseEnv(path: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^(?<name>[A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (!match?.groups) continue;
    values[match.groups.name!] = match.groups.value!.replace(/^'(.*)'$/, '$1');
  }
  return values;
}

async function run(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  return await child.exited;
}

if (!process.env.GOAL_TASK_ID || !/native/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''))
  throw new Error('The ratings walk runs on a walk stack whose brief lists native and browser acceptance');
if (!process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN || !process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN)
  throw new Error('The ratings walk needs the walk stack origins from dev-stack.ts walk');

if ((await run(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], process.env)) !== 0)
  throw new Error('Developer persona provisioning failed');
const stackEnv = {
  ...process.env,
  ...(await parseEnv(join(root, '.temp/local-stack/seed.env'))),
  AUTH_ORIGIN: process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN,
  KERNEL_ORIGIN: process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN,
};
const seedCode = await run(['bun', 'scripts/datasets/cross-media-seed.ts', '--dev'], stackEnv);
console.log(`ratings-walk: seed exit ${seedCode}; result ${seedResult}`);
// Publication may be incomplete while the selected works are already seeded; the journey reads the result itself.
const testCode = await run(['bun', 'test', 'apps/web/tests/seeded-content-ratings-reviews.test.ts'], {
  ...stackEnv,
  REZICS_RATINGS_WALK_SEED_EXIT: String(seedCode),
});
if (testCode !== 0) throw new Error(`Seeded ratings walk exited ${testCode}`);
