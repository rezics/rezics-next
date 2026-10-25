import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { MAX_SUBJECT_GENERATIONS, RebuildError, rebuildSubjects } from '../../src/search/generations.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const search = createOpenSearch(searchUrl);
const kernelDirectory = new URL('../..', import.meta.url).pathname;
const prefixes: string[] = [];
afterAll(async () => {
  for (const prefix of prefixes) {
    const { generations } = await subjectGenerations(search, prefix);
    for (const generation of generations) await search.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  }
  await pool.end();
});

/** A prefix holding the given generations with the alias on `active`. */
async function deployment(generations: number[], active: number): Promise<string> {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  prefixes.push(prefix);
  for (const generation of generations) await createSubjectIndex(search, prefix, generation);
  await search.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, active), alias: subjectAlias(prefix) } }],
  });
  return prefix;
}

/** One rebuild that gives up at once unless the new generation is already caught up; how it ended. */
async function attempt(prefix: string): Promise<{ generation: number; reason: string | null }> {
  try {
    const { generation } = await rebuildSubjects({
      pool,
      search,
      source: createFakeSource(),
      prefix,
      runner: { async refresh() {} },
      pollMs: 0,
      rounds: 1,
      timeoutMs: 0,
    });
    return { generation, reason: null };
  } catch (error) {
    if (!(error instanceof RebuildError)) throw error;
    return { generation: error.generation, reason: error.reason };
  }
}

test('a rebuild refuses to create a fourth generation', async () => {
  expect(MAX_SUBJECT_GENERATIONS).toBe(3);
  const full = await deployment([1, 2, 3], 3);
  expect(await attempt(full)).toEqual({ generation: 4, reason: 'limit' });
  expect(await subjectGenerations(search, full)).toEqual({ generations: [1, 2, 3], active: 3 });

  const room = await deployment([2, 3], 3);
  const built = await attempt(room);
  expect(built.generation).toBe(4);
  expect(built.reason).not.toBe('limit');
  expect((await subjectGenerations(search, room)).generations).toEqual([2, 3, 4]);
}, 60_000);

test('a rebuild resumes the generation being built when three exist', async () => {
  const prefix = await deployment([2, 3, 4], 3);
  const resumed = await attempt(prefix);
  expect(resumed.generation).toBe(4);
  expect(resumed.reason).not.toBe('limit');
  expect((await subjectGenerations(search, prefix)).generations).toEqual([2, 3, 4]);
}, 60_000);

test('a rebuild running in another process excludes this one until that process ends', async () => {
  const prefix = await deployment([1], 1);
  const program = `
    import { createPool } from './src/database/pool.ts';
    import { rebuildSubjects } from './src/search/generations.ts';
    import { createOpenSearch } from './src/search/opensearch.ts';
    import { createFakeSource } from './test/search/support/fake-source.ts';

    const pool = createPool(process.env.DATABASE_URL);
    await rebuildSubjects({
      pool,
      search: createOpenSearch(process.env.OPENSEARCH_URL),
      source: createFakeSource(),
      prefix: process.env.REBUILD_PREFIX,
      runner: {
        refresh() {
          console.log('holding');
          setInterval(() => {}, 1000);
          return new Promise(() => {});
        },
      },
    });
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: kernelDirectory,
    env: { ...process.env, REBUILD_PREFIX: prefix },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    let output = '';
    const deadline = Date.now() + 20_000;
    while (!output.includes('holding')) {
      if (Date.now() > deadline) throw new Error(`the other rebuild did not start: ${output}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`the other rebuild exited: ${output}${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(value);
    }
    expect(await attempt(prefix)).toEqual({ generation: 2, reason: 'running' });
    expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 1 });
  } finally {
    child.kill();
    await child.exited;
  }

  const until = Date.now() + 10_000;
  let after = await attempt(prefix);
  while (after.reason === 'running' && Date.now() < until) {
    await Bun.sleep(100);
    after = await attempt(prefix);
  }
  expect(after.reason).not.toBe('running');
  expect(after.generation).toBe(2);
}, 60_000);
