import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { recordTree, orderTree } from '../../../services/main/src/modules/structure/change.ts';
import { derivedId, orderTreeKey } from '../../../services/main/src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord } from '../../../services/main/src/modules/structure/format.ts';
import { newCost } from '../../../services/main/src/modules/structure/tree.ts';
import { readChapterContinuation } from '../../../services/main/src/modules/work-contents/read.ts';
import { WorkReadSession, WorkReadMissing, WorkReadMoved }
  from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import type { DisclosureTarget } from '../../../services/main/src/modules/disclosure/read.ts';
import { ObjectUnavailable } from '../../../services/main/src/infrastructure/immutable-objects.ts';

const id = (key: string) => derivedId(`g969:${key}`);
const term = (value: string) => ({ type: 'uri', value });
const work = id('work'), main = id('main'), structure = id('structure'), head = id('head');
const revision = (target: string) => `urn:rezics:content:revision:${target.slice(-36)}`;

async function fixture(count: number, grouped = false) {
  const retained = new Map<string, Uint8Array>();
  const objects = {
    put: async (bytes: Uint8Array) => {
      const digest = createHash('sha256').update(bytes).digest('hex');
      retained.set(digest, bytes);
      return digest;
    },
    get: async (digest: string) => {
      const bytes = retained.get(digest);
      if (!bytes) throw new ObjectUnavailable('fixture object is missing');
      return bytes;
    },
  };
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({
    occurrence: id(`occurrence:${index}`), parent: grouped ? id('group') : structure,
    state: 'active', role: 'chapter', segmentKey: '0', orderKey: String(index).padStart(5, '0'),
    target: id(`target:${index}`), selection: { mode: 'follow-context' },
    labels: [{ value: `Chapter ${index}`, language: 'en' }], introducedBy: head,
  }));
  const all = grouped ? [{ occurrence: id('group'), parent: structure, state: 'active', role: 'group',
    segmentKey: '0', orderKey: '00000', labels: [{ value: 'Volume one', language: 'en' }],
    introducedBy: head } as OccurrenceRecord, ...records] : records;
  const cost = newCost();
  const recordRoot = await recordTree(objects).apply(await recordTree(objects).empty(cost),
    new Map(all.map(record => [record.occurrence, record])), cost);
  const orderEntries = all.map(record => ({ occurrence: record.occurrence, parent: record.parent,
    segmentKey: record.segmentKey!, orderKey: record.orderKey! }));
  const orderRoot = await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(orderEntries.map(record => [orderTreeKey(record), record])), cost);
  const manifest = `urn:rezics:sha256:${await objects.put(new TextEncoder().encode(JSON.stringify({
    format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: main, profile: 'book-composition',
    generation: id('generation'), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: recordRoot, order: orderRoot, placementCount: all.length, measures: [],
    model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE,
  })))}`;
  const queries: string[] = [];
  const unavailable = new Set<string>(), unpublished = new Set<string>();
  let moved = false, headerReads = 0;
  const binding = (...rows: Record<string, { type: string; value: string }>[]) => ({ results: { bindings: rows } });
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    structureObjects: objects, fuseki: { query: async (query: string) => {
      queries.push(query);
      if (query.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest')) {
        return binding({ component: term(main), profile: term('https://rezics.com/vocab/BookComposition'),
          head: term(moved && headerReads++ > 0 ? id('moved-head') : head), generation: term(id('generation')),
          count: term(String(all.length)), manifest: term(manifest) });
      }
      if (query.includes('SELECT ?owner WHERE')) return binding({ owner: term(work) });
      if (query.includes('SELECT ?manifest ?predecessor ?count ?epoch ?sequence')) {
        return binding({ manifest: term(manifest), count: term(String(all.length)),
          epoch: term('epoch'), sequence: term('1') });
      }
      if (query.includes('SELECT DISTINCT ?target WHERE')) {
        const target = /BIND\(<([^>]+)> AS \?target\)/u.exec(query)![1]!;
        return unavailable.has(target) ? binding() : binding({ target: term(target) });
      }
      if (query.includes('SELECT DISTINCT ?variant ?revision WHERE')) {
        const target = /rv:resource <([^>]+)>/u.exec(query)![1]!;
        const selected = revision(target);
        if (unavailable.has(target) || unpublished.has(target) || query.includes('FILTER(?revision =')
          && !query.includes(`FILTER(?revision = <${selected}>)`)) return binding();
        return binding({ variant: term(id(`variant:${target}`)), revision: term(selected) });
      }
      if (query.includes('SELECT ?segment ?key ?groupSegment ?groupKey')) {
        const occurrence = /rv:occurrence <([^>]+)>/u.exec(query)![1]!;
        const record = records.find(item => item.occurrence === occurrence)!;
        return binding({ segment: term(record.segmentKey!), key: term(record.orderKey!),
          ...(grouped ? { groupSegment: term('0'), groupKey: term('00000') } : {}) });
      }
      if (query.includes('SELECT ?occurrence ?target ?pinned')) {
        const after = JSON.parse(/FILTER\(\?position > ("(?:[^"\\]|\\.)*")\)/u.exec(query)![1]!) as string;
        const position = (record: OccurrenceRecord) => grouped
          ? `0\u000100000\u0003${record.segmentKey}\u0001${record.orderKey}\u0002${record.occurrence}`
          : `${record.segmentKey}\u0001${record.orderKey}\u0002${record.occurrence}`;
        return binding(...records.filter(record => position(record) > after).slice(0, 21)
          .map(record => ({ occurrence: term(record.occurrence), target: term(record.target!) })));
      }
      throw new Error(`Unexpected graph hydration: ${query}`);
    } } }, content: { readExactBatch: () => { throw new Error('Continuation must not load chapter bytes'); } },
    access: {}, account: {} } as unknown as MainWorkDependencies;
  class Session extends WorkReadSession {
    hidden = new Set<string>();
    revokeOnSecondDisclosure?: { resource: string; component: 'name' | 'body' };
    disclosureReads = new Map<string, number>();
    override async summaries(): Promise<never> { throw new Error('Continuation must not rehydrate the Book'); }
    override async disclosure(targets: readonly DisclosureTarget[]) {
      return targets.map(target => {
        const key = `${target.resource}\0${target.component}`;
        const reads = (this.disclosureReads.get(key) ?? 0) + 1;
        this.disclosureReads.set(key, reads);
        const revoked = this.revokeOnSecondDisclosure;
        return this.hidden.has(target.resource) || revoked?.resource === target.resource
          && revoked.component === target.component && reads >= 2 ? 'hidden' as const : 'visible' as const;
      });
    }
  }
  const session = new Session(deps, new Request('http://main.test/v1/feed'), {}, { dataEpoch: 'epoch', sequence: '1' });
  return { session, records, queries, unavailable, unpublished, move: () => { moved = true; headerReads = 0; } };
}

test('G969/G282: distant progress resolves the next chapter within 14 graph calls without body or Book hydration', async () => {
  const calls: number[] = [];
  for (const count of [22, 1024]) {
    const f = await fixture(count);
    const current = f.records[count - 2]!;
    expect(await readChapterContinuation(f.session, work, structure, current.occurrence, 'en', true))
      .toEqual({ occurrence: f.records[count - 1]!.occurrence, language: 'en' });
    expect(f.queries.length).toBeLessThanOrEqual(14);
    calls.push(f.queries.length);
    expect(f.queries.some(query => query.includes('DESC(?position)'))).toBe(false);
    expect(f.queries.some(query => query.includes('SELECT ?occurrence ?target ?pinned'))).toBe(false);
  }
  expect(calls[1]).toBe(calls[0]);
});

test('G969/G282: unread progress, completed end and grouped reading order retain exact outcomes', async () => {
  for (const grouped of [false, true]) {
    const f = await fixture(3, grouped);
    expect(await readChapterContinuation(f.session, work, structure, f.records[1]!.occurrence, 'EN', false))
      .toEqual({ occurrence: f.records[1]!.occurrence, language: 'en' });
    expect(await readChapterContinuation(f.session, work, structure, f.records[1]!.occurrence, 'en', true))
      .toEqual({ occurrence: f.records[2]!.occurrence, language: 'en' });
    expect(await readChapterContinuation(f.session, work, structure, f.records[2]!.occurrence, 'en', true)).toBeNull();
  }
});

test('G969/G282: unavailable publications, live disclosure and moving composition heads fence continuation links', async () => {
  const f = await fixture(2);
  f.unavailable.add(f.records[0]!.target!);
  await expect(readChapterContinuation(f.session, work, structure, f.records[0]!.occurrence, 'en', false))
    .rejects.toBeInstanceOf(WorkReadMissing);
  f.unavailable.clear();
  f.session.hidden.add(f.records[1]!.target!);
  await expect(readChapterContinuation(f.session, work, structure, f.records[0]!.occurrence, 'en', true))
    .rejects.toBeInstanceOf(WorkReadMissing);
  f.session.hidden.clear();
  f.move();
  await expect(readChapterContinuation(f.session, work, structure, f.records[0]!.occurrence, 'en', false))
    .rejects.toBeInstanceOf(WorkReadMoved);
});

test('Continuation skips unreadable targets and unavailable publications', async () => {
  const f = await fixture(4);
  f.unavailable.add(f.records[1]!.target!);
  f.unpublished.add(f.records[2]!.target!);
  expect(await readChapterContinuation(f.session, work, structure, f.records[0]!.occurrence, 'en', true))
    .toEqual({ occurrence: f.records[3]!.occurrence, language: 'en' });
});

test('Final successor read refuses late name or body disclosure revocation', async () => {
  for (const component of ['name', 'body'] as const) {
    const f = await fixture(2), target = f.records[1]!.target!;
    f.session.revokeOnSecondDisclosure = { resource: target, component };
    await expect(readChapterContinuation(f.session, work, structure, f.records[0]!.occurrence, 'en', true))
      .rejects.toBeInstanceOf(WorkReadMissing);
    expect(f.session.disclosureReads.get(`${target}\0${component}`)).toBe(2);
    // Publication selection is repeated in the final read after the candidate was accepted.
    expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?variant ?revision WHERE')
      && query.includes(`rv:resource <${target}>`))).toHaveLength(2);
  }
});

test('Completed continuation retains its final moving-head fence', async () => {
  const f = await fixture(2);
  f.move();
  await expect(readChapterContinuation(f.session, work, structure, f.records[0]!.occurrence, 'en', true))
    .rejects.toBeInstanceOf(WorkReadMoved);
});

test('G969/WORK09: formatting an editable copy preserves the frozen canonical document', () => {
  const canonical = fromPlainText('第二版');
  const editable = structuredClone(canonical);
  editable.doc.content![0]!.content![0]!.marks = [{ type: 'bold' }];
  expect(canonical.doc.content![0]!.content![0]!.marks).toBeUndefined();
  expect(JSON.parse(JSON.stringify(editable)).doc.content[0].content[0].marks).toEqual([{ type: 'bold' }]);
});
