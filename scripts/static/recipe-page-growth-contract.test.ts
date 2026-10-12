import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clearVerifiedImmutableObjectCache, rememberVerifiedImmutableObject, S3ImmutableObjects,
} from '../../services/main/src/infrastructure/immutable-objects.ts';
import { STRUCTURE_LIMITS } from '../../services/main/src/modules/structure/format.ts';
import { RECIPE_WORK_PAGE_OCCURRENCES, RECIPE_WORK_PAGE_READ_BOUND }
  from '../../services/main/src/modules/recipe/work-page.ts';
import {
  assertRecipeObjectBudget, assertRecipePageComplete, assertRecipeSeriesCosts, budgetRecipeProfile, coldRecipeRequest,
  finishRecipeGrowth, RECIPE_GROWTH_COVERAGE, recipeCostSample, recipeObjectBudget,
  recipeReaderRequest, recipeRemoteCost, recipeSectionDepthTodo,
  type RecipeCostSeries, type RecipeFetch, type RecipePage, type RecipeTreeCensus,
} from '../../tests/qa/support/recipe-page-growth-contract.ts';
import type { WorkProfile } from '../../tests/qa/support/work-profile.ts';

const contract = recipeRemoteCost(RECIPE_WORK_PAGE_READ_BOUND);
const K = RECIPE_WORK_PAGE_OCCURRENCES;
const origin = 'http://objects.test';
const prefix = '/rezics-semantic/semantic/structure/sha256/';
const census: RecipeTreeCensus = {
  structure: 'recipe-structure', revision: 'recipe-revision', occurrences: K * 4, depth: 1,
  nodeCount: 16, manifestNodes: 1, recordNodes: 12, orderNodes: 3, recordDepth: 1, orderDepth: 1,
  objectPaths: [prefix + 'a'.repeat(64)],
  occurrenceOrder: Array.from({ length: K * 4 }, (_, i) => `occurrence-${i}`),
};
const profile = (changes: Partial<WorkProfile> = {}): WorkProfile => ({
  traceId: 'guard', request: { service: 'main', route: '/v1/recipes/works/:id', status: 200 },
  mainCalls: 0, fusekiRequests: 27, fusekiSentBytes: 50_981, fusekiReceivedBytes: 11_744,
  fusekiEngineMs: 0, postgresStatements: 76, accountCalls: 0, otherFetches: 0,
  unclassifiedFetches: 0, serverLatencyMs: 1, totalLatencyMs: 1,
  nativeVisits: {}, nativeVisitTotal: 0,
  fusekiCalls: [], postgres: [], unobserved: [], spans: [], ...changes,
});
const samples = (scales: number[], changes: Partial<WorkProfile>[] = []) =>
  scales.map((n, i) => recipeCostSample(profile(changes[i]), n));
const series = (): RecipeCostSeries => ({
  'published-reader': { firstPages: samples([4, 16, 64]), continuations: samples([16, 64, 64]) },
  'author-preview': { firstPages: samples([4, 16, 64]), continuations: samples([16, 64, 64]) },
});
const page = (offset = 0): RecipePage => ({
  profile: 'recipe-work-page-v1', structure: census.structure, revision: census.revision,
  occurrences: census.occurrenceOrder.slice(offset, offset + K).map(occurrence => ({ occurrence, role: 'ingredient' })),
  ...(offset + K < census.occurrences ? { next: 'next-cursor' } : {}),
  cost: { pages: 2, pagesRead: 16, occurrences: K },
});

// The shared verdict writes failure evidence; isolate intentional guard failures.
let artifactDirectory: string;
const previousArtifactDirectory = Bun.env.REZICS_QA_ARTIFACT_DIR;
beforeAll(() => {
  mkdirSync(resolve('.temp'), { recursive: true });
  artifactDirectory = mkdtempSync(resolve('.temp/recipe-growth-contract-'));
  Bun.env.REZICS_QA_ARTIFACT_DIR = artifactDirectory;
});
afterAll(() => {
  if (previousArtifactDirectory === undefined) delete Bun.env.REZICS_QA_ARTIFACT_DIR;
  else Bun.env.REZICS_QA_ARTIFACT_DIR = previousArtifactDirectory;
  rmSync(artifactDirectory, { recursive: true, force: true });
});

test('only independently listed Recipe keys at the restored origin receive the GET budget', () => {
  const own: RecipeFetch = { peer: 'other', origin, path: census.objectPaths[0]!, method: 'GET', count: 3 };
  const budgeted = budgetRecipeProfile(profile({ otherFetches: 3 }), [own], census, origin, K);
  expect(budgeted.budget.gets).toBe(3);
  expect(budgeted.profile.otherFetches).toBe(0);
  for (const foreign of [
    { ...own, path: prefix + 'b'.repeat(64) },
    { ...own, origin: 'http://unknown.test' },
    { ...own, path: '/v1/unrelated' },
    { ...own, method: 'POST' },
  ]) {
    const bad = budgetRecipeProfile(profile({ otherFetches: 6 }), [own, foreign], census, origin, K);
    expect(bad.budget.gets).toBe(3);
    const costs = series();
    costs['author-preview'].firstPages[2] = recipeCostSample(bad.profile, 64);
    expect(() => assertRecipeSeriesCosts(costs, contract)).toThrow('otherFetches');
  }
});

test('unknown peer classification remains forbidden', () => {
  const costs = series();
  costs['published-reader'].firstPages[2] = recipeCostSample(profile({ unclassifiedFetches: 1 }), 64);
  expect(() => assertRecipeSeriesCosts(costs, contract)).toThrow('unclassifiedFetches');
});

test('continuations use the same pairwise verdict: SQL 76 to 152 fails below the absolute cap', () => {
  for (const reader of ['author-preview', 'published-reader'] as const) {
    const costs = series();
    costs[reader].continuations = samples([16, 64, 64], [{}, { postgresStatements: 152 }, { postgresStatements: 152 }]);
    expect(() => assertRecipeSeriesCosts(costs, contract)).toThrow('postgresStatements (constant)');
  }
});

test('published-only growth fails even while every private-preview sample stays flat', () => {
  const costs = series();
  costs['published-reader'].firstPages = samples([4, 16, 64], [{}, {}, { fusekiRequests: 54 }]);
  expect(() => assertRecipeSeriesCosts(costs, contract)).toThrow('published-reader-first-page');
});

test('measured Main calls survive dimension attachment and participate in both verdicts', () => {
  expect(recipeCostSample(profile({ mainCalls: 7 }), 64).mainCalls).toBe(7);
  for (const reader of ['author-preview', 'published-reader'] as const) {
    for (const read of ['firstPages', 'continuations'] as const) {
      const costs = series();
      costs[reader][read][2] = recipeCostSample(profile({ mainCalls: 2 }), 64);
      expect(() => assertRecipeSeriesCosts(costs, contract)).toThrow('mainCalls (constant)');
    }
  }
});

test('first and continuation pages must match the independent ordered census completely', () => {
  for (const offset of [0, K, K * 2]) {
    expect(() => assertRecipePageComplete(page(offset), census, offset, K)).not.toThrow();
    for (const bad of [
      { ...page(offset), occurrences: page(offset).occurrences.slice(1) },
      { ...page(offset), occurrences: page(offset + K).occurrences },
      { ...page(offset), occurrences: [...page(offset).occurrences].reverse() },
      { ...page(offset), next: undefined },
      { ...page(offset), revision: 'different-revision' },
    ]) expect(() => assertRecipePageComplete(bad, census, offset, K)).toThrow();
  }
  expect(() => assertRecipePageComplete(page(K * 3), census, K * 3, K)).not.toThrow();
  expect(() => assertRecipePageComplete({ ...page(K * 3), next: 'extra' }, census, K * 3, K)).toThrow();
});

test('published reads omit all author authority while preview preserves it and trace context', () => {
  const href = '/v1/recipes/works/recipe?actingSubject=stale-author';
  const headers = new Headers({ authorization: 'stale', cookie: 'session=stale', traceparent: 'trace' });
  const author = { token: 'author-token', actor: 'author-actor' };
  const publicRead = recipeReaderRequest(href, 'published-reader', author, headers, 'cursor');
  expect(publicRead.headers.has('authorization')).toBe(false);
  expect(publicRead.headers.has('cookie')).toBe(false);
  // Main handles this Request in process; absence of bearer/cookie headers
  // proves signed-out dispatch. Bun does not expose RequestInit.credentials.
  expect(new URL(publicRead.url).searchParams.has('actingSubject')).toBe(false);
  expect(new URL(publicRead.url).searchParams.get('cursor')).toBe('cursor');
  expect(publicRead.headers.get('traceparent')).toBe('trace');
  const preview = recipeReaderRequest(href, 'author-preview', author, headers);
  expect(preview.headers.get('authorization')).toBe('Bearer author-token');
  expect(new URL(preview.url).searchParams.get('actingSubject')).toBe('author-actor');
  expect(() => recipeReaderRequest('http://foreign.test/v1/recipes/works/recipe', 'published-reader', author, headers)).toThrow();
});

test('a primed verified cache cannot hide either first or continuation object reads', async () => {
  const bytes = new TextEncoder().encode('verified recipe node');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const previousFetch = globalThis.fetch;
  let gets = 0;
  globalThis.fetch = Object.assign(async () => { gets++; return new Response(bytes); }, previousFetch);
  clearVerifiedImmutableObjectCache();
  try {
    const objects = new S3ImmutableObjects({ endpoint: origin, bucket: 'rezics-semantic',
      prefix: 'semantic/structure/', accessKeyId: 'fixture', secretAccessKey: 'fixture' });
    rememberVerifiedImmutableObject(digest, bytes);
    await objects.get(digest);
    expect(gets).toBe(0);
    await coldRecipeRequest(() => objects.get(digest));
    await coldRecipeRequest(() => objects.get(digest));
    expect(gets).toBe(2);
  } finally { globalThis.fetch = previousFetch; clearVerifiedImmutableObjectCache(); }
});

test('object allowance is the owner minimum, and full-walk discrimination depends on independent size', () => {
  expect(recipeObjectBudget(census, K).maximumDistinctKeys).toBe(16);
  expect(recipeObjectBudget(census, K).fullWalkDetectable).toBe(false);
  const larger = recipeObjectBudget({ ...census, nodeCount: K * 3 }, K);
  expect(larger.maximumDistinctKeys).toBe(K * 2);
  expect(larger.fullWalkDetectable).toBe(true);
});

test('distinct keys stay bounded while only one duplicated manifest GET is allowed', () => {
  const keys = ['a', 'b', 'c'].map(letter => prefix + letter.repeat(64));
  const small = { ...census, depth: 0, nodeCount: 3, objectPaths: keys };
  const inventory = keys.map((path, index) => ({ peer: 'other', origin, path, method: 'GET', count: index === 0 ? 2 : 1 }));
  const { budget } = budgetRecipeProfile(profile({ otherFetches: 4 }), inventory, small, origin, K);
  expect(budget.distinctKeys).toBe(3);
  expect(budget.gets).toBe(4);
  expect(() => assertRecipeObjectBudget(budget)).not.toThrow();
  expect(() => assertRecipeObjectBudget({ ...budget, gets: 5 })).toThrow('duplicate manifest');
  const larger = budgetRecipeProfile(profile({ otherFetches: 4 }),
    [...inventory.map(item => ({ ...item, count: 1 })),
      { peer: 'other', origin, path: prefix + 'd'.repeat(64), method: 'GET', count: 1 }],
    { ...small, objectPaths: [...keys, prefix + 'd'.repeat(64)] }, origin, K);
  expect(() => assertRecipeObjectBudget(larger.budget)).toThrow('distinct Structure keys');
});

test('the executable growth check names missing depth and the real continuation coverage', () => {
  const todo = recipeSectionDepthTodo(STRUCTURE_LIMITS.maxDepth);
  expect(todo).toContain(`recipeSectionDepth at 1/${Math.floor(STRUCTURE_LIMITS.maxDepth / 2)}/${STRUCTURE_LIMITS.maxDepth}`);
  expect(todo).toContain('unit: one nested Recipe section ancestor');
  expect(todo).toContain('class: linear');
  expect(todo).toContain('because');
  expect(RECIPE_GROWTH_COVERAGE).toContain('depth: not covered');
  expect(RECIPE_GROWTH_COVERAGE).toContain('small has no continuation');
  const source = readFileSync(resolve('tests/qa/integration/recipe-page-growth.test.ts'), 'utf8');
  expect(source).toContain('test.todo(recipeSectionDepthTodo(STRUCTURE_LIMITS.maxDepth),');
  expect(source).toContain('coverage: RECIPE_GROWTH_COVERAGE');
});

test('a failed artifact write runs every teardown step and preserves the original failure', async () => {
  const original = new Error('request failed');
  const calls: string[] = [];
  const steps = ['write evidence', 'driver.stop', 'shutdownTelemetry', 'restore fetch', 'sink.stop']
    .map(name => ({ name, run: () => {
      calls.push(name);
      if (name === 'write evidence') throw new Error('disk full');
    } }));
  let caught: unknown;
  try { await finishRecipeGrowth(steps, { error: original }); } catch (error) { caught = error; }
  expect(caught).toBe(original);
  expect(calls).toEqual(steps.map(step => step.name));
});

test('cleanup failures never skip remaining resources even without a request failure', async () => {
  const calls: string[] = [];
  await expect(finishRecipeGrowth(['write evidence', 'driver.stop', 'shutdownTelemetry', 'sink.stop']
    .map(name => ({ name, run: () => { calls.push(name); throw new Error(name); } }))))
    .rejects.toThrow('Recipe growth artifacts or cleanup failed');
  expect(calls).toEqual(['write evidence', 'driver.stop', 'shutdownTelemetry', 'sink.stop']);
});
