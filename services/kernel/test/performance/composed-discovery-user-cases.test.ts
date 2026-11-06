import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  composedLimitBound,
  growthByteBounds,
  growthSeriesBounds,
  ordinaryCountedBounds,
  ordinaryCountedLimits,
  ordinaryDirectBound,
  PAGE_SLOTS,
  REQUESTED_SIZE,
  SCALES,
  expectPageBudget,
  expectHarnessBlocks,
  expectHarnessRows,
} from './support/composed-discovery-bounds.ts';
import {
  DEFERRED_AUTHORITY,
  DEFERRED_JOBS,
  FEWEST_TESTS_DECISION,
  OWNER_SURFACES,
  PUBLIC_JOBS,
  PUBLIC_SURFACES,
  SURFACES,
  applicableScenarios,
  frozenPublicCells,
  scenarioName,
} from './support/composed-discovery-matrix.ts';
import {
  createComposedDiscoveryWorld,
  mergeAlias,
  type ComposedDiscoveryWorld,
} from './support/composed-discovery-fixtures.ts';
import {
  assertDenied,
  assertPublicCell,
  cataloguePages,
  composedLimitPage,
  expectedIds,
  nativePlan,
  resumePrepared,
  revokeDuringPreparation,
  surfacePages,
} from './support/composed-discovery-plans.ts';
import { checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { discoveryKey, type CreatedSubject } from '../support/released-discovery.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let world: ComposedDiscoveryWorld | undefined;
let database: GrowthDatabase;
let fixture: ComposedDiscoveryWorld['fixture'];
let books: ComposedDiscoveryWorld['books'];
let recipes: ComposedDiscoveryWorld['recipes'];
let filters: ComposedDiscoveryWorld['filters'];
const unrelated: CreatedSubject[] = [];

beforeAll(async () => {
  world = await createComposedDiscoveryWorld({
    version: 1,
    search: 'native',
  });
  database = world.database;
  fixture = world.fixture;
  books = world.books;
  recipes = world.recipes;
  filters = world.filters;
}, 180_000);

afterAll(async () => {
  await world?.close();
}, 180_000);

test('derived composed 16-read 128-slot bound matches the published Cost table before repair', () => {
  expect(composedLimitBound).toMatchObject({
    reads: 16,
    slots: 128,
    candidates: 816,
    accessDependencyPoints: 6784,
    examinedRows: 14080,
    statements: 72,
    engineSearches: 96,
    connections: 1,
  });
  expect(ordinaryDirectBound.candidates).toBe(Math.min(600, 6 * PAGE_SLOTS + 3));
  expect(FEWEST_TESTS_DECISION).toContain('not-cooked and bulk stay frozen');
});

test('every reserved public and deferred cell is named before the remaining surfaces are filled', () => {
  const cells = frozenPublicCells();
  expect(cells.length).toBeGreaterThan(40);
  for (const cell of cells) {
    expect(cell.name).toBe(scenarioName(cell.job, cell.surface, cell.scenario));
    expect(applicableScenarios(cell.job, cell.surface)).toContain(cell.scenario);
  }
  expect(
    cells.filter(({ deferred }) => deferred).every(({ job }) => (DEFERRED_JOBS as readonly string[]).includes(job)),
  ).toBe(true);
});

test('released long-harem book plan keeps native work bounded as sparse Books grow at 64/512/4096', async () => {
  const report = await checkGrowth(database!, {
    name: 'Released long-harem book direct plan with sparse nonmatching Books',
    scales: [...SCALES],
    bounds: growthSeriesBounds,
    byteBounds: growthByteBounds,
    repetitions: 1,
    warmup: async () => {},
    async grow(_db, scale, previous) {
      for (let start = previous; start < scale; start += 128) {
        const end = Math.min(scale, start + 128);
        const added = await Promise.all(
          Array.from({ length: end - start }, (_, offset) =>
            fixture.createSubject('schema:Book', `Sparse nonmatch ${start + offset}`),
          ),
        );
        unrelated.push(...added);
        await fixture.catchUp(added);
      }
    },
    async operation() {
      const evidence = await nativePlan(world!, filters.combined, 'pit');
      expect(evidence.ids.slice(0, PAGE_SLOTS)).toEqual([books.subjects['B-long'].id]);
      expect(evidence.exhausted).toBe(true);
      expect(evidence.examined).toBeGreaterThan(0);
      expectPageBudget(evidence, PAGE_SLOTS, REQUESTED_SIZE);
      return evidence;
    },
    counted: {
      read(value) {
        const evidence = value as Awaited<ReturnType<typeof nativePlan>>;
        return {
          candidates: evidence.pageCost.candidates,
          accessDependencies: evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints,
          engineSearches: evidence.pageCost.engineSearches,
          iteratorSteps: evidence.pageCost.engineIteratorSteps,
          outputSlots: evidence.pageCost.outputSlots,
        };
      },
      limits: ordinaryCountedLimits,
      bounds: ordinaryCountedBounds,
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
  expect(unrelated).toHaveLength(4096);
  for (const sample of report.samples) {
    const candidates = sample.counted?.candidates?.value;
    expect(candidates).toBeGreaterThan(0);
    expectHarnessRows(sample.cost.rows + (sample.cost.backgroundRows ?? 0), candidates!);
    expectHarnessBlocks(sample.cost.blocks + (sample.cost.backgroundBlocks ?? 0), candidates!);
    expect(sample.cost.requestBytes).toBeDefined();
    expect(sample.cost.responseBytes).toBeDefined();
  }
}, 600_000);

test('native prepared book and recipe plans disclose their actual page and preparation work', async () => {
  const jobs = [
    { filter: filters.combined, expected: [books.subjects['B-long'].id] },
    {
      filter: filters.dietTime,
      expected: ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked'].map(
        (name) => recipes.subjects[name as keyof typeof recipes.subjects].id,
      ),
    },
  ];
  for (const { filter, expected } of jobs) {
    const measured = await nativePlan(world!, filter, 'prepared');
    expect([...measured.ids].sort()).toEqual([...expected].sort());
    expect(measured.examined).toBeGreaterThan(0);
    expect(measured.snapshot).toBe('prepared');
    expectPageBudget(measured, PAGE_SLOTS, REQUESTED_SIZE);
  }
}, 180_000);

test('production HTTP gives Anonymous and Alice the same released public jobs, including deep and empty pages', async () => {
  const bookJob = [books.subjects['B-long'].id];
  const bookControls = ['B-long', 'B-edge', 'B-characters'].map(
    (name) => books.subjects[name as keyof typeof books.subjects].id,
  );
  const recipeJob = ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked'].map(
    (name) => recipes.subjects[name as keyof typeof recipes.subjects].id,
  );
  for (const persona of ['anonymous', 'alice'] as const) {
    expect((await cataloguePages(world!, persona, filters.combined)).ids).toEqual(bookJob);
    const deep = await cataloguePages(world!, persona, filters.formHarem);
    expect(deep.ids).toEqual([...bookControls].sort());
    expect(deep.pages).toBe(2);
    expect((await cataloguePages(world!, persona, filters.dietTime)).ids).toEqual([...recipeJob].sort());
  }
  const empty = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
    filter: {
      and: [
        { type: { in: ['schema:Recipe'] } },
        { statement: { property: 'schema:keywords', in: [world!.classification.harem.id] } },
      ],
    },
    sort: 'id',
    limit: PAGE_SLOTS,
  });
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  expect(empty.body.subjects).toEqual([]);
  expect(empty.body.next).toBeNull();
});

for (const job of PUBLIC_JOBS) {
  for (const surface of [...PUBLIC_SURFACES, ...OWNER_SURFACES]) {
    test(`${job}/${surface}/first-page`, async () => {
      await assertPublicCell(world!, job, surface);
    }, 180_000);
  }
}

test('long-harem-light-novels/mounted-zone/composed-page-at-limits', async () => {
  const page = await composedLimitPage(world!, 'anonymous');
  expect(page.reads).toBe(16);
  expect(page.slots).toBeLessThanOrEqual(128);
  expect(page.combined.pageCost.candidates + page.recipes.pageCost.candidates).toBeLessThanOrEqual(
    composedLimitBound.candidates,
  );
}, 180_000);

test('long-harem-light-novels/curated-collection/aliases-and-duplicates', async () => {
  const unique = expectedIds(world!, 'long-harem-light-novels', 'catalogue-direct');
  const occurrences = expectedIds(world!, 'long-harem-light-novels', 'curated-collection');
  expect(new Set(unique).size).toBe(1);
  expect(occurrences.filter((id) => id === books.subjects['B-long'].id).length).toBe(2);
  expect(world!.duplicateNotes).toHaveLength(2);
  expect(world!.duplicateNotes[0]).not.toBe(world!.duplicateNotes[1]);
  const catalogue = await surfacePages(world!, 'long-harem-light-novels', 'catalogue-direct', 'anonymous', 'job');
  expect(catalogue.ids).toEqual(unique);
  const curated = await surfacePages(world!, 'long-harem-light-novels', 'curated-collection', 'anonymous', 'job');
  expect(curated.ids.filter((id) => id === books.subjects['B-long'].id).length).toBe(2);
  const original = await mergeAlias(fixture, books.subjects['B-long'], 'B-long alias original');
  const after = await cataloguePages(world!, 'anonymous', filters.combined);
  expect(after.ids).toEqual(unique);
  expect(after.ids).not.toContain(original.id);
}, 180_000);

test('long-harem-light-novels/catalogue-prepared/preparation-frontier-resume', async () => {
  const resumed = await resumePrepared(world!, filters.combined);
  expect(resumed.snapshot).toBe('prepared');
  expect([...resumed.ids].sort()).toEqual(expectedIds(world!, 'long-harem-light-novels', 'catalogue-direct'));
  expectPageBudget(resumed, PAGE_SLOTS, REQUESTED_SIZE);
  expect(resumed.rereads).toBeLessThanOrEqual(1);
}, 180_000);

test('long-harem-light-novels/catalogue-direct/foreign-dependency-revoked-midway', async () => {
  const measured = await revokeDuringPreparation(world!, filters.combined, 'pit');
  expect(measured.ids).not.toContain(books.subjects['B-long'].id);
  const restored = await nativePlan(world!, filters.combined, 'pit');
  expect(restored.ids.slice(0, PAGE_SLOTS)).toEqual([books.subjects['B-long'].id]);
}, 180_000);

test('long-harem-light-novels/catalogue-direct/hidden-control', async () => {
  const fact = books.facts.find(
    (entry) => entry.subject === books.subjects['B-long'].id && entry.property === 'schema:keywords',
  );
  expect(fact).toBeDefined();
  const hidden = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${books.subjects['B-long'].id}/candidates/${fact!.candidate}:hide`,
    { reason: 'Hidden-control of the released book job' },
    discoveryKey(),
  );
  expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
  try {
    await fixture.search!.converge([books.subjects['B-long']]);
    const page = await cataloguePages(world!, 'anonymous', filters.combined);
    expect(page.ids).toEqual([]);
  } finally {
    const restored = await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${books.subjects['B-long'].id}/candidates/${fact!.candidate}:restore`,
      { reason: 'Restore hidden-control of the released book job' },
      discoveryKey(),
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    await fixture.catchUp([books.subjects['B-long']]);
  }
}, 180_000);

test('long-harem-light-novels/own-state/denied-control', async () => {
  await assertDenied(world!, 'own-state', 'long-harem-light-novels');
  await assertDenied(world!, 'catalogue-direct', 'long-harem-light-novels');
}, 60_000);

test('long-harem-light-novels/catalogue-direct/suspended-control', async () => {
  const response = await fixture.signIn('suspended');
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(response.body.code).toBe('ACCOUNT_SUSPENDED');
  for (const key of ['session', 'token', 'access_token', 'refresh_token', 'user'])
    expect(response.body).not.toHaveProperty(key);
}, 30_000);

test('quick-vegetarian-recipes/catalogue-direct/empty-control', async () => {
  const empty = await cataloguePages(world!, 'anonymous', {
    and: [
      { type: { in: ['schema:Recipe'] } },
      { statement: { property: 'schema:keywords', in: [world!.classification.harem.id] } },
    ],
  });
  expect(empty.ids).toEqual([]);
  expect(empty.pages).toBe(1);
}, 60_000);

test('quick-vegetarian-recipes/catalogue-direct/sparse-page', async () => {
  const extras: CreatedSubject[] = [];
  const report = await checkGrowth(database!, {
    name: 'Released quick vegetarian recipe direct plan with sparse nonmatching Recipes',
    scales: [...SCALES],
    bounds: growthSeriesBounds,
    byteBounds: growthByteBounds,
    repetitions: 1,
    warmup: async () => {},
    async grow(_db, scale, previous) {
      for (let start = previous; start < scale; start += 128) {
        const end = Math.min(scale, start + 128);
        const added = await Promise.all(
          Array.from({ length: end - start }, (_, offset) =>
            fixture.createSubject('schema:Recipe', `Sparse recipe nonmatch ${start + offset}`),
          ),
        );
        extras.push(...added);
        await fixture.catchUp(added);
      }
    },
    async operation() {
      const evidence = await nativePlan(world!, filters.dietTime, 'pit');
      expect([...evidence.ids].sort()).toEqual(expectedIds(world!, 'quick-vegetarian-recipes', 'catalogue-direct'));
      expect(evidence.examined).toBeGreaterThan(0);
      expectPageBudget(evidence, PAGE_SLOTS, REQUESTED_SIZE);
      return evidence;
    },
    counted: {
      read(value) {
        const evidence = value as Awaited<ReturnType<typeof nativePlan>>;
        return {
          candidates: evidence.pageCost.candidates,
          accessDependencies: evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints,
          engineSearches: evidence.pageCost.engineSearches,
          iteratorSteps: evidence.pageCost.engineIteratorSteps,
          outputSlots: evidence.pageCost.outputSlots,
        };
      },
      limits: ordinaryCountedLimits,
      bounds: ordinaryCountedBounds,
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
  expect(extras).toHaveLength(4096);
}, 600_000);

test('long-harem-light-novels/own-state/unrelated-owner-history', async () => {
  const accepted = world!.population.profile('schema:Book');
  const active = accepted.profile.entryStateSet?.states.find(({ role }) => role === 'active');
  expect(active).toBeDefined();
  const report = await checkGrowth(database!, {
    name: 'Alice own-state book job with Bob unrelated history',
    scales: [...SCALES],
    bounds: growthSeriesBounds,
    byteBounds: growthByteBounds,
    repetitions: 1,
    warmup: async () => {},
    async grow(_db, scale, previous) {
      for (let start = previous; start < scale; start += 64) {
        const end = Math.min(scale, start + 64);
        const added = await Promise.all(
          Array.from({ length: end - start }, (_, offset) =>
            fixture.createSubject('schema:Book', `Bob unrelated ${start + offset}`),
          ),
        );
        for (const subject of added) {
          const created = await world!.population.request(
            'bob',
            'PUT',
            `/v1/libraryEntries/${subject.id}`,
            { state: active!.id },
            discoveryKey(),
          );
          expect(created.status, JSON.stringify(created.body)).toBe(201);
        }
        await fixture.catchUp(added);
      }
    },
    async operation() {
      const page = await surfacePages(world!, 'long-harem-light-novels', 'own-state', 'alice', 'job');
      expect([...page.ids].sort()).toEqual(expectedIds(world!, 'long-harem-light-novels', 'own-state'));
      const evidence = await nativePlan(world!, filters.combined, 'pit');
      expectPageBudget(evidence, PAGE_SLOTS, REQUESTED_SIZE);
      return evidence;
    },
    counted: {
      read(value) {
        const evidence = value as Awaited<ReturnType<typeof nativePlan>>;
        return {
          candidates: evidence.pageCost.candidates,
          accessDependencies: evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints,
          engineSearches: evidence.pageCost.engineSearches,
          iteratorSteps: evidence.pageCost.engineIteratorSteps,
          outputSlots: evidence.pageCost.outputSlots,
        };
      },
      limits: ordinaryCountedLimits,
      bounds: ordinaryCountedBounds,
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
}, 600_000);

test('long-harem-light-novels/catalogue-direct/privacy-reduction-served-share', async () => {
  let served = 1;
  const report = await checkGrowth(database!, {
    name: 'Public served share under growing acknowledged privacy reductions',
    scales: [...SCALES],
    bounds: growthSeriesBounds,
    byteBounds: growthByteBounds,
    repetitions: 1,
    warmup: async () => {},
    async grow(_db, scale, previous) {
      await fixture.grant('editor', ['moderation:hide', 'moderation:restore'], GLOBAL_CONTEXT);
      const added: CreatedSubject[] = [];
      for (let start = previous; start < scale; start += 64) {
        const end = Math.min(scale, start + 64);
        const batch = await Promise.all(
          Array.from({ length: end - start }, (_, offset) =>
            fixture.createSubject('schema:Book', `Privacy reduction ${start + offset}`),
          ),
        );
        for (const subject of batch) {
          const hidden = await fixture.request(
            'editor',
            'POST',
            `/v1/subjects/${subject.id}:hide`,
            { reason: 'Growing acknowledged privacy reductions' },
            discoveryKey(),
          );
          expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
        }
        added.push(...batch);
        await fixture.catchUp(batch);
      }
    },
    async operation() {
      const page = await cataloguePages(world!, 'anonymous', filters.combined);
      expect(page.ids).toEqual([books.subjects['B-long'].id]);
      const evidence = await nativePlan(world!, filters.combined, 'pit');
      expectPageBudget(evidence, PAGE_SLOTS, REQUESTED_SIZE);
      served = 1;
      return { ...evidence, served };
    },
    counted: {
      read(value) {
        const evidence = value as Awaited<ReturnType<typeof nativePlan>> & { served: number };
        return {
          candidates: evidence.pageCost.candidates,
          accessDependencies: evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints,
          engineSearches: evidence.pageCost.engineSearches,
          iteratorSteps: evidence.pageCost.engineIteratorSteps,
          outputSlots: evidence.pageCost.outputSlots,
          served: evidence.served,
        };
      },
      limits: { ...ordinaryCountedLimits, served: 1 },
      bounds: { ...ordinaryCountedBounds, served: 'constant' },
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
  const shares = report.samples.map((sample) => sample.counted?.served?.value ?? 0);
  for (let index = 1; index < shares.length; index++) expect(shares[index]!).toBeGreaterThanOrEqual(shares[index - 1]!);
}, 600_000);

for (const job of DEFERRED_JOBS) {
  for (const surface of SURFACES.filter((surface) => applicableScenarios(job, surface).length > 0)) {
    test(`${job}/${surface}/first-page`, () => {
      expect(world!.population.prerequisites.cookedQuery.state).toBe('prerequisite');
      expect(DEFERRED_AUTHORITY[job]).toContain(job === 'quick-vegetarian-not-cooked' ? 'not-cooked' : 'bulk');
    });
  }
}
