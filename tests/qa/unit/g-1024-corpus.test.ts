import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  prepareWorkProfileCorpus,
  restoreWorkProfileCorpus,
  workProfileCorpusApi,
  workProfileCorpusId,
  workProfileDimensions,
  WORK_PROFILE_DIMENSIONS,
  WORK_PROFILE_SCALES,
  type CorpusDimensions,
  type WorkProfileCorpusRecipe,
} from '../../../scripts/load/work-profile-corpus.ts';
import { captureFusekiPlan, captureFusekiQueryPlan } from '../../../scripts/load/fuseki-plan.ts';
import { fusekiCandidateCounts } from '../../../scripts/load/fuseki-candidates.ts';

const fixed: CorpusDimensions = {
  unrelatedWorks: 0,
  unrelatedPosts: 0,
  follows: 0,
  memberships: 0,
  historyDepth: 0,
  realmSize: 0,
  conceptVocabulary: 0,
};
function directory() {
  mkdirSync('.temp/work-profiles/tests', { recursive: true });
  return mkdtempSync(resolve('.temp/work-profiles/tests/g-1024-'));
}

test('G1024: each axis grows alone at three strictly increasing scales with stable dataset identities', () => {
  for (const dimension of WORK_PROFILE_DIMENSIONS) {
    let last = 0;
    const sizes: number[] = [];
    const ids = new Set<string>();
    for (const scale of WORK_PROFILE_SCALES) {
      const dimensions = workProfileDimensions(dimension, scale, fixed);
      expect(dimensions[dimension]).toBeGreaterThan(last);
      last = dimensions[dimension];
      sizes.push(last);
      for (const key of WORK_PROFILE_DIMENSIONS.filter((key) => key !== dimension))
        expect(dimensions[key]).toBe(0);
      const recipe = { version: 'calibration-v1', fixed } as WorkProfileCorpusRecipe;
      const id = workProfileCorpusId(recipe, dimension, scale);
      expect(workProfileCorpusId(recipe, dimension, scale)).toBe(id);
      ids.add(id);
    }
    expect(ids.size).toBe(3);
    expect(sizes[1]! / sizes[0]!).toBe(4);
    expect(sizes[2]! / sizes[1]!).toBe(4);
  }
});

test('retained population cuts share one owner and declare every co-grown axis', async () => {
  const dir = directory();
  const actual = { ...fixed, recipeOccurrences: 0, readerShelfEntries: 0 };
  let cuts = 0;
  const recipe: WorkProfileCorpusRecipe = { version: 'population-cut-v1', fixed,
    populations: ['recipeOccurrences', 'readerShelfEntries'], initialize: async () => {},
    async grow(_api, axis, index) { actual[axis as keyof typeof actual] = Math.max(actual[axis as keyof typeof actual] ?? 0, index + 1); },
    verify: async () => actual };
  const api = { command: async <T>() => undefined as T, read: async <T>() => undefined as T };
  const backups = { backup: async () => `cut-${++cuts}`, restore: async () => {} };
  try {
    for (const [index, scale] of WORK_PROFILE_SCALES.entries()) {
      const cut = await prepareWorkProfileCorpus({ recipe, api, backups, dimension: 'unrelatedWorks', scale, directory: dir });
      expect(cut.dimensions.unrelatedWorks).toBe([4, 16, 64][index]);
      expect(cut.dimensions.recipeOccurrences).toBe([100, 400, 1600][index]);
      expect(cut.dimensions.readerShelfEntries).toBe([4, 16, 64][index]);
      expect(await prepareWorkProfileCorpus({ recipe, api, backups, dimension: 'unrelatedWorks', scale, directory: dir })).toEqual(cut);
    }
    expect(cuts).toBe(3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G1024: corpus runs public commands with idempotency, verifies dimensions, builds once and restores separately', async () => {
  const dir = directory();
  const commands = new Map<string, string>();
  const heads: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer local-test');
      if (request.method === 'GET') return Response.json({ count: heads.length });
      const key = request.headers.get('idempotency-key')!;
      const body = (await request.json()) as { expectedHead: string | null };
      const replay = commands.get(key);
      if (replay) return Response.json({ revision: replay });
      if (body.expectedHead !== (heads.at(-1) ?? null)) return new Response(null, { status: 409 });
      const revision = `head-${heads.length}`;
      heads.push(revision);
      commands.set(key, revision);
      return Response.json({ revision }, { status: 201 });
    },
  });
  const api = workProfileCorpusApi(server.url.origin, 'local-test');
  let head: string | null = null;
  let backups = 0,
    restores = 0,
    initializes = 0;
  const recipe: WorkProfileCorpusRecipe = {
    version: 'history-v1',
    fixed,
    async initialize(client, key) {
      initializes++;
      const value = await client.command<{ revision: string }>(key, {
        method: 'POST',
        path: '/v1/works',
        body: { expectedHead: head },
      });
      head = value.revision;
    },
    async grow(client, dimension, _index, key) {
      expect(dimension).toBe('historyDepth');
      const value = await client.command<{ revision: string }>(key, {
        method: 'POST',
        path: '/v1/member-reply-drafts',
        body: { expectedHead: head },
      });
      head = value.revision;
    },
    async verify(client) {
      const value = await client.read<{ count: number }>('/v1/history');
      return { ...fixed, historyDepth: value.count - 1 };
    },
  };
  const driver = {
    async backup() {
      backups++;
      return 'stopped-backup';
    },
    async restore(backup: string, target: string) {
      expect(backup).toBe('stopped-backup');
      expect(target).toBe('isolated-g-1024');
      restores++;
    },
  };
  try {
    const input = {
      recipe,
      api,
      backups: driver,
      dimension: 'historyDepth' as const,
      scale: 'small' as const,
      directory: dir,
    };
    const manifest = await prepareWorkProfileCorpus(input);
    expect(manifest.dimensions.historyDepth).toBe(2);
    expect(await prepareWorkProfileCorpus(input)).toEqual(manifest);
    expect(initializes).toBe(1);
    const medium = await prepareWorkProfileCorpus({ ...input, scale: 'medium' });
    const large = await prepareWorkProfileCorpus({ ...input, scale: 'large' });
    expect(medium.dimensions.historyDepth).toBe(8);
    expect(large.dimensions.historyDepth).toBe(32);
    expect(initializes).toBe(3);
    expect(backups).toBe(3);
    expect(commands.size).toBe(33);
    await restoreWorkProfileCorpus(manifest, 'isolated-g-1024', driver);
    expect(restores).toBe(1);
    writeFileSync(
      join(dir, `${manifest.id}.json`),
      JSON.stringify({ ...manifest, compatibility: { digest: '0'.repeat(64), files: {} } }),
    );
    await expect(prepareWorkProfileCorpus(input)).rejects.toThrow('Incompatible or incomplete');
    await expect(restoreWorkProfileCorpus(manifest, manifest.id, driver)).rejects.toThrow(
      'distinct',
    );
    await expect(
      prepareWorkProfileCorpus({
        ...input,
        recipe: { ...recipe, version: 'history-deadline-v1' },
        startedAt: performance.now() - 600_001,
        scale: 'medium',
      }),
    ).rejects.toThrow('600 seconds');
    await expect(
      api.command('partial', { method: 'POST', path: '/v1/works', body: { expectedHead: null } }),
    ).rejects.toThrow('HTTP 409');
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1024: a wrong corpus or failed backup never publishes a reusable manifest', async () => {
  const dir = directory();
  const api = workProfileCorpusApi('http://127.0.0.1', 'unused');
  const recipe: WorkProfileCorpusRecipe = {
    version: 'wrong-v1',
    fixed,
    async initialize() {},
    async grow() {},
    async verify() {
      return fixed;
    },
  };
  let backups = 0;
  try {
    await expect(
      prepareWorkProfileCorpus({
        recipe,
        api,
        directory: dir,
        backups: {
          async backup() {
            backups++;
            return 'bad';
          },
          async restore() {},
        },
        dimension: 'unrelatedWorks',
        scale: 'small',
      }),
    ).rejects.toThrow('Corpus dimension');
    expect(backups).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1024: concurrent preparation cannot build the same dataset twice', async () => {
  const dir = directory();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0,
    initialized = 0;
  const recipe: WorkProfileCorpusRecipe = {
    version: 'concurrent-v1',
    fixed,
    async initialize() {
      initialized++;
      enter();
      await paused;
    },
    async grow() {
      count++;
    },
    async verify() {
      return { ...fixed, unrelatedWorks: count };
    },
  };
  const input = {
    recipe,
    api: workProfileCorpusApi('http://127.0.0.1', 'unused'),
    backups: {
      async backup() {
        return 'stopped-backup';
      },
      async restore() {},
    },
    directory: dir,
    dimension: 'unrelatedWorks' as const,
    scale: 'small' as const,
  };
  const first = prepareWorkProfileCorpus(input);
  try {
    await entered;
    await expect(prepareWorkProfileCorpus(input)).rejects.toThrow('already claimed');
    release();
    const manifest = await first;
    expect(initialized).toBe(1);
    expect(manifest.dimensions.unrelatedWorks).toBe(4);
    expect(await prepareWorkProfileCorpus(input)).toEqual(manifest);
    expect(initialized).toBe(1);
  } finally {
    release();
    await first;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1024: a blocking preparation callback cannot publish a manifest after the wall-time ceiling', async () => {
  const dir = directory();
  let initialized = false,
    grows = 0,
    backups = 0;
  const recipe: WorkProfileCorpusRecipe = {
    version: 'blocking-v1',
    fixed,
    async initialize() {
      initialized = true;
      Bun.sleepSync(1_100);
    },
    async grow() {
      grows++;
    },
    async verify() {
      return fixed;
    },
  };
  try {
    await expect(
      prepareWorkProfileCorpus({
        recipe,
        api: workProfileCorpusApi('http://127.0.0.1', 'unused'),
        backups: {
          async backup() {
            backups++;
            return 'late';
          },
          async restore() {},
        },
        directory: dir,
        dimension: 'unrelatedWorks',
        scale: 'small',
        startedAt: performance.now() - 599_000,
      }),
    ).rejects.toThrow('600 seconds');
    expect(initialized).toBe(true);
    expect(grows).toBe(0);
    expect(backups).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1024: plan artifacts stay in the checkout, the QA artifact root or /tmp', () => {
  const outside = mkdtempSync(join(homedir(), '.cache/g-1024-plan-'));
  const previous = process.env.REZICS_QA_ARTIFACT_ROOT;
  const capture = (directory: string) => captureFusekiPlan('SELECT ?x WHERE { VALUES ?x { 1 } }', {
    label: 'placement',
    directory,
    image: { image: 'rezics/fuseki:6.2.0-cmd0.5.36', jenaVersion: '6.2.0' },
    run: () => ({ status: 0, stdout: '(table)', stderr: '' }),
  });
  try {
    delete process.env.REZICS_QA_ARTIFACT_ROOT;
    expect(() => capture(join(outside, 'qa/plans'))).toThrow('Plan artifacts must stay');
    process.env.REZICS_QA_ARTIFACT_ROOT = join(outside, 'qa');
    expect(capture(join(outside, 'qa/plans')).planFile).toEndWith('.plan.txt');
    expect(() => capture(join(outside, 'elsewhere'))).toThrow('Plan artifacts must stay');
    expect(() => capture(join(outside, 'qa-sibling'))).toThrow('Plan artifacts must stay');
  } finally {
    if (previous === undefined) delete process.env.REZICS_QA_ARTIFACT_ROOT;
    else process.env.REZICS_QA_ARTIFACT_ROOT = previous;
    rmSync(outside, { recursive: true, force: true });
  }
});

test('G1024: plan helper retains the exact query, uses the pinned offline image and fails on a parser error', () => {
  const dir = directory();
  try {
    const query = 'SELECT ?x WHERE { VALUES ?x { 1 2 } }';
    const options = {
      label: 'calibration',
      directory: dir,
      image: { image: 'rezics/fuseki:6.2.0-cmd0.5.36', jenaVersion: '6.2.0' },
    };
    const plan = captureFusekiPlan(query, {
      ...options,
      run(command) {
        expect(command).toContain('none');
        expect(command).toContain('arq.qparse');
        expect(command).toContain('rezics/fuseki:6.2.0-cmd0.5.36');
        return { status: 0, stdout: '(table (vars ?x) (row [?x 1]))', stderr: '' };
      },
    });
    expect(readFileSync(join(dir, plan.queryFile), 'utf8')).toBe(`${query}\n`);
    expect(plan.queryDigest).toHaveLength(64);
    expect(() =>
      captureFusekiPlan(query, {
        ...options,
        run: () => ({ status: 1, stdout: '', stderr: 'syntax failure' }),
      }),
    ).toThrow('plan failed');
    expect(() => captureFusekiPlan(query, { ...options, label: '../escape' })).toThrow('Invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1024: plan capture retains query-reported candidates once and keeps missing native counters unknown', () => {
  const dir = directory();
  const result = {
    results: {
      bindings: [{ candidateCount: { value: '513' } }, { candidateCount: { value: '513' } }],
    },
  };
  try {
    const plan = captureFusekiQueryPlan(
      { sparql: 'SELECT ?candidateCount WHERE {}', result },
      {
        label: 'candidates',
        directory: dir,
        run: () => ({ status: 0, stdout: '(project (?candidateCount) (table unit))', stderr: '' }),
      },
    );
    expect(plan.candidates).toMatchObject({ counts: [513], returnedBindings: 2 });
    expect(readFileSync(join(dir, plan.countsFile), 'utf8')).toContain(plan.queryDigest);
    expect(fusekiCandidateCounts({ results: { bindings: [] } }).counts).toBeNull();
    expect(
      fusekiCandidateCounts({ results: { bindings: [{ candidateCount: { value: '-1' } }] } })
        .counts,
    ).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
