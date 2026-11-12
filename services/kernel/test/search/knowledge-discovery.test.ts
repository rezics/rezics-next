import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import type { KnowledgeDiscoverySource, KnowledgeDiscoverySummary } from '../../src/content/index.ts';
import {
  createKnowledgeDiscovery, KNOWLEDGE_DISCOVERY_LIFETIME_MS,
  type KnowledgeAssociation, type KnowledgeDiscoveryPage, type KnowledgeDiscoveryStore, type KnowledgePreparation,
} from '../../src/search/knowledge-discovery.ts';

const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(37)]]) };
const context = { deadline: Date.now() + 60_000 };
const subjectId = newId(4);
function association(index: number): KnowledgeAssociation {
  return { subjectId, documentId: newId(32), publicationId: newId(32), revisionId: newId(32),
    publishedAt: new Date(Date.UTC(2026, 10, 13, 0, 0, 0) - index * 1000).toISOString(), sequence: String(index + 1) };
}
function setup(count: number, visible: (index: number) => boolean = () => true) {
  const rows = Array.from({ length: count }, (_, index) => association(index));
  const summaries = new Map(rows.filter((_, index) => visible(index)).map((row) => [row.publicationId,
    { ...row, title: `Published ${row.sequence}`, language: 'en', licence: 'MIT', sha256: 'a'.repeat(64) }]));
  const preparations = new Map<string, KnowledgePreparation>();
  const reads: number[] = [];
  let time = Date.UTC(2026, 10, 13);
  let available = true;
  let publicSubject = true;
  let unavailableId: string | undefined;
  let cut: string | null = String(count);
  const store: KnowledgeDiscoveryStore = {
    id: randomUUID,
    cut: async () => cut,
    async page(_subject, after, limit) {
      reads.push(limit);
      const start = after ? rows.findIndex((row) => row.publicationId === after.publicationId) + 1 : 0;
      return rows.slice(start, start + limit);
    },
    load: async (id) => preparations.get(id) ?? null,
    async save(record, revision) {
      if (revision !== null && preparations.get(record.id)?.revision !== revision) return false;
      preparations.set(record.id, structuredClone(record));
      return true;
    },
  };
  const source: KnowledgeDiscoverySource = {
    subject: async () => !available ? 'unavailable' : publicSubject ? 'available' : 'withheld',
    selected: async (documentId, publicationId) => rows.find((row) => row.documentId === documentId && row.publicationId === publicationId) ?? null,
    async current(candidate) {
      if (candidate.publicationId === unavailableId) return { status: 'unavailable' };
      const row = summaries.get(candidate.publicationId);
      if (!row) return { status: 'ready', value: null };
      const { sequence: _sequence, ...value } = row;
      return { status: 'ready', value };
    },
  };
  const discover = createKnowledgeDiscovery({ store, source, tokens: ring, now: () => time });
  return { rows, summaries, preparations, reads, source, store, discover,
    advance: (ms: number) => { time += ms; },
    unavailable: (id?: string) => { unavailableId = id; },
    setAvailable: (value: boolean) => { available = value; },
    setSubject: (value: boolean) => { publicSubject = value; },
    setCut: (value: string | null) => { cut = value; },
  };
}
function next(page: KnowledgeDiscoveryPage): string {
  if (page.state === 'unavailable' || !page.next) throw new Error('Expected a usable continuation');
  return page.next;
}
function documents(page: KnowledgeDiscoveryPage): readonly KnowledgeDiscoverySummary[] {
  if (page.state !== 'ready') throw new Error('Expected a useful ready page');
  return page.documents;
}

test('sparse fixed-cut progress fills a useful page, rechecks settled nominations and excludes late adds', async () => {
  const f = setup(180, (index) => index < 6 || index >= 162);
  const first = await f.discover(subjectId, 'anonymous', {}, context);
  expect(first.state).toBe('preparing');
  expect(first).not.toHaveProperty('documents');
  expect([...f.preparations.values()][0]!.candidates).toHaveLength(6);
  f.summaries.delete(f.rows[0]!.publicationId); // withdraw while indexing is paused
  f.summaries.delete(f.rows[1]!.publicationId); // replaced old selection stays indexed
  const late = { ...association(140), sequence: '181' };
  f.rows.splice(140, 0, late);
  f.summaries.set(late.publicationId, { ...late, title: 'Late old timestamp', language: 'en', licence: 'MIT', sha256: 'b'.repeat(64) });
  const page = await f.discover(subjectId, 'anonymous', { cursor: next(first) }, context);
  expect(documents(page)).toHaveLength(20);
  expect(documents(page).map((row) => row.publicationId)).toEqual([
    ...f.rows.slice(2, 6), ...f.rows.slice(163, 179),
  ].map((row) => row.publicationId));
  expect(documents(page).some((row) => row.publicationId === late.publicationId)).toBe(false);
  const last = await f.discover(subjectId, 'anonymous', { cursor: next(page) }, context);
  expect(documents(last)).toHaveLength(2);
  expect(last).toMatchObject({ state: 'ready', next: null });
  expect(f.reads.every((limit) => limit <= 129)).toBe(true);
  expect(page).not.toHaveProperty('total');
  expect(documents(page)[0]).not.toHaveProperty('sequence');
});

test('final disclosure withdrawal resumes after examined candidates instead of returning a short page', async () => {
  const f = setup(3);
  const original = f.source.current;
  const calls = new Map<string, number>();
  const source: KnowledgeDiscoverySource = { ...f.source, async current(candidate, context) {
    const count = (calls.get(candidate.publicationId) ?? 0) + 1;
    calls.set(candidate.publicationId, count);
    if (candidate.publicationId === f.rows[0]!.publicationId && count === 2)
      f.summaries.delete(candidate.publicationId);
    return original(candidate, context);
  } };
  const discover = createKnowledgeDiscovery({ store: f.store, source, tokens: ring, now: () => Date.UTC(2026, 10, 13) });
  const first = await discover(subjectId, 'anonymous', { limit: 2 }, context);
  expect(first.state).toBe('preparing');
  const resumed = await discover(subjectId, 'anonymous', { limit: 2, cursor: next(first) }, context);
  expect(documents(resumed).map((row) => row.documentId)).toEqual(f.rows.slice(1).map((row) => row.documentId));
  expect(resumed).toMatchObject({ next: null });
});

test('empty and fully stale observations exhaust, while missing index/source evidence stays unavailable', async () => {
  const empty = setup(0);
  expect(await empty.discover(subjectId, 'anonymous', {}, context)).toEqual({ state: 'ready', documents: [], next: null });
  const stale = setup(260, () => false);
  let page = await stale.discover(subjectId, 'anonymous', {}, context);
  expect(page.state).toBe('preparing');
  page = await stale.discover(subjectId, 'anonymous', { cursor: next(page) }, context);
  expect(page.state).toBe('preparing');
  page = await stale.discover(subjectId, 'anonymous', { cursor: next(page) }, context);
  expect(page).toEqual({ state: 'ready', documents: [], next: null });
  empty.setCut(null);
  expect(await empty.discover(subjectId, 'anonymous', {}, context)).toEqual({ state: 'unavailable' });
  const f = setup(2);
  f.unavailable(f.rows[0]!.publicationId);
  expect(await f.discover(subjectId, 'anonymous', {}, context)).toEqual({ state: 'unavailable' });
  expect(f.preparations.size).toBe(0);
  f.unavailable();
  f.setAvailable(false);
  expect(await f.discover(subjectId, 'anonymous', {}, context)).toEqual({ state: 'unavailable' });
  const missing = createKnowledgeDiscovery({ store: f.store, tokens: ring, now: Date.now });
  expect(await missing(subjectId, 'anonymous', {}, context)).toEqual({ state: 'unavailable' });
});

test('continuations bind the viewer, Subject and page size, expire, and reject consumed revisions', async () => {
  const f = setup(300, () => false);
  const first = await f.discover(subjectId, 'anonymous', {}, context);
  const cursor = next(first);
  expect(cursor).not.toContain(subjectId);
  expect(cursor).not.toContain(f.rows[0]!.documentId);
  for (const [subject, principal, request] of [
    [newId(4), 'anonymous', { cursor }],
    [subjectId, `account:${newId(16)}`, { cursor }],
    [subjectId, 'anonymous', { cursor, limit: 1 }],
    [subjectId, 'anonymous', { cursor: `${cursor.slice(0, -8)}tampered` }],
  ] as const) {
    await expect(f.discover(subject, principal, request, context)).rejects.toMatchObject({ code: 'invalid_request' });
  }
  await f.discover(subjectId, 'anonymous', { cursor }, context);
  await expect(f.discover(subjectId, 'anonymous', { cursor }, context)).rejects.toMatchObject({ code: 'search_restart_required' });
  f.advance(KNOWLEDGE_DISCOVERY_LIFETIME_MS + 1);
  await expect(f.discover(subjectId, 'anonymous', { cursor }, context)).rejects.toMatchObject({ code: 'invalid_request' });
  const revoked = setup(140, () => false);
  const preparation = await revoked.discover(subjectId, 'anonymous', {}, context);
  revoked.setSubject(false);
  await expect(revoked.discover(subjectId, 'anonymous', { cursor: next(preparation) }, context))
    .rejects.toMatchObject({ code: 'search_restart_required' });
});
