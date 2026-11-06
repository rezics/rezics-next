import { expect } from 'bun:test';
import assert from 'node:assert/strict';
import { planReads, platformRegistry, readCost, type CompositionDocument } from '@rezics/composition';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionMemberView } from '../../../../../specs/dynamic-collections-driver.ts';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
import type { SearchHit } from '../../../src/search/hits.ts';
import type {
  PublicFilterConsumerCaptureInput,
  PublicFilterConsumerContext,
} from '../../../src/search/public-filter-consumer-contract.ts';
import { discoveryKey, type DiscoveryPersona } from '../../support/released-discovery.ts';
import {
  PAGE_SLOTS,
  REQUESTED_SIZE,
  expectPageBudget,
  expectPreparationStep,
  planKind,
  sumCosts,
  type PlanEvidence,
  type SnapshotKind,
} from './composed-discovery-bounds.ts';
import {
  occurrenceSubjectIds,
  orderedByLabel,
  requireStatus,
  type ComposedDiscoveryWorld,
  type StatusResponse,
} from './composed-discovery-fixtures.ts';
import {
  admitsAnonymous,
  deepFilter,
  deepSubjectNames,
  emptyFilter,
  isCanonicalSurface,
  jobFilter,
  jobSubjectNames,
  jobType,
  personasFor,
  type DiscoverySurface,
  type PublicJob,
  type PublicPersona,
} from './composed-discovery-matrix.ts';

export type NativeListRead = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const deadlineMs = 60_000;

function context(): PublicFilterConsumerContext {
  return { deadline: Date.now() + deadlineMs };
}

function capturePlan(filter: FilterDocument): PublicFilterConsumerCaptureInput {
  return { sort: 'id', size: REQUESTED_SIZE, pageSize: PAGE_SLOTS, text: undefined, filterDocument: filter };
}

export async function nativePlan(
  world: ComposedDiscoveryWorld,
  filter: FilterDocument,
  snapshot: SnapshotKind,
): Promise<PlanEvidence> {
  const native = world.fixture.search;
  if (!native) throw new Error('The default native Search consumer is unavailable');
  const request = { plan: capturePlan(filter), snapshot } as const;
  const bound = await native.bindRequest(request, context());
  const pageCosts = [];
  const preparationCosts = [];
  let preparationSteps = 0;
  let rereads = 0;
  let capture = bound.capture;
  try {
    for (let attempt = 0; attempt < 256; attempt++) {
      if (capture.status === 'preparing') {
        preparationCosts.push(capture.cost);
        const step = await bound.operations.repairStep(capture.repair, context());
        if (step.status !== 'progress' && step.status !== 'settled')
          throw new Error(`Native public preparation unavailable: ${JSON.stringify(step)}`);
        expectPreparationStep(step.cost);
        preparationCosts.push(step.cost);
        preparationSteps++;
        capture = await bound.operations.capture(request, context());
        continue;
      }
      if (capture.status !== 'captured') throw new Error(`Native public plan unavailable: ${JSON.stringify(capture)}`);
      expect(capture.queried.snapshot.kind).toBe(snapshot);
      pageCosts.push(capture.cost);
      const result = await bound.operations.query(capture.queried, context());
      pageCosts.push(result.cost);
      if (result.status === 'preparing') {
        const step = await bound.operations.repairStep(capture.repair, context());
        if (step.status !== 'progress' && step.status !== 'settled')
          throw new Error(`Native public preparation unavailable: ${JSON.stringify(step)}`);
        expectPreparationStep(step.cost);
        preparationCosts.push(step.cost);
        preparationSteps++;
        rereads++;
        capture = await bound.operations.capture(request, context());
        continue;
      }
      if (result.status !== 'queried') throw new Error(`Native public query unavailable: ${JSON.stringify(result)}`);
      await bound.operations.closeObservation(result.queried, context());
      const rejected = Math.max(0, result.window.examined - result.result.hits.length);
      return {
        ids: result.result.hits.map(({ id }) => id),
        examined: result.window.examined,
        exhausted: result.window.exhausted,
        pageCost: sumCosts(pageCosts),
        preparationCost: sumCosts(preparationCosts),
        preparationSteps,
        snapshot,
        rejectedCandidates: rejected,
        rereads,
      };
    }
    throw new Error('Native public plan did not reach a bounded useful result');
  } finally {
    await bound.operations.close();
  }
}

export async function resumePrepared(
  world: ComposedDiscoveryWorld,
  filter: FilterDocument,
): Promise<PlanEvidence> {
  const native = world.fixture.search;
  if (!native) throw new Error('The default native Search consumer is unavailable');
  const request = { plan: capturePlan(filter), snapshot: 'prepared' as const };
  const first = await native.bindRequest(request, context());
  let interruptedKeys = 0;
  try {
    if (first.capture.status === 'preparing') {
      const step = await first.operations.repairStep(first.capture.repair, context());
      if (step.status !== 'progress' && step.status !== 'settled')
        throw new Error(`Native public preparation unavailable: ${JSON.stringify(step)}`);
      expectPreparationStep(step.cost);
      interruptedKeys = step.cost.inputKeys;
    } else if (first.capture.status === 'captured') {
      await first.operations.closeObservation(first.capture.queried, context());
    } else throw new Error(`Native public plan unavailable: ${JSON.stringify(first.capture)}`);
  } finally {
    await first.operations.close();
  }
  const resumed = await nativePlan(world, filter, 'prepared');
  expect(resumed.rereads).toBeLessThanOrEqual(1);
  if (interruptedKeys) expect(resumed.preparationCost.inputKeys).toBeGreaterThanOrEqual(interruptedKeys);
  return resumed;
}

export async function revokeDuringPreparation(
  world: ComposedDiscoveryWorld,
  filter: FilterDocument,
  snapshot: SnapshotKind,
): Promise<PlanEvidence> {
  const native = world.fixture.search;
  if (!native) throw new Error('The default native Search consumer is unavailable');
  await native.indexing('paused');
  const fact = world.books.facts.find(
    (entry) => entry.subject === world.books.subjects['B-long'].id && entry.property === 'schema:keywords',
  );
  assert(fact);
  const bound = await native.bindRequest({ plan: capturePlan(filter), snapshot }, context());
  try {
    requireStatus(
      await world.fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${world.books.subjects['B-long'].id}/candidates/${fact.candidate}:hide`,
        { reason: 'Revoke current discovery dependency before disclosure' },
        discoveryKey(),
      ),
      200,
      'Hide current harem keyword',
    );
    if (bound.capture.status === 'preparing') {
      const step = await bound.operations.repairStep(bound.capture.repair, context());
      if (step.status !== 'progress' && step.status !== 'settled')
        throw new Error(`Native public preparation unavailable: ${JSON.stringify(step)}`);
      expectPreparationStep(step.cost);
    }
  } finally {
    await bound.operations.close();
    await native.indexing('running');
  }
  try {
    const measured = await nativePlan(world, filter, snapshot);
    expect(measured.ids).not.toContain(world.books.subjects['B-long'].id);
    return measured;
  } finally {
    requireStatus(
      await world.fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${world.books.subjects['B-long'].id}/candidates/${fact.candidate}:restore`,
        { reason: 'Restore current harem keyword after revocation' },
        discoveryKey(),
      ),
      200,
      'Restore current harem keyword',
    );
    await world.fixture.catchUp([world.books.subjects['B-long']]);
  }
}

function preparing(response: HttpResponse) {
  expect(response.status, JSON.stringify(response.body)).toBe(503);
  expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code);
  expect(response.headers.get('retry-after')).toBeTruthy();
  for (const key of ['subjects', 'members', 'next', 'total', 'count', 'as_of', 'job', 'repair'])
    expect(response.body).not.toHaveProperty(key);
}

function collectionReadiness(response: HttpResponse) {
  if (response.status === 503) preparing(response);
  else {
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body).toEqual({ preparing: true });
    expect(response.headers.get('retry-after')).toBeTruthy();
  }
}

function countFreeList(body: Record<string, unknown>) {
  for (const key of ['total', 'totals', 'count', 'estimate', 'observation', 'execution', 'job'])
    expect(body).not.toHaveProperty(key);
}

export async function cataloguePages(
  world: ComposedDiscoveryWorld,
  persona: DiscoveryPersona,
  filter: FilterDocument,
  expected?: readonly string[],
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  const until = Date.now() + deadlineMs;
  do {
    let response: StatusResponse;
    for (;;) {
      response = await world.fixture.request(persona, 'POST', '/v1/subjects:search', {
        filter,
        sort: 'id',
        limit: PAGE_SLOTS,
        ...(cursor ? { cursor } : {}),
      });
      if (response.status === 200) break;
      preparing(response);
      assert(Date.now() < until, `Catalogue preparation did not finish: ${JSON.stringify(response.body)}`);
      await Bun.sleep(25);
    }
    const rows = response.body.subjects as SearchHit[];
    assert(Array.isArray(rows));
    assert(response.body.next === null || typeof response.body.next === 'string');
    if (response.body.next !== null) expect(rows).toHaveLength(PAGE_SLOTS);
    expect(rows.length).toBeLessThanOrEqual(PAGE_SLOTS);
    ids.push(...rows.map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    cursor = response.body.next ?? undefined;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
    pages++;
    expect(pages).toBeLessThanOrEqual(16);
  } while (cursor);
  if (expected) expect(ids).toEqual([...expected].sort());
  else expect(ids).toEqual([...ids].sort());
  return { ids, pages };
}

function collectionPath(collectionId: string, filter: FilterDocument, cursor?: string): string {
  const query = new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', limit: String(PAGE_SLOTS) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return `/v1/collections/${collectionId}/members?${query}`;
}

export async function collectionPages(
  world: ComposedDiscoveryWorld,
  persona: DiscoveryPersona,
  collectionId: string,
  filter: FilterDocument,
  expected: readonly string[],
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  const until = Date.now() + deadlineMs;
  do {
    let response: StatusResponse;
    for (;;) {
      response = await world.population.request(persona, 'GET', collectionPath(collectionId, filter, cursor));
      if (response.status === 200) break;
      collectionReadiness(response);
      assert(Date.now() < until, `Collection preparation did not finish: ${JSON.stringify(response.body)}`);
      await Bun.sleep(25);
    }
    countFreeList(response.body);
    const rows = response.body.members as CollectionMemberView[];
    assert(Array.isArray(rows));
    assert(response.body.next === null || typeof response.body.next === 'string');
    if (response.body.next !== null) expect(rows).toHaveLength(PAGE_SLOTS);
    ids.push(...rows.map(({ subjectId }) => subjectId));
    for (const row of rows) {
      const key = 'id' in row ? row.id : row.subjectId;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
    cursor = response.body.next ?? undefined;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
    pages++;
    expect(pages).toBeLessThanOrEqual(16);
  } while (cursor);
  expect([...ids].sort()).toEqual([...expected].sort());
  return { ids, pages };
}

function configuredRead(
  response: HttpResponse,
  document: CompositionDocument,
  node: string,
  continuation?: { node: string; cursor: string },
): NativeListRead {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.document).toEqual(document);
  const plan = planReads(platformRegistry, document, { subject: null, ...(continuation ? { continuation } : {}) });
  const reads = response.body.reads as Record<string, NativeListRead>;
  const result = reads[plan.nodes[node]!];
  assert(result);
  return result;
}

async function configuredPages(
  world: ComposedDiscoveryWorld,
  persona: DiscoveryPersona,
  requestPage: (persona: DiscoveryPersona, cursor?: string) => Promise<StatusResponse>,
  document: CompositionDocument,
  node: string,
  expected: readonly string[],
  zone: boolean,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  const until = Date.now() + deadlineMs;
  const selected = orderedByLabel(expected, world.labels);
  do {
    let result: NativeListRead;
    for (;;) {
      const response = await requestPage(persona, cursor);
      if (response.status === 200) {
        result = configuredRead(
          response,
          document,
          node,
          !zone && cursor ? { node, cursor } : undefined,
        );
        if (result.status === 200) break;
        expect(result.status, JSON.stringify(result.body)).toBe(503);
        expect(['index_not_ready', 'semantic_not_ready']).toContain(result.body.code);
      } else if (zone && response.status === 202) {
        expect(Object.keys(response.body)).toEqual(['next']);
        assert(typeof response.body.next === 'string');
        expect(cursors.has(response.body.next)).toBe(false);
        cursors.add(response.body.next);
        cursor = response.body.next;
      } else preparing(response);
      assert(Date.now() < until, 'Configured list preparation did not finish');
      await Bun.sleep(25);
    }
    countFreeList(result.body);
    const rows = result.body.subjects as SearchHit[];
    assert(Array.isArray(rows));
    expect(rows.map(({ id }) => id)).toEqual(selected.slice(pages * PAGE_SLOTS, pages * PAGE_SLOTS + PAGE_SLOTS));
    ids.push(...rows.map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    if (result.body.next === null) {
      expect(ids).toEqual(selected);
      return { ids, pages: pages + 1 };
    }
    expect(rows).toHaveLength(PAGE_SLOTS);
    assert(typeof result.body.next === 'string');
    expect(cursors.has(result.body.next)).toBe(false);
    cursor = result.body.next;
    cursors.add(cursor);
    pages++;
    expect(pages).toBeLessThanOrEqual(16);
  } while (cursor);
  throw new Error('Configured list did not exhaust');
}

function collectionId(world: ComposedDiscoveryWorld, job: PublicJob, surface: DiscoverySurface): string {
  if (surface === 'curated-collection') return world.publicCollection.source.id;
  if (surface === 'everything-without-state') return world.everythingId;
  if (surface === 'own-state') return world.ownStateIds[jobType(job)];
  throw new Error(`${surface} is not a Collection consumer`);
}

export function expectedIds(
  world: ComposedDiscoveryWorld,
  job: PublicJob,
  surface: DiscoverySurface,
  kind: 'job' | 'deep' | 'empty' = 'job',
): string[] {
  if (kind === 'empty') return [];
  const names = kind === 'deep' ? deepSubjectNames(job) : jobSubjectNames(job);
  const ids = names.map((name) =>
    job === 'long-harem-light-novels'
      ? world.books.subjects[name as keyof typeof world.books.subjects].id
      : world.recipes.subjects[name as keyof typeof world.recipes.subjects].id,
  );
  if (surface === 'curated-collection') return occurrenceSubjectIds(world.publicCollection, ids);
  return isCanonicalSurface(surface) ? [...ids].sort() : ids;
}

export async function surfacePages(
  world: ComposedDiscoveryWorld,
  job: PublicJob,
  surface: DiscoverySurface,
  persona: PublicPersona,
  kind: 'job' | 'deep' | 'empty' = 'job',
): Promise<{ ids: string[]; pages: number }> {
  const filter =
    kind === 'empty'
      ? emptyFilter(job, world.classification.harem.id)
      : kind === 'deep'
        ? deepFilter(job, world.filters)
        : jobFilter(job, world.filters);
  const expected = expectedIds(world, job, surface, kind);
  if (surface === 'catalogue-direct' || surface === 'catalogue-prepared') {
    if (surface === 'catalogue-prepared' && kind !== 'empty') {
      const evidence = await nativePlan(world, filter, 'prepared');
      expectPageBudget(evidence, PAGE_SLOTS, REQUESTED_SIZE);
      expect(evidence.ids.length).toBeGreaterThan(0);
      expect([...evidence.ids].sort()).toEqual([...expectedIds(world, job, 'catalogue-direct', kind)].sort());
    }
    return cataloguePages(world, persona, filter, expectedIds(world, job, 'catalogue-direct', kind));
  }
  if (surface === 'curated-collection' || surface === 'everything-without-state' || surface === 'own-state')
    return collectionPages(world, persona, collectionId(world, job, surface), filter, expected);
  const emptyNode = job === 'long-harem-light-novels' ? 'recipe-harem' : 'empty-words';
  const useComposedEmpty = kind === 'empty';
  const document = useComposedEmpty ? world.documents.composed : world.documents[job];
  const node = useComposedEmpty ? emptyNode : 'works';
  const zoneId = useComposedEmpty ? world.zones.composed : world.zones[job];
  const selected = useComposedEmpty ? [] : expectedIds(world, job, 'catalogue-direct', 'job');
  if (surface === 'mounted-zone') {
    return configuredPages(
      world,
      persona,
      (who, cursor) =>
        world.population.request(
          who,
          'POST',
          `/v1/zones/${zoneId}:readPage${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
          { target: { route: '' }, languages: ['en'] },
        ),
      document,
      node,
      selected,
      true,
    );
  }
  if (useComposedEmpty) {
    return configuredPages(
      world,
      persona,
      (who, cursor) =>
        world.population.request(
          who,
          'POST',
          `/v1/zones/${world.zones.composed}:readPage${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
          { target: { route: '' }, languages: ['en'] },
        ),
      world.documents.composed,
      emptyNode,
      [],
      true,
    );
  }
  const route = world.typelistRoutes[job];
  return configuredPages(
    world,
    persona,
    (who, cursor) =>
      world.fixture.request(who, 'POST', '/v1/pages:read', {
        target: { route },
        languages: ['en'],
        ...(cursor ? { continuation: { node: 'works', cursor } } : {}),
      }),
    world.documents[job],
    'works',
    selected,
    false,
  );
}

export async function composedLimitPage(world: ComposedDiscoveryWorld, persona: PublicPersona) {
  const document = world.documents.composed;
  const plan = planReads(platformRegistry, document, { subject: null });
  expect(Object.keys(plan.reads)).toHaveLength(16);
  const until = Date.now() + deadlineMs;
  let response: StatusResponse;
  for (;;) {
    response = await world.population.request(persona, 'POST', `/v1/zones/${world.zones.composed}:readPage`, {
      target: { route: '' },
      languages: ['en'],
    });
    if (response.status === 200) {
      const reads = response.body.reads as Record<string, NativeListRead>;
      const pending = Object.values(reads).some((read) => read.status !== 200);
      if (!pending) break;
    } else if (response.status !== 202) preparing(response);
    assert(Date.now() < until, 'Composed 16-read page did not finish preparation');
    await Bun.sleep(25);
  }
  expect(response.body.document).toEqual(document);
  const reads = response.body.reads as Record<string, NativeListRead>;
  expect(Object.keys(reads)).toHaveLength(16);
  let slots = 0;
  for (const [key, read] of Object.entries(plan.reads)) {
    const result = reads[key];
    assert(result);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const rows = (result.body.subjects as SearchHit[] | undefined) ?? [];
    expect(rows.length).toBeLessThanOrEqual(readCost(read));
    slots += rows.length;
  }
  expect(slots).toBeLessThanOrEqual(128);
  const combined = await nativePlan(world, world.filters.combined, 'pit');
  const recipes = await nativePlan(world, world.filters.dietTime, 'pit');
  expectPageBudget(combined, PAGE_SLOTS, REQUESTED_SIZE);
  expectPageBudget(recipes, PAGE_SLOTS, REQUESTED_SIZE);
  return { reads: Object.keys(plan.reads).length, slots, combined, recipes };
}

export async function assertPublicCell(
  world: ComposedDiscoveryWorld,
  job: PublicJob,
  surface: DiscoverySurface,
) {
  for (const persona of personasFor(surface)) {
    const first = await surfacePages(world, job, surface, persona, 'job');
    expect(first.ids.length).toBeGreaterThan(0);
    const deep = await surfacePages(world, job, surface, persona, 'deep');
    if (
      (surface === 'catalogue-direct' ||
        surface === 'catalogue-prepared' ||
        surface === 'curated-collection' ||
        surface === 'everything-without-state' ||
        surface === 'own-state') &&
      deepSubjectNames(job).length > PAGE_SLOTS
    )
      expect(deep.pages).toBeGreaterThan(1);
    const empty = await surfacePages(world, job, surface, persona, 'empty');
    expect(empty.ids).toEqual([]);
    expect(empty.pages).toBe(1);
  }
  if (surface === 'catalogue-direct' || surface === 'catalogue-prepared') {
    const evidence = await nativePlan(
      world,
      jobFilter(job, world.filters),
      surface === 'catalogue-direct' ? 'pit' : 'prepared',
    );
    expectPageBudget(evidence, PAGE_SLOTS, REQUESTED_SIZE);
    expect([...evidence.ids].sort()).toEqual(expectedIds(world, job, 'catalogue-direct'));
    expect(evidence.examined).toBeGreaterThan(0);
    expect(planKind(evidence.snapshot)).toBe(surface === 'catalogue-direct' ? 'direct' : 'ready');
  }
}

export async function assertDenied(world: ComposedDiscoveryWorld, surface: DiscoverySurface, job: PublicJob) {
  if (admitsAnonymous(surface)) {
    const response = await world.fixture.request('anonymous', 'POST', '/v1/subjects:search', {
      filter: { owner: { presence: true } },
      sort: 'id',
      limit: PAGE_SLOTS,
    });
    expect([400, 403, 422], JSON.stringify(response.body)).toContain(response.status);
    return;
  }
  const response = await world.population.request(
    'anonymous',
    'GET',
    collectionPath(collectionId(world, job, surface), jobFilter(job, world.filters)),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(404);
}
