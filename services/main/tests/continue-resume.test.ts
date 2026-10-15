import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { continueChapters } from '../src/modules/continue/chapters.ts';
import { readWorkResume } from '../src/modules/continue/read.ts';
import type { WorkProgress } from '../src/modules/library/status.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { COMPOSITION_PROFILE, orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const row = (values: Record<string, string>): ReadRow => Object.fromEntries(Object.entries(values)
  .map(([key, value]) => [key, { type: value.startsWith('https:') || value.startsWith('urn:') ? 'uri' : 'literal', value }]));

async function fixture(target = 'https://schema.org/DigitalDocument') {
  const work = id(), main = id(), structure = id(), revision = id(), generation = id(), agent = id();
  const principal = { issuer: 'https://account.test', subject: 'reader', emailVerified: true };
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async body => {
      const digest = createHash('sha256').update(body).digest('hex');
      stored.set(digest, body);
      return digest;
    },
    get: async digest => {
      const body = stored.get(digest);
      if (!body) throw new ObjectUnavailable('missing composition object');
      return body;
    },
  };
  const chapters: OccurrenceRecord[] = [1, 2].map(number => ({ occurrence: id(), state: 'active',
    parent: structure, segmentKey: 'a', orderKey: String(number), role: 'chapter', target,
    ...(target.startsWith('https://rezics.com/id/') ? { selection: { mode: 'follow-context' as const } } : {}),
    introducedBy: revision, labels: [{ value: `Chapter ${number}`, language: 'en' }] }));
  const cost = newCost();
  const entries = chapters.map(record => ({ parent: record.parent, segmentKey: record.segmentKey!,
    orderKey: record.orderKey!, occurrence: record.occurrence }));
  const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: main,
    profile: 'book-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).apply(await recordTree(objects).empty(cost),
      new Map(chapters.map(record => [record.occurrence, record])), cost),
    order: await orderTree(objects).apply(await orderTree(objects).empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: 2, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
  const reference = `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify(manifest)))}`;
  let saved: WorkProgress | undefined, progressReads = 0, own = true, readable = true, published = false;
  let afterProgress: (() => void) | undefined, afterWork: (() => void) | undefined;
  const publicationQueries: string[] = [];
  const session = {
    principal, options: { actingSubject: agent }, position: { dataEpoch: 'test', sequence: '1' },
    summaries: async () => [{ status: 'available', type: 'work' }],
    deps: {
      access: {
        canReadAsBaselineMember: async () => own,
        canReadWork: async () => { const result = readable; afterWork?.(); return result; },
      },
      libraryStatus: { progress: async (reader: string, structures: string[]) => {
        expect(reader).toEqual(agent);
        expect(structures).toEqual([structure]);
        progressReads++;
        const result = new Map(saved ? [[structure, saved]] : []);
        afterProgress?.();
        return result;
      } },
      environment: { structureObjects: objects, fuseki: { query: async (query: string) => {
        const values: Record<string, string> = query.includes('SELECT ?component')
          ? { component: main, profile: 'https://rezics.com/vocab/BookComposition', head: revision,
            generation, count: '2', manifest: reference }
          : query.includes('SELECT ?owner') ? { owner: work }
          : { manifest: reference, count: '2', epoch: 'test', sequence: '1' };
        return { results: { bindings: [row(values)] } };
      } } },
    },
    query: async (query: string) => {
      if (query.includes('SELECT ?work ?main ?structure')) return [row({ work, main, structure, language: 'en' })];
      if (query.includes('SELECT DISTINCT ?structure')) return [];
      publicationQueries.push(query);
      return published ? [row({ target, language: 'en', revision: 'urn:rezics:content:revision:published', variant: id() })] : [];
    },
  } as unknown as WorkReadSession;
  const save = (index: number, completed: boolean) => {
    saved = { structure, occurrence: chapters[index]!.occurrence, selectedRevision: null,
      completed, position: completed ? null : 'paragraph two', version: 1, changedAt: '2026-10-13T00:00:00Z' };
  };
  return { session, principal, agent, work, chapters, save, publicationQueries,
    resume: () => readWorkResume(session, principal, agent, work),
    reads: () => progressReads, publish: () => { published = true; },
    denyPerson: () => { own = false; }, denyWork: () => { readable = false; },
    onProgress: (callback: () => void) => { afterProgress = callback; },
    onWork: (callback: () => void) => { afterWork = callback; } };
}

test.each(['https://schema.org/DigitalDocument', 'https://schema.org/Book'])(
  'direct resume follows catalog chapter placements for %s through completion', async target => {
    const f = await fixture(target), first = f.chapters[0]!.occurrence, second = f.chapters[1]!.occurrence;
    expect(await f.resume()).toMatchObject({ lastPosition: null,
      nextUnread: { occurrence: first, title: 'Chapter 1' }, unreadCount: { value: 2, kind: 'exact' } });
    f.save(0, false);
    expect(await f.resume()).toMatchObject({ lastPosition: { occurrence: first, position: 'paragraph two' },
      nextUnread: { occurrence: first } });
    f.save(0, true);
    expect(await f.resume()).toMatchObject({ lastPosition: { occurrence: first, completed: true },
      nextUnread: { occurrence: second, title: 'Chapter 2' }, unreadCount: { value: 1, kind: 'exact' } });
    f.save(1, true);
    expect(await f.resume()).toMatchObject({ nextUnread: null, unreadCount: null });
    expect(f.publicationQueries).toEqual([]);
    expect((await continueChapters(f.session, f.session.options.actingSubject!, [f.work])).chapters.size).toBe(0);
  });

test('ranked Continue omits catalog placements and native resume still requires publication', async () => {
  const catalog = await fixture();
  expect((await continueChapters(catalog.session, catalog.session.options.actingSubject!, [catalog.work])).chapters.size).toBe(0);
  expect(catalog.publicationQueries).toEqual([]);
  const native = await fixture(id());
  expect(await native.resume()).toMatchObject({ nextUnread: null, unreadCount: null });
  expect(native.publicationQueries).toHaveLength(1);
  native.publish();
  expect(await native.resume()).toMatchObject({ nextUnread: { occurrence: native.chapters[0]!.occurrence } });
});

test('catalog resume retains the progress race and Person/Work authority close', async () => {
  const raced = await fixture();
  raced.onProgress(() => raced.save(0, true));
  await expect(raced.resume()).rejects.toBeInstanceOf(WorkReadMoved);
  expect(raced.reads()).toBe(2);
  const denied = await fixture();
  denied.denyPerson();
  await expect(denied.resume()).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(denied.reads()).toBe(0);
  const revokedPerson = await fixture();
  revokedPerson.onProgress(revokedPerson.denyPerson);
  await expect(revokedPerson.resume()).rejects.toBeInstanceOf(WorkReadMoved);
  const missing = await fixture();
  missing.denyWork();
  await expect(missing.resume()).rejects.toBeInstanceOf(WorkReadMissing);
  const revokedWork = await fixture();
  revokedWork.onWork(revokedWork.denyWork);
  await expect(revokedWork.resume()).rejects.toBeInstanceOf(WorkReadMoved);
});
