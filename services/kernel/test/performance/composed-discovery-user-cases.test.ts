import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { FilterDocument } from '@rezics/filter';
import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import {
  createReleasedDiscoveryFixture,
  type CreatedSubject,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scales = [64, 512, 4096] as const;
const pageSize = 2;
const requestedSize = 2 * pageSize + 1;
const costKeys: (keyof PublicFilterCost)[] = [
  'inputKeys',
  'candidates',
  'accessPoints',
  'dependencyPoints',
  'engineSearches',
  'engineIteratorSteps',
  'outputSlots',
  'resultWrites',
  'frontierWrites',
];
const zeroCost = (): PublicFilterCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});

type PlanEvidence = Readonly<{
  ids: readonly string[];
  examined: number;
  exhausted: boolean;
  pageCost: PublicFilterCost;
  preparationCost: PublicFilterCost;
  preparationSteps: number;
  snapshot: 'pit' | 'prepared';
}>;

let fixture: ReleasedDiscoveryFixture | undefined;
let database: GrowthDatabase | undefined;
let books: Awaited<ReturnType<ReleasedDiscoveryFixture['books']>>;
let recipes: Awaited<ReturnType<ReleasedDiscoveryFixture['recipes']>>;
let filters: ReturnType<ReleasedDiscoveryFixture['filters']>;
let classification: Awaited<ReturnType<ReleasedDiscoveryFixture['classification']>>;
const unrelated: CreatedSubject[] = [];

function sumCosts(costs: readonly PublicFilterCost[]): PublicFilterCost {
  const total = { ...zeroCost() };
  for (const cost of costs) for (const key of costKeys) total[key] += cost[key];
  return total;
}

function expectCost(cost: PublicFilterCost) {
  for (const count of Object.values(cost)) expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
}

function expectPreparationStep(cost: PublicFilterCost) {
  expectCost(cost);
  expect(cost.inputKeys).toBeLessThanOrEqual(1000);
  expect(cost.resultWrites).toBeLessThanOrEqual(1000);
  expect(cost.frontierWrites).toBeLessThanOrEqual(1);
  expect(cost.accessPoints + cost.dependencyPoints).toBeLessThanOrEqual(8 * cost.inputKeys);
  expect(cost.engineSearches).toBeLessThanOrEqual(4);
}

function expectPageBudget(evidence: PlanEvidence, size: number, outputSize: number) {
  expectCost(evidence.pageCost);
  const candidates = evidence.pageCost.candidates;
  const candidateLimit = evidence.snapshot === 'pit' ? Math.min(600, 6 * size + 3) : 2 * size + 2;
  expect(candidates).toBeGreaterThan(0);
  expect(candidates).toBeLessThanOrEqual(candidateLimit);
  if (evidence.snapshot === 'pit') {
    expect(evidence.pageCost.engineSearches).toBeGreaterThan(0);
    expect(evidence.pageCost.engineIteratorSteps).toBeGreaterThan(0);
  }
  expect(evidence.pageCost.engineSearches).toBeLessThanOrEqual(evidence.snapshot === 'pit' ? 6 : 2);
  expect(evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints).toBeLessThanOrEqual(16 + 8 * candidates);
  expect(evidence.pageCost.outputSlots).toBeLessThanOrEqual(outputSize);
  expectCost(evidence.preparationCost);
}

async function nativePlan(filterDocument: FilterDocument, snapshot: 'pit' | 'prepared'): Promise<PlanEvidence> {
  const native = fixture?.search;
  if (!native) throw new Error('The default native Search consumer is unavailable');
  const context: PublicFilterConsumerContext = { deadline: Date.now() + 60_000 };
  const plan: PublicFilterConsumerCaptureInput = {
    sort: 'id',
    size: requestedSize,
    pageSize,
    text: undefined,
    filterDocument,
  };
  const request = { plan, snapshot } as const;
  const bound = await native.bindRequest(request, context);
  const pageCosts: PublicFilterCost[] = [];
  const preparationCosts: PublicFilterCost[] = [];
  let preparationSteps = 0;
  let capture = bound.capture;
  try {
    for (let attempt = 0; attempt < 256; attempt++) {
      if (capture.status === 'preparing') {
        preparationCosts.push(capture.cost);
        const step = await bound.operations.repairStep(capture.repair, context);
        if (step.status !== 'progress' && step.status !== 'settled')
          throw new Error(`Native public preparation unavailable: ${JSON.stringify(step)}`);
        expectPreparationStep(step.cost);
        preparationCosts.push(step.cost);
        preparationSteps++;
        capture = await bound.operations.capture(request, context);
        continue;
      }
      if (capture.status !== 'captured') throw new Error(`Native public plan unavailable: ${JSON.stringify(capture)}`);
      expect(capture.queried.snapshot.kind).toBe(snapshot);
      pageCosts.push(capture.cost);
      const result = await bound.operations.query(capture.queried, context);
      pageCosts.push(result.cost);
      if (result.status === 'preparing') {
        const step = await bound.operations.repairStep(capture.repair, context);
        if (step.status !== 'progress' && step.status !== 'settled')
          throw new Error(`Native public preparation unavailable: ${JSON.stringify(step)}`);
        expectPreparationStep(step.cost);
        preparationCosts.push(step.cost);
        preparationSteps++;
        capture = await bound.operations.capture(request, context);
        continue;
      }
      if (result.status !== 'queried') throw new Error(`Native public query unavailable: ${JSON.stringify(result)}`);
      await bound.operations.closeObservation(result.queried, context);
      return {
        ids: result.result.hits.map(({ id }) => id),
        examined: result.window.examined,
        exhausted: result.window.exhausted,
        pageCost: sumCosts(pageCosts),
        preparationCost: sumCosts(preparationCosts),
        preparationSteps,
        snapshot,
      };
    }
    throw new Error('Native public plan did not reach a bounded useful result');
  } finally {
    await bound.operations.close();
  }
}

async function catalogue(persona: DiscoveryPersona, filter: FilterDocument) {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const response = await fixture!.request(persona, 'POST', '/v1/subjects:search', {
      filter,
      sort: 'id',
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = response.body.subjects;
    assert(Array.isArray(rows));
    assert(response.body.next === null || typeof response.body.next === 'string');
    if (response.body.next !== null) expect(rows).toHaveLength(pageSize);
    expect(rows.length).toBeLessThanOrEqual(pageSize);
    ids.push(...rows.map((row: { id: string }) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    cursor = response.body.next ?? undefined;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
    pages++;
    expect(pages).toBeLessThanOrEqual(16);
  } while (cursor);
  expect(ids).toEqual([...ids].sort());
  return { ids, pages };
}

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({
    version: 1,
    search: 'native',
    async kernelPool(url) {
      database = await openGrowthDatabase(url);
      return database.pool;
    },
  });
  await fixture.setup.openFeatures(['search', 'search_advanced']);
  books = await fixture.books();
  recipes = await fixture.recipes();
  classification = await fixture.classification();
  filters = fixture.filters(classification, await fixture.diet());
}, 120_000);

afterAll(async () => {
  await database?.admin.end();
  await fixture?.close();
}, 180_000);

test('released long-harem book plan keeps native work bounded as sparse Books grow at 64/512/4096', async () => {
  const report = await checkGrowth(database!, {
    name: 'Released long-harem book direct plan with sparse nonmatching Books',
    scales: [...scales],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    repetitions: 1,
    warmup: async () => {},
    async grow(_db, scale, previous) {
      for (let start = previous; start < scale; start += 128) {
        const end = Math.min(scale, start + 128);
        const added = await Promise.all(
          Array.from({ length: end - start }, (_, offset) =>
            fixture!.createSubject('schema:Book', `Sparse nonmatch ${start + offset}`),
          ),
        );
        unrelated.push(...added);
        await fixture!.catchUp(added);
      }
    },
    async operation() {
      const evidence = await nativePlan(filters.combined, 'pit');
      expect(evidence.ids.slice(0, pageSize)).toEqual([books.subjects['B-long'].id]);
      expect(evidence.exhausted).toBe(true);
      expect(evidence.examined).toBeGreaterThan(0);
      expectPageBudget(evidence, pageSize, requestedSize);
      return evidence;
    },
    counted: {
      read(value) {
        const evidence = value as PlanEvidence;
        return {
          candidates: evidence.pageCost.candidates,
          accessDependencies: evidence.pageCost.accessPoints + evidence.pageCost.dependencyPoints,
          engineSearches: evidence.pageCost.engineSearches,
          iteratorSteps: evidence.pageCost.engineIteratorSteps,
          outputSlots: evidence.pageCost.outputSlots,
        };
      },
      limits: { candidates: Math.min(600, 6 * pageSize + 3), engineSearches: 6, outputSlots: requestedSize },
      bounds: {
        candidates: 'constant',
        accessDependencies: 'constant',
        engineSearches: 'constant',
        iteratorSteps: 'logarithmic',
        outputSlots: 'constant',
      },
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(unrelated).toHaveLength(4096);
  for (const sample of report.samples) {
    const candidates = sample.counted?.candidates?.value;
    expect(candidates).toBeGreaterThan(0);
    expect(sample.cost.rows + (sample.cost.backgroundRows ?? 0)).toBeLessThanOrEqual(64 + 16 * candidates!);
    expect(sample.cost.blocks + (sample.cost.backgroundBlocks ?? 0)).toBeLessThanOrEqual(6 * (64 + 16 * candidates!));
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
    const measured = await nativePlan(filter, 'prepared');
    expect([...measured.ids].sort()).toEqual([...expected].sort());
    expect(measured.examined).toBeGreaterThan(0);
    expect(measured.snapshot).toBe('prepared');
    expectPageBudget(measured, pageSize, requestedSize);
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
    expect((await catalogue(persona, filters.combined)).ids).toEqual(bookJob);
    const deep = await catalogue(persona, filters.formHarem);
    expect(deep.ids).toEqual([...bookControls].sort());
    expect(deep.pages).toBe(2);
    expect((await catalogue(persona, filters.dietTime)).ids).toEqual([...recipeJob].sort());
  }
  const empty = await fixture!.request('anonymous', 'POST', '/v1/subjects:search', {
    filter: {
      and: [
        { type: { in: ['schema:Recipe'] } },
        { statement: { property: 'schema:keywords', in: [classification.harem.id] } },
      ],
    },
    sort: 'id',
    limit: pageSize,
  });
  expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  expect(empty.body.subjects).toEqual([]);
  expect(empty.body.next).toBeNull();
});
