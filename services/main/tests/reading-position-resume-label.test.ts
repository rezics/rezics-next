import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { readingPositionsRoutes } from '../src/routes/reading-positions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { type ReadingOccurrence, READING_POSITION_COST } from '../src/modules/reading-position/boundary.ts';
import { RV } from '../src/modules/work/activate.ts';
import type { ReadRow } from '../src/modules/work/read-session.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { COMPOSITION_PROFILE, orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_LIMITS, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OccurrenceRecord, type OrderEntry } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { readingResumeOwner, type ResumeCompletion } from './reading-resume-owner.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ type: 'literal' as const, value });
const key = (index: number) => String(index).padStart(5, '0');
const actor = id();

interface Chapter extends ReadingOccurrence { /** The graph shows no label for this occurrence. */ withholdLabel?: boolean; /** A label row with no language, which a reader must not receive. */ namelessLabel?: boolean }

/** A book the way the order store and graph hold it. Label rows are answered only by the one-occurrence lookup. */
function fixture(chapters: readonly Chapter[]) {
  const [root] = chapters as [Chapter, ...Chapter[]];
  const work = root.work, structure = root.structure, revision = root.revision;
  let statements = 0, sql = 0;
  const queries: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = { put: async body => {
    const digest = createHash('sha256').update(body).digest('hex'); stored.set(digest, body); return digest;
  }, get: async digest => {
    const body = stored.get(digest);
    if (!body) throw new ObjectUnavailable('missing order object');
    return body;
  } };
  let manifestDigest = '';
  const component = id();
  const ready = (async () => {
    const cost = newCost();
    const entries = chapters.map((item): OrderEntry => ({ parent: item.parent, segmentKey: item.segmentKey,
      orderKey: item.orderKey, occurrence: item.occurrence }));
    const put = async (level: number, pageEntries: readonly unknown[]) =>
      `sha256:${await objects.put(new TextEncoder().encode(JSON.stringify({ format: STRUCTURE_PAGE_FORMAT, tree: 'order', level, entries: pageEntries })))}`;
    const branch = 32;
    let level = 0;
    let children: Array<{ page: string; count: number; first: string }> = [];
    const sorted = [...entries].sort((a, b) => orderTreeKey(a) < orderTreeKey(b) ? -1 : 1);
    for (let at = 0; at < sorted.length; at += branch) {
      const chunk = sorted.slice(at, at + branch);
      children.push({ page: await put(0, chunk), count: chunk.length, first: orderTreeKey(chunk[0]!) });
    }
    while (children.length > 1) {
      level++;
      if (level >= STRUCTURE_LIMITS.treeLevels) throw new Error('Reading order tree exceeds its depth');
      const parents: typeof children = [];
      for (let at = 0; at < children.length; at += branch) {
        const chunk = children.slice(at, at + branch);
        parents.push({ page: await put(level, chunk), count: chunk.reduce((total, child) => total + child.count, 0), first: chunk[0]!.first });
      }
      children = parents;
    }
    const order = children[0] ? { page: children[0].page, level, count: children[0].count } : await orderTree(objects).empty(cost);
    const records = new Map(chapters.map(item => {
      const record: OccurrenceRecord = { occurrence: item.occurrence, state: 'active', parent: item.parent,
        segmentKey: item.segmentKey, orderKey: item.orderKey, role: 'chapter', labels: [], introducedBy: revision,
        target: 'https://schema.org/DigitalDocument' };
      return [record.occurrence, record] as const;
    }));
    const recordRoot = await recordTree(objects).apply(await recordTree(objects).empty(cost), records, cost);
    const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: component,
      profile: 'book-composition' as const, generation: structure, pageFormat: STRUCTURE_PAGE_FORMAT,
      records: recordRoot, order, placementCount: order.count, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
    manifestDigest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  })();
  const byOccurrence = new Map(chapters.map(item => [item.occurrence, item]));
  const execute = (sparql: string): ReadRow[] => {
    const control = { epoch: binding('epoch'), sequence: binding('1') };
    if (sparql.includes('rv:structureHead') && sparql.includes('rv:placementCount')) {
      return [{ component: binding(component), profile: binding(`${RV}BookComposition`), head: binding(revision),
        generation: binding(structure), count: binding(String(chapters.length)), manifest: binding(`urn:rezics:sha256:${manifestDigest}`) }];
    }
    if (sparql.includes('SELECT ?owner')) return [{ owner: binding(work) }];
    if (sparql.includes('# reading-position:work\n')) {
      const resource = sparql.match(/BIND\(<([^>]+)> AS \?work\)/)?.[1];
      return resource === work ? [{ work: binding(work), structure: binding(structure),
        revision: binding(revision), generation: binding(structure) }] : [{ work: binding(resource ?? work) }];
    }
    if (sparql.includes('# reading-position:records')) {
      const values = sparql.match(/VALUES \?occurrence \{([^}]+)}/)?.[1] ?? '';
      return chapters.filter(item => values.includes(item.occurrence)).map(item => ({
        work: binding(item.work), structure: binding(item.structure), revision: binding(item.revision),
        occurrence: binding(item.occurrence), parent: binding(item.parent), segmentKey: binding(item.segmentKey),
        orderKey: binding(item.orderKey), role: binding(`${RV}ChapterRole`),
        target: binding(item.target ?? 'https://schema.org/DigitalDocument'),
      }));
    }
    if (sparql.includes('# reading-position:chapter-labels')) {
      const occurrence = sparql.match(/BIND\(<([^>]+)> AS \?occurrence\)/)?.[1];
      const item = occurrence ? byOccurrence.get(occurrence) : undefined;
      if (!item || item.withholdLabel) return [];
      if (item.namelessLabel) return [{ label: binding('private') }];
      const labels = item.labels ?? [];
      if (!labels.length && !item.displayLabel) return [{}];
      return (labels.length ? labels : [undefined]).map(label => ({
        ...(label ? { label: { ...binding(label.value), 'xml:lang': label.language } } : {}),
        ...(item.displayLabel ? { displayLabel: binding(item.displayLabel) } : {}),
      }));
    }
    if (sparql.includes('# reading-position:manifest')) {
      return [{ manifest: binding(`urn:rezics:sha256:${manifestDigest}`) }];
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const resources = sparql.match(/VALUES \?r \{([^}]+)}/)?.[1] ?? '';
      return [control, ...[work].filter(resource => resources.includes(resource)).map(resource => ({ ...control, r: binding(resource),
        work: binding(resource), type: binding('work'), public: binding('true'), label: { ...binding('Story'), 'xml:lang': 'en' } }))];
    }
    if (sparql.includes('SELECT ?work ?structure')) throw new Error('Full composition materialization is forbidden');
    return [control];
  };
  const completions: ResumeCompletion[] = [];
  const progress = readingResumeOwner(completions);
  const pool = progress.owner as unknown as { query: (sql: string, values?: unknown[]) => Promise<unknown> };
  const inner = pool.query.bind(pool);
  pool.query = async (text: string, values?: unknown[]) => { sql += 1; return inner(text, values); };
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, structureObjects: objects,
    fuseki: { commandHealth: async () => ({ instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: true }),
    query: async (sparql: string) => {
      await ready; queries.push(sparql);
      const bindings = execute(sparql); statements += bindings.length;
      return { results: { bindings } };
    } } },
    structureObjects: objects,
    access: { assertRecoveryOpen: async (): Promise<void> => undefined, activePrincipalId: async () => 'reader',
      canReadAsBaselineMember: async () => true },
    account: { verify: async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer reader') throw new AccountAssertionDenied('Unknown bearer');
      return { issuer: 'https://qa.test', subject: 'reader', emailVerified: true };
    } },
    readingPositions: { generation: async () => '1', privateSnapshot: async () => '1',
      lookup: async () => new Map(), required: async () => new Set() },
    progress,
  } as unknown as MainWorkDependencies;
  const app = new Elysia().use(readingPositionsRoutes(deps));
  const resume = async (chapter: number) => {
    const item = chapters[chapter - 1]!;
    completions.length = 0;
    completions.push({ agent: actor, structure, revision,
      occurrence: item.occurrence, orderKey: `${item.segmentKey}\u0002${item.orderKey}` });
    const before = { statements, sql, queries: queries.length };
    const response = await app.handle(new Request(
      `http://main.local/v1/reading-positions/${work.slice(-36)}?${new URLSearchParams({ position: 'mine', limit: '1', actingSubject: actor })}`,
      { headers: { authorization: 'Bearer reader' } }));
    const body = await response.json() as { items?: ReadingOccurrence[]; scope?: string; status?: number };
    const asked = queries.slice(before.queries);
    return { status: response.status, body, statements: statements - before.statements, sql: sql - before.sql,
      labelQueries: asked.filter(query => query.includes('# reading-position:chapter-labels')) };
  };
  return { chapters, resume };
}

function book(count: number, edit?: (chapters: Chapter[]) => void) {
  const work = id(), structure = id(), revision = id();
  const chapters: Chapter[] = Array.from({ length: count }, (_, index) => ({
    occurrence: id(), work, structure, revision, parent: structure, segmentKey: 'a', orderKey: key(index + 1),
    role: 'chapter', target: 'https://schema.org/DigitalDocument',
    labels: [{ value: `Chapter ${index + 1}`, language: 'en' }], displayLabel: `Chapter ${index + 1}`,
  }));
  edit?.(chapters);
  return fixture(chapters);
}

const unnamed = (item: ReadingOccurrence) => item.labels === undefined && item.displayLabel === undefined;

test('a 1,200-chapter book resumes at chapter 1,150 with that chapter\'s name', async () => {
  const f = book(1_200);
  const answer = await f.resume(1_150);
  expect(answer.status).toBe(200);
  expect(answer.body.scope).toBe('resume');
  expect(answer.body.items).toHaveLength(1);
  expect(answer.body.items![0]).toMatchObject({
    occurrence: f.chapters[1_149]!.occurrence,
    labels: [{ value: 'Chapter 1150', language: 'en' }],
    displayLabel: 'Chapter 1150',
  });
  expect(answer.body.items![0]!.ordinal).toBeUndefined();
  expect(answer.labelQueries).toHaveLength(2);
  expect(answer.labelQueries[1]).toBe(answer.labelQueries[0]);
  expect(answer.labelQueries[0]).toContain(`BIND(<${f.chapters[1_149]!.occurrence}> AS ?occurrence)`);
  expect(answer.labelQueries[0]).toContain(`LIMIT ${READING_POSITION_COST.labels}`);
});

test('an unlabelled occurrence, and a label that is private or has no language, resumes with no label', async () => {
  const missing = book(4, chapters => {
    delete chapters[1]!.labels;
    delete chapters[1]!.displayLabel;
  });
  const blank = await missing.resume(2);
  expect(blank.status).toBe(200);
  expect(blank.body.scope).toBe('resume');
  expect(unnamed(blank.body.items![0]!)).toBe(true);

  const withheld = book(4, chapters => { chapters[2]!.withholdLabel = true; });
  const hidden = await withheld.resume(3);
  expect(hidden.status).toBe(200);
  expect(hidden.body.items![0]!.occurrence).toBe(withheld.chapters[2]!.occurrence);
  expect(unnamed(hidden.body.items![0]!)).toBe(true);

  const nameless = book(4, chapters => { chapters[0]!.namelessLabel = true; });
  const dropped = await nameless.resume(1);
  expect(dropped.status).toBe(200);
  expect(unnamed(dropped.body.items![0]!)).toBe(true);
  expect(JSON.stringify(dropped.body)).not.toContain('private');
});

test('the resume read\'s statement count does not grow with the structure\'s size or the chapter\'s place', async () => {
  const small = book(40);
  const large = book(1_200);
  const near = await small.resume(10);
  const early = await large.resume(2);
  const late = await large.resume(1_150);
  expect(near.status).toBe(200);
  expect(early.body.items![0]!.labels).toEqual([{ value: 'Chapter 2', language: 'en' }]);
  expect(late.body.items![0]!.labels).toEqual([{ value: 'Chapter 1150', language: 'en' }]);
  expect(near.statements).toBeGreaterThan(0);
  expect(late.statements).toBe(near.statements);
  expect(late.statements).toBe(early.statements);
  expect(late.sql).toBe(near.sql);
  expect(late.sql).toBe(early.sql);
  expect(late.labelQueries).toHaveLength(2);
  expect(late.labelQueries[1]).toBe(late.labelQueries[0]);
});
