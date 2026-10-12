import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { readVisibleCompositionPage } from '../src/modules/collection/visible-page.ts';
import { compositionTargetReader, compositionTargetBatchReader } from '../src/modules/composition/disclosure-read.ts';
import { canReadStructureTarget, canReadStructureTargets, structureProfileFor } from '../src/modules/structure/profiles.ts';
import { collectionRoutes } from '../src/routes/collections.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import type { ReadingPositionStore } from '../src/modules/reading-position/store.ts';
import { orderTree, recordTree, pinTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { WorkReadSession, WorkReadMissing, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { resolveTargets, TargetUnavailable } from '../src/modules/target/resolve.ts';
import { compositionRoutes } from '../src/routes/compositions.ts';
import { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';

const term = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });

/** Real immutable trees, resolver, summary/disclosure pipeline and reading
 * boundary; only owner storage responses are simulated. Integration meters the API. */
async function fixture(count: number, options: { duplicate?: boolean; hidden?: (index: number) => boolean;
  gated?: (index: number) => boolean; missingRevision?: (index: number) => boolean; corrupt?: boolean;
  post?: boolean; private?: (index: number) => boolean; granted?: (index: number) => boolean;
  erased?: (index: number) => boolean; merge?: 'survivor' | 'cycle' } = {}) {
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(bytes) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes);
      return digest;
    },
    async get(digest) {
      const bytes = stored.get(digest);
      if (!bytes) throw new Error('Missing fixture object');
      return bytes;
    },
  };
  const structure = derivedId('collection-page-admission-structure'), owner = derivedId('collection-page-admission-owner');
  const revision = derivedId('collection-page-admission-revision'), generation = derivedId('collection-page-admission-generation');
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({
    occurrence: derivedId(`collection-page-admission-member-${index}`), parent: structure, state: 'active', role: 'member',
    segmentKey: 'i', orderKey: String(index).padStart(8, '0'), labels: [], introducedBy: revision,
    target: derivedId(`collection-page-admission-target-${options.duplicate ? 0 : index}`), selection: { mode: 'follow-context' },
  }));
  const indexes = new Map(records.map((record, index) => [record.target!, index]));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const entries = records.map(({ occurrence, parent, segmentKey, orderKey }) =>
    ({ occurrence, parent, segmentKey: segmentKey!, orderKey: orderKey! }) satisfies OrderEntry);
  if (options.corrupt) records.at(-1)!.parent = derivedId('foreign-parent');
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: owner,
    profile: 'collection-membership', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(row => [row.occurrence, row])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost), new Map(entries.map(row => [orderTreeKey(row), row])), cost),
    placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const seal = derivedId('collection-admission-seal'), pins = records.map(record => ({
    occurrence: record.occurrence, target: record.target!, revision,
  }));
  const pinIndex = pinTree(objects);
  const pinRoot = await pinIndex.apply(await pinIndex.empty(cost), new Map(pins.map(pin =>
    [`${pin.occurrence}\u0001`, pin])), cost);
  const sealDigest = await objects.put(new TextEncoder().encode(JSON.stringify({
    format: 'rezics-structure-seal-v1', structure, structureRevision: revision,
    structureManifest: `sha256:${digest}`, pins: pinRoot, coverage: 'complete', unavailableCount: 0,
    model: STRUCTURE_PROFILE,
  })));
  const header: CompositionHeader = { structure, head: revision, generation, manifest: `urn:rezics:sha256:${digest}`,
    placementCount: count, profile: 'collection-membership', owner, component: owner, work: owner, mainVersion: owner };
  const queries: string[] = [], hydrated: string[][] = [], positionBatches: string[][] = [];
  let graphSequence = '1', positionGeneration = '1', ambiguous = false;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    queries.push(query);
    const bindings: NonNullable<SparqlResult['results']>['bindings'] = [];
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?revision ?manifest ?coverage')) return { results: { bindings: [{
      revision: uri(revision), manifest: term(`urn:rezics:sha256:${sealDigest}`),
      coverage: uri('https://rezics.com/vocab/Complete'), unavailable: term('0'), epoch: term('epoch'), sequence: term('1'),
    }] } };
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
      const resources = [...new Set([...query.matchAll(/VALUES \?work \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(value => value[1]!)))];
      return { results: { bindings: resources.map(resource => ({ work: uri(resource),
        ...(!options.post ? { head: uri(revision), owningWork: uri(resource), owningHead: uri(revision) } : {}),
      })) } };
    }
    if (query.includes('SELECT ?structure WHERE')) return { results: { bindings: [{ structure: uri(structure) }] } };
    if (query.includes('SELECT ?component ?profile')) return { results: { bindings: [{
      component: uri(owner), profile: uri('https://rezics.com/vocab/CollectionMembership'),
      head: uri(revision), generation: uri(generation), count: term(String(count)), manifest: term(header.manifest),
    }] } };
    if (query.includes('SELECT ?owner')) return { results: { bindings: [{ owner: uri(owner) }] } };
    if (query.includes('SELECT ?epoch ?sequence WHERE')) return { results: { bindings: [{
      epoch: term('epoch'), sequence: term(graphSequence),
    }] } };
    if (query.includes('SELECT ?manifest ?predecessor')) {
      bindings.push({ manifest: term(header.manifest), count: term(String(count)), epoch: term('epoch'), sequence: term('1') });
    } else {
      const resources = [...query.matchAll(/VALUES \?r \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => iri[1]!));
      for (const resource of resources) {
        const index = indexes.get(resource)!;
        if (query.includes('SELECT ?epoch ?sequence ?hold')) {
          bindings.push({ epoch: term('epoch'), sequence: term(graphSequence), r: uri(resource),
            type: term(resource === owner ? 'collection' : options.post ? 'resource' : 'work'),
            ...(options.post ? { post: term('true') } : { work: uri(resource) }), head: uri(revision),
            public: term(String(!options.private?.(index))), erased: term(String(!!options.erased?.(index))),
            label: { ...term('Collection target'), 'xml:lang': 'en' } });
        } else if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) {
          if (options.missingRevision?.(index)) continue;
          bindings.push({ epoch: term('epoch'), sequence: term(graphSequence), r: uri(resource),
            revision: uri(revision), type: uri('https://schema.org/CreativeWork'),
            ...(options.merge && (index === 0 || options.merge === 'cycle' && index === 1)
              ? { mergedInto: uri(records[index === 0 ? 1 : 0]!.target!) } : {}) });
          if (ambiguous) bindings.push({ ...bindings.at(-1)!, revision: uri(derivedId('other-revision')) });
        } else throw new Error(`Unexpected graph query: ${query}`);
      }
      if (!bindings.length) bindings.push({ epoch: term('epoch'), sequence: term(graphSequence) });
    }
    return { results: { bindings } };
  };
  const environment = { fuseki: graph, structureObjects: objects, objectDirectory: '.temp/collection-page-admission-unit',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, { read: async targets => targets.map(target =>
    options.hidden?.(indexes.get(target.resource)!) ? 'tombstone' : 'visible') });
  const deps = { environment, access: { assertRecoveryOpen: async () => {},
      canReadWork: async (_principal: unknown, _actor: string, target: string) => !!options.granted?.(indexes.get(target)!),
    }, account: {},
    mediaAccess: { canReadWorks: async (_principal: unknown, _actor: string, targets: readonly string[]) =>
      new Set(targets.filter(target => options.granted?.(indexes.get(target)!))) },
    media: { store: { avatarRows: async (resources: string[]) => {
      hydrated.push([...resources]);
      return { rows: new Map(), generation: { dataEpoch: 'media', sequence: '1' } };
    } } },
    readingPositions: { generation: async () => positionGeneration,
      lookup: async (resources: readonly string[]) => { positionBatches.push([...resources]); return new Map(); },
      required: async (resources: readonly string[]) => new Set(resources.filter(resource => options.gated?.(indexes.get(resource)!))),
    } as unknown as ReadingPositionStore,
  } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('http://main.test/v1/collections?position=start'),
    {}, { dataEpoch: 'epoch', sequence: '1' });
  const app = collectionRoutes(graph, deps);
  const sealApp = compositionRoutes(graph, deps);
  const readSeal = async () => {
    const response = await sealApp.handle(new Request(
      `http://main.test/v1/compositions/${structure.slice(-36)}/seals/${seal.slice(-36)}`));
    return { status: response.status, body: await response.json() as { pins?: typeof pins; next?: string | null } };
  };
  const read = async (limit = 100, after?: string) => {
    queries.length = hydrated.length = positionBatches.length = 0;
    const query = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) });
    const response = await app.handle(new Request(`http://main.test/v1/collections/${owner.slice(-36)}?${query}`));
    const body = await response.json() as { occurrences?: OccurrenceRecord[]; next?: string | null };
    return { status: response.status, body, queries: queries.length, hydrated: [...hydrated] };
  };
  const direct = (profile: string) => {
    const current = session();
    return { scalar: compositionTargetReader(current, structureProfileFor(profile)),
      batch: compositionTargetBatchReader(current, structureProfileFor(profile)) };
  };
  return { records, read, readSeal, pins, direct, environment, header, session, deps, queries, hydrated, positionBatches,
    moveGraph: () => { graphSequence = '2'; }, movePosition: () => { positionGeneration = '2'; },
    ambiguous: () => { ambiguous = true; } };
}

test('public Collection pages batch duplicate and distinct 4/16/64 members in constant graph queries', async () => {
  for (const duplicate of [true, false]) {
    const counts: number[] = [];
    for (const count of [4, 16, 64]) {
      const f = await fixture(count, { duplicate });
      const result = await f.read();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.occurrences).toEqual(f.records);
      expect(result.body.next).toBeNull();
      counts.push(result.queries);
      expect(result.hydrated.filter(batch => batch.includes(f.records[0]!.target!)))
        .toEqual([[...new Set(f.records.map(record => record.target!))]]);
    }
    expect(counts).toEqual([counts[0]!, counts[0]!, counts[0]!]);
    expect(counts[0]!).toBeLessThanOrEqual(12);
    console.info(`Collection ${duplicate ? 'duplicate' : 'distinct'}-target admission counts: ${JSON.stringify(counts)}`);
  }
});

test('Work batches share strict resolver merge admission on Collection pages and composition seals', async () => {
  for (const privateSurvivor of [true, false]) {
    const f = await fixture(3, { merge: 'survivor', private: index => privateSurvivor && index === 1 });
    const source = f.records[0]!.target!, survivor = f.records[1]!.target!;
    const targets = f.records.map(record => record.target!), expected = privateSurvivor ? f.records.slice(2) : f.records;
    if (privateSurvivor) await expect(resolveTargets(f.session(), [source], 'collection-member'))
      .rejects.toBeInstanceOf(TargetUnavailable);
    else expect((await resolveTargets(f.session(), [source], 'collection-member'))[0]!.resource).toBe(survivor);
    const read = f.direct('collection-membership');
    const scalar = new Set<string>();
    for (const target of targets) if (await read.scalar(target)) scalar.add(target);
    expect(await read.batch([...targets, source])).toEqual(scalar);
    expect(scalar).toEqual(new Set(expected.map(record => record.target!)));
    const page = await f.read();
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.occurrences).toEqual(expected);
    expect(page.body.next).toBeNull();
    const seal = await f.readSeal();
    expect(seal.status, JSON.stringify(seal.body)).toBe(200);
    expect(seal.body.pins).toEqual((privateSurvivor ? f.pins.slice(2) : [...f.pins]).sort((left, right) =>
      left.occurrence.localeCompare(right.occurrence)));
    expect(seal.body.next).toBeNull();
  }
});

test('Work scalar, batch, Collection page and seal reads all refuse a merge cycle', async () => {
  const f = await fixture(2, { merge: 'cycle' }), targets = f.records.map(record => record.target!);
  await expect(resolveTargets(f.session(), [targets[0]!], 'collection-member')).rejects.toBeInstanceOf(WorkReadUnavailable);
  const read = f.direct('collection-membership');
  for (const target of targets) await expect(read.scalar(target)).rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(read.batch(targets)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect((await f.read()).status).toBe(503);
  expect((await f.readSeal()).status).toBe(503);
});

test('scalar compatibility establishes limit-50 lookahead before a later failing target, with and without a reading boundary', async () => {
  for (const boundary of [false, true]) {
    const f = await fixture(64);
    const checked: string[] = [], later = f.records[51]!.target!;
    const page = await readVisibleCompositionPage(f.environment, { structure: f.header.structure, header: f.header,
      limit: 50, visible: record => !!record.target,
      ...(boundary ? { readingBoundary: new ReadingBoundary(f.session()) } : {}),
      canReadTarget: async target => {
        checked.push(target);
        if (target === later) throw new Error('Later target owner unavailable');
        return true;
      } });
    expect(page.occurrences).toEqual(f.records.slice(0, 50));
    expect(page.next).not.toBeNull();
    expect(checked).toEqual(f.records.slice(0, 51).map(record => record.target!));
  }
});

test('scalar compatibility stops at cancellation between target callbacks with and without a reading boundary', async () => {
  for (const boundary of [false, true]) {
    const f = await fixture(64), controller = new AbortController();
    let checks = 0;
    await expect(fusekiReadBudget.run({ signal: controller.signal, callsLeft: 10, bytesLeft: 100_000 },
      () => readVisibleCompositionPage(f.environment, { structure: f.header.structure, header: f.header,
        limit: 50, visible: record => !!record.target,
        ...(boundary ? { readingBoundary: new ReadingBoundary(f.session()) } : {}),
        canReadTarget: async () => { checks++; controller.abort(new Error('Read cancelled')); return false; },
      }))).rejects.toThrow('Read cancelled');
    expect(checks).toBe(1);
  }
});

test('composition scalar and batch disclosure agree for Work, resource and catalogue targets', async () => {
  for (const profile of ['collection-membership', 'book-composition']) {
    const f = await fixture(4, { hidden: index => index % 2 === 0 });
    const targets = f.records.map(record => record.target!);
    if (profile === 'collection-membership') targets.push('https://schema.org/Book');
    const read = f.direct(profile);
    const scalar = new Set<string>();
    for (const target of targets) if (await read.scalar(target)) scalar.add(target);
    expect(await read.batch([...targets, ...targets])).toEqual(scalar);
    expect(scalar).toEqual(new Set([targets[1]!, targets[3]!,
      ...(profile === 'collection-membership' ? ['https://schema.org/Book'] : [])]));
  }
});

test('Structure scalar and batch admission share native validation, owner hooks and missing/error outcomes', async () => {
  const targets = Array.from({ length: 4 }, (_, index) => derivedId(`structure-admission-${index}`));
  const catalog = 'https://schema.org/Book';
  const profile = { ...structureProfileFor('collection-membership'), targetDisclosure: 'structure-target' as const,
    authorizeTarget: undefined };
  let batches: string[][] = [], probes: string[] = [];
  const authority = { principal: { issuer: 'account', subject: 'reader' }, actingSubject: derivedId('structure-reader'),
    access: {
      canReadWork: async (_principal: unknown, _actor: string, target: string) => {
        probes.push(target); return targets.indexOf(target) % 2 === 1;
      },
      canReadWorks: async (_principal: unknown, _actor: string, input: readonly string[]) => {
        batches.push([...input]); return new Set(input.filter(target => targets.indexOf(target) % 2 === 1));
      },
    } };
  const input = [...targets, catalog, 'urn:invalid', ...targets];
  const scalar = new Set<string>();
  for (const target of input) if (await canReadStructureTarget(profile, { ...authority, target })) scalar.add(target);
  batches = [];
  expect(await canReadStructureTargets(profile, authority, input)).toEqual(scalar);
  expect(batches).toEqual([targets]);
  expect(probes).toEqual([]);
  const f = await fixture(4);
  const session = f.session();
  session.principal = authority.principal;
  session.options.actingSubject = authority.actingSubject;
  Object.assign(f.deps.access, authority.access);
  expect(await compositionTargetBatchReader(session, profile)(input)).toEqual(scalar);
  const compositionScalar = new Set<string>();
  for (const target of input) if (await compositionTargetReader(session, profile)(target)) compositionScalar.add(target);
  expect(compositionScalar).toEqual(scalar);
  const custom = { ...profile, authorizeTarget: async ({ target }: { target: string }) => {
    probes.push(target);
    if (target === targets[0]) throw new WorkReadMissing('Target missing');
    return target === targets[1];
  } };
  probes = [];
  const customScalar = new Set<string>();
  for (const target of input) if (await canReadStructureTarget(custom, { ...authority, target })) customScalar.add(target);
  probes = [];
  expect(await canReadStructureTargets(custom, authority, input)).toEqual(customScalar);
  expect(probes).toEqual(targets);
  expect(customScalar).toEqual(new Set([catalog, targets[1]!]));
  const unavailable = { ...custom, authorizeTarget: async () => { throw new Error('Owner unavailable'); } };
  await expect(canReadStructureTarget(unavailable, { ...authority, target: targets[0]! })).rejects.toThrow('Owner unavailable');
  await expect(canReadStructureTargets(unavailable, authority, targets)).rejects.toThrow('Owner unavailable');
});

test('resource batches preserve public and granted Post disclosure while withholding private and erased siblings', async () => {
  const f = await fixture(4, { post: true, private: index => index !== 0,
    granted: index => index === 1 || index === 3, erased: index => index === 3 });
  const session = f.session();
  session.principal = { issuer: 'account', subject: 'reader' };
  session.options.actingSubject = derivedId('post-reader');
  const profile = structureProfileFor('book-composition');
  const targets = f.records.map(record => record.target!);
  const scalar = new Set<string>();
  for (const target of targets) if (await compositionTargetReader(session, profile)(target)) scalar.add(target);
  f.queries.length = 0;
  expect(await compositionTargetBatchReader(session, profile)([...targets, ...targets])).toEqual(scalar);
  expect(scalar).toEqual(new Set(targets.slice(0, 2)));
  expect(f.queries.filter(query => query.includes('SELECT ?epoch ?sequence ?hold'))).toHaveLength(1);
  expect(f.queries.filter(query => query.includes('SELECT ?work ?head ?owningWork ?owningHead')).length)
    .toBeLessThanOrEqual(2);
});

test('batch-only visible pages skip hidden members without inventing a continuation', async () => {
  const f = await fixture(16, { hidden: index => index > 0 });
  const page = await readVisibleCompositionPage(f.environment, { structure: f.header.structure, header: f.header,
    limit: 4, visible: record => !!record.target, canReadTargets: f.direct('collection-membership').batch });
  expect(page.occurrences).toEqual([f.records[0]!]);
  expect(page.next).toBeNull();
});

