import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { Parser } from 'n3';
import { systemDisclosure } from '../src/modules/target/disclosed-references.ts';
import type { Pool } from 'pg';
import {
  configureDisclosure,
  DisclosureStore,
  type DisclosureTarget,
} from '../src/modules/disclosure/read.ts';
import { admittedPage, ADMITTED_PAGE_COST } from '../src/modules/disclosure/admitted-page.ts';
import { readSitemap } from '../src/modules/disclosure/sitemap.ts';
import { readRealmWorks } from '../src/modules/realm-reads/read-works.ts';
import {
  readRealmDecision,
  readRealmDecisions,
} from '../src/modules/realm-reads/public-decision-index.ts';
import { readRankings } from '../src/modules/rankings/read.ts';
import type { ReadRankingProjection } from '../src/modules/rankings/projection.ts';
import { readAgentCollections, readAgentWorks } from '../src/modules/profiles/read.ts';
import { allocateAgentHandle } from '../src/modules/agent/handle.ts';
import { readReleasesByIdentifier } from '../src/modules/release/read.ts';
import { readResourceRelations } from '../src/modules/relation/traversal.ts';
import { SerialStatisticsProjection } from '../src/modules/work/serial-projection.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { withDisclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { WorkReadSession, type ReadRow } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { ownedTriples, type DefinitionState } from '../src/modules/semantic/change.ts';
import { PROFILES, definitionKindIri } from '../src/modules/semantic/schema.ts';
import { COLLECTION_PURPOSE_NOTATION } from '../src/modules/statement/qualification.ts';
import { CLASSIFICATION_INHERIT_POLICY } from '../src/modules/classification/context.ts';
import { fallbackAvatar, type ResourceSummary } from '../src/modules/media/summary.ts';
import type { Labels } from '../src/modules/suitability/policy.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureCut } from './support/disclosure-ancestry.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const term = (value: string) => ({ type: 'literal', value });
const row = (fields: Record<string, string>): ReadRow =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, term(value)]));
const refs = (query: string) =>
  [...query.matchAll(/<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/g)].map((hit) =>
    hit[0].slice(1, -1),
  );
const position = { dataEpoch: 'epoch', sequence: '1' };
const directory = mkdtempSync('.temp/derived-relation-owners-');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture(signed = false) {
  const labels = new Map<string, Labels>(),
    parents = new Map<string, string>();
  const restricted = new Set<string>();
  const batches: DisclosureTarget[][] = [];
  let failed = false;
  const pool = {
    // Disclosure and its recovery fence now share one autocommit snapshot.
    query: async (sql: string, args?: unknown[]) => {
      if (!sql.includes('jsonb_to_recordset')) return { rows: [] };
      if (failed) throw new Error('Assessment store unavailable');
      const targets = JSON.parse(String(args![0])) as (DisclosureTarget & { ordinal: number })[];
      expect(targets.length).toBeLessThanOrEqual(64);
      batches.push(targets);
      return {
        rows: targets.map((target) => ({
          open: true,
          ordinal: target.ordinal,
          restricted: [target.resource, ...(target.ancestry?.parents.map(parent => parent.resource) ?? [])]
            .some(ref => restricted.has(ref)),
          realmClosed: false, ...fixtureDisclosureCut,
          assessments: [...new Set([target.resource, ...(target.ancestry?.parents.map(parent => parent.resource) ?? [])])].flatMap((ref) =>
            ref && labels.has(ref) ? [labels.get(ref)!] : [],
          ),
        })),
      };
    },
  } as unknown as Pool;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async (query) => ({
    results: {
      bindings: query.includes('SELECT ?resource ?head')
        ? [...new Set(refs(query))].map(resource => row({ resource, head: id(900) }))
        : query.includes('SELECT ?work ?head')
        ? [...new Set(refs(query))].map((work) =>
            row({
              work,
              head: id(900),
              ...(parents.has(work) ? { owningWork: parents.get(work)!, owningHead: id(900) } : {}),
            }),
          )
        : [row({ epoch: 'epoch', sequence: '1' })],
    },
  });
  const environment = {
    fuseki: graph,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '.temp/g-904',
  };
  configureDisclosure(environment, new DisclosureStore(pool));
  configureFixtureDisclosureAncestry(environment, target => {
    const parent = target.work ?? parents.get(target.resource);
    return parent ? { resource: parent, head: id(900), protectedRevision: target.workRevision } : undefined;
  });
  const session = new WorkReadSession(
    { environment, access: {
      activePrincipalId: async () => 'reader', assertRecoveryOpen: async () => {},
    } } as unknown as MainWorkDependencies,
    new Request('http://main.local/v1/read'),
    { limit: 2 },
    position,
  );
  if (signed) session.principal = { issuer: 'account', subject: 'reader' };
  session.realm = async (realm) =>
    ({
      realmRevision: id(901),
      space: realm,
      visibility: 'public',
      reviewMode: 'open',
      revision: null,
    }) as never;
  const hydrated: string[][] = [];
  session.summaries = async (resources) => {
    hydrated.push(resources);
    expect(resources.every((resource) => !restricted.has(resource))).toBe(true);
    return resources.map(
      (resource) =>
        ({
          reference: resource,
          status: 'available',
          type: 'work',
          disclosure: 'public',
          base: 'work',
          work: resource,
          name: { value: 'Public title', language: 'en', direction: 'ltr', basis: 'fallback' },
          avatar: fallbackAvatar('work', resource),
        }) as ResourceSummary,
    );
  };
  return {
    environment,
    graph,
    session,
    labels,
    restricted,
    parents,
    batches,
    hydrated,
    fail: () => {
      failed = true;
    },
  };
}

function serialHeads(query: string) {
  return refs(query)
    .filter((ref) => !ref.endsWith('000000000900'))
    .map((work) => row({ work }));
}

test('G-904: admitted pagination fills beyond a hidden batch and never derives a continuation from a hidden tail', async () => {
  const inventory = Array.from({ length: 70 }, (_, i) => i + 1),
    admitted = new Set([65, 66, 69]);
  const calls: number[] = [];
  const read = (after?: number) =>
    admittedPage({
      limit: 2,
      after,
      key: String,
      fetch: async (seek, size) => inventory.filter((value) => value > (seek ?? 0)).slice(0, size),
      admit: async (rows) => {
        calls.push(rows.length);
        return rows.filter((value) => admitted.has(value));
      },
    });
  const first = await read();
  expect(first.page).toEqual([65, 66]);
  expect(first.lookahead).toBe(69);
  expect(first.last).toBe(66);
  expect(calls).toEqual([64, 6]);
  expect(await read(first.last)).toMatchObject({ page: [69], lookahead: undefined, last: 69 });
  const broken = admittedPage({
    limit: 1,
    key: String,
    fetch: async () => Array(64).fill(1),
    admit: async () => [],
  });
  await expect(broken).rejects.toThrow('ambiguous');
  let scans = 0;
  await expect(
    admittedPage({
      limit: 1,
      key: String,
      fetch: async (_seek, size) => Array.from({ length: size }, () => ++scans),
      admit: async () => [],
    }),
  ).rejects.toThrow('scan budget exceeded');
  expect(scans).toBe(ADMITTED_PAGE_COST.scans * 64);
});

for (const signed of [false, true]) {
  test(`G-904: interactive inventories retain rated content for client presentation (${signed ? 'signed' : 'anonymous'})`, async () => {
    const f = fixture(signed);
    f.labels.set(id(1), ['r18']);
    f.session.query = async query => query.includes('SELECT DISTINCT ?work ?head ?main')
      ? [row({ work: id(1), head: id(900), main: id(11), selection: id(21), contribution: id(31), language: 'en' })]
      : query.includes('SELECT ?work ?head') ? serialHeads(query) : [];
    const graphQuery = f.graph.query.bind(f.graph);
    f.graph.query = async query => query.includes('SELECT DISTINCT ?work ?head ?main')
      ? { results: { bindings: await f.session.query(query, 64) } } : graphQuery(query);
    expect((await readRealmWorks(f.session, id(99))).items.map(item => item.id)).toEqual([id(1)]);
    expect(f.hydrated.every(resources => resources.includes(id(1)))).toBe(true);
  });

  test(`G-904: Realm decision inventories gate before mapping and exact lookup (${signed ? 'signed' : 'anonymous'})`, async () => {
    const f = fixture(signed),
      realm = id(99);
    f.restricted.add(id(1));
    const decisions = [
      row({
        id: id(11),
        kind: 'corrupt-hidden',
        work: id(1),
        subject: id(21),
        revisionEpoch: 'epoch',
        sequence: '9',
        epochOrder: '0',
      }),
      ...[2, 3].map((n) =>
        row({
          id: id(n + 10),
          kind: 'adoption',
          work: id(n),
          subject: id(n + 20),
          revisionEpoch: 'epoch',
          sequence: String(10 - n),
          epochOrder: '0',
        }),
      ),
    ];
    f.session.query = async (query) =>
      query.includes('SELECT ?epoch ?prior')
        ? []
        : query.includes('FILTER(?id =')
          ? [decisions[0]!]
          : decisions;
    const graphQuery = f.graph.query.bind(f.graph);
    f.graph.query = async query => query.includes('SELECT DISTINCT ?id ?kind')
      ? { results: { bindings: await f.session.query(query, 64) } } : graphQuery(query);
    const page = await readRealmDecisions(f.session, realm);
    expect(page.items.map((item) => item.work)).toEqual([id(2), id(3)]);
    expect(page.count.value).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect(f.batches.map(batch => batch.map(target => target.resource)))
      .toEqual([[realm], [id(11), id(12), id(13)]]);
    await f.session.fenceDependencies();
    expect(f.batches.filter(batch => batch.some(target => target.resource === realm))).toHaveLength(2);
    await expect(readRealmDecision(f.session, realm, id(11))).rejects.toThrow(
      'Decision is unavailable',
    );
    f.fail();
    await expect(f.session.fenceDependencies()).rejects.toThrow('Disclosure owner is unavailable');
  });

  test(`G-904: Realm Work pages select admitted identities before hydration (${signed ? 'signed' : 'anonymous'})`, async () => {
    const f = fixture(signed);
    f.restricted.add(id(1));
    const works = [1, 2, 3].map((n) =>
      row({
        work: id(n),
        head: id(900),
        main: id(n + 10),
        selection: id(n + 20),
        contribution: id(n + 30),
        language: 'en',
      }),
    );
    f.session.query = async (query) =>
      query.includes('SELECT DISTINCT ?work ?head ?main')
        ? works
        : query.includes('SELECT ?work ?head')
          ? serialHeads(query)
          : [];
    const graphQuery = f.graph.query.bind(f.graph);
    f.graph.query = async query => query.includes('SELECT DISTINCT ?work ?head ?main')
      ? { results: { bindings: await f.session.query(query, 64) } } : graphQuery(query);
    const page = await readRealmWorks(f.session, id(99));
    expect(page.items.map((item) => item.id)).toEqual([id(2), id(3)]);
    expect(page.count.value).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect(f.hydrated).toEqual([
      [id(2), id(3)],
      [id(2), id(3)],
    ]);
    expect(f.batches.map(batch => batch.map(target => target.resource)))
      .toEqual([[id(99)], [id(1), id(2), id(3)]]);
    await f.session.fenceDependencies();
    expect(f.batches.filter(batch => batch.some(target => target.resource === id(99)))).toHaveLength(2);
  });

  test(`G-904: rankings fill admitted scores and use only admitted lookahead (${signed ? 'signed' : 'anonymous'})`, async () => {
    const f = fixture(signed);
    const candidates = [1, 2, 3, 4].map((n) => ({
      work: id(n),
      score: String(10 - n),
      growth: '1',
    }));
    f.restricted.add(id(1));
    f.restricted.add(id(4));
    f.session.query = async (query) =>
      query.includes('SELECT DISTINCT ?work ?main ?head')
        ? candidates.filter(candidate => query.includes(`<${candidate.work}>`))
          .map((candidate) => row({ work: candidate.work, head: id(900), main: id(800) }))
        : query.includes('SELECT ?work ?head')
          ? serialHeads(query)
          : [];
    const projection = {
      // The projection seeks admitted scores; denied raw rows never consume
      // the page or its lookahead. The reader still fences these identities.
      capture: async (...args: Parameters<ReadRankingProjection['capture']>) => ({
        checkpoint: { generation: 'g', contentEpoch: 'c', contentSequence: '1',
          graphEpoch: 'epoch', reviewPosition: '1' }, revision: '1', removalRevision: '0',
        rows: candidates.filter(candidate => !f.restricted.has(candidate.work)),
        population: { metric: args[0], interval: args[1], bucket: args[2],
          context: args[6] ?? 'urn:rezics:context:global' } }),
      fence: async () => true,
    } as unknown as ReadRankingProjection;
    const page = await readRankings(f.session, projection, {
      realm: null,
      metric: 'reads',
      interval: 'day',
      order: 'score',
    });
    expect(page.items.map((item) => item.id)).toEqual([id(2), id(3)]);
    expect(page.nextCursor).toBeNull();
    expect(page.count.value).toBe(2);
    expect(f.batches).toHaveLength(1);
  });

  test(`G-904: profiles admit Works before hydration and Collections before mapping (${signed ? 'signed' : 'anonymous'})`, async () => {
    const f = fixture(signed),
      agent = id(99),
      ids = [id(1), id(2), id(3)];
    f.restricted.add(id(1));
    Object.assign(f.session.deps, {
      personPreferences: { profileVisible: async () => true },
      profiles: {
        agentFence: async () => '1',
        visibility: { read: async () => ({ visibility: 'public', version: 1 }) },
        listing: { read: async () => ({ listing: 'listed', version: 0, changedAt: null }) },
      },
    });
    f.session.query = async (query) => {
      if (query.includes('SELECT ?displayName'))
        return [
          row({
            displayName: 'Author',
            agentKind: `${RV}PersonAgent`,
            handle: allocateAgentHandle(agent),
            agentHead: id(900),
          }),
        ];
      if (query.includes('SELECT DISTINCT ?id')) return ids.map((id) => row({ id }));
      if (query.includes('SELECT ?id ?revision ?name')) {
        // Collections now carry their fields in the ordered candidate query,
        // then apply disclosure before mapping those position-bound rows.
        expect(query).toContain('ORDER BY STR(?id)');
        return ids
          .map((reference) =>
            row({
              id: reference,
              revision: reference,
              name: 'List',
              kind: reference === id(1) ? 'corrupt-hidden' : `${RV}StaticCollection`,
              structure: id(90),
            }),
          );
      }
      if (query.includes('SELECT ?work ?head')) return serialHeads(query);
      if (query.includes('SELECT ?work ?credit ?role'))
        return ids.slice(1).map((work) => row({ work, credit: work, role: 'author' }));
      return [];
    };
    const graphQuery = f.graph.query.bind(f.graph);
    f.graph.query = async query => query.includes('SELECT DISTINCT ?id') || query.includes('SELECT ?id ?revision ?name')
      ? { results: { bindings: await f.session.query(query, 64) } } : graphQuery(query);
    const works = await readAgentWorks(f.session, agent);
    expect(works.items.map((item) => item.id)).toEqual(ids.slice(1));
    expect(works.nextCursor).toBeNull();
    const collections = await readAgentCollections(f.session, agent);
    expect(collections.items.map((item) => item.id)).toEqual(ids.slice(1));
    expect(collections.nextCursor).toBeNull();
    expect(f.batches).toHaveLength(2);
  });

  test(`G-904: identifier Release pages admit the derivative before state and withhold a Release with a hidden parent (${signed ? 'signed' : 'anonymous'})`, async () => {
    const f = fixture(signed),
      releases = [11, 12, 13].map((n) => row({ release: id(n), revision: id(n + 10) }));
    f.restricted.add(id(11));
    f.restricted.add(id(3));
    const stored = (release: string, work: string) => ({
      profile: 'release-v1',
      expectedHead: null,
      actingSubject: id(99),
      id: release,
      work,
      kind: 'formal',
      status: 'official',
      contentLanguages: ['en'],
      isTranslation: false,
      originalLanguages: [],
      titleLanguage: 'en',
      tracklistLanguage: null,
      title: { value: 'Release', language: 'en' },
      editionStatement: null,
      publisher: null,
      publicationYear: null,
      isbn13: '9780316371247',
      originalUrl: null,
      fixedRelease: null,
      coverage: null,
      evidence: null,
    });
    // Parent summaries return unavailable rather than hydrating the denied parent.
    f.session.summaries = async (resources) =>
      resources.map(
        (reference) =>
          ({
            reference,
            status: f.restricted.has(reference) ? 'unavailable' : 'available',
            type: 'work',
          }) as ResourceSummary,
      );
    f.session.query = async (query) => {
      if (query.includes('SELECT ?release ?revision WHERE')) return releases;
      if (query.includes('SELECT ?release ?revision ?state')) {
        expect(refs(query)).not.toContain(id(11));
        return releases.slice(1).map((release, i) => ({
          ...release,
          state: term(JSON.stringify(stored(release.release!.value, id(i + 2)))),
        }));
      }
      if (query.includes('SELECT ?work ?main'))
        return [2, 3].map((n) => row({ work: id(n), main: id(n + 30) }));
      return [];
    };
    const graphQuery = f.graph.query.bind(f.graph);
    f.graph.query = async query => {
      if (query.includes('SELECT ?release ?revision') || query.includes('SELECT ?work ?main'))
        return { results: { bindings: await f.session.query(query, 64) } };
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
        const control = { epoch: term('epoch'), sequence: term('1') };
        return { results: { bindings: [control, ...[id(2), id(3)].filter(work => query.includes(`<${work}>`))
          .map(work => ({ ...control, r: term(work), type: term('work'), work: term(work), head: term(id(900)),
            public: term('true'), label: { ...term('Public title'), 'xml:lang': 'en' } }))] } };
      }
      return graphQuery(query);
    };
    const page = await readReleasesByIdentifier(f.session, { isbn13: '9780316371247' });
    expect(page.items.map((item) => item.id)).toEqual([id(12)]);
    expect(page.count.value).toBe(1);
    expect(page.nextCursor).toBeNull();
    expect(f.batches[0]!.map(target => target.resource)).toEqual([id(11), id(12), id(13)]);
    // The selection probe uses the real summary owner, including its closing
    // disclosure checks; only admitted Release parents enter that owner.
    expect([...new Set(f.batches.slice(1).flatMap(batch => batch.map(target => target.resource)))])
      .toEqual([id(2), id(3)]);
    expect(f.batches.some(batch => batch.length === 1 && batch[0]!.resource === id(2))).toBe(true);
  });
}

test('G-904: sitemap fills after hidden identities and ends without a hidden continuation', async () => {
  const f = fixture(),
    works = Array.from({ length: 570 }, (_, index) => id(index + 1));
  works.slice(0, 65).forEach((work) => f.labels.set(work, ['r18']));
  const headQuery = f.graph.query.bind(f.graph);
  f.graph.query = async (query) => {
    if (query.includes('SELECT ?work ?head ?owningWork') || query.includes('SELECT ?work ?head ?nameOwner')
      || query.includes('SELECT ?resource ?head'))
      return headQuery(query);
    if (!query.includes('SELECT ?sequence ?work ?head'))
      return { results: { bindings: [row({ sequence: '1' })] } };
    const after = /FILTER\(STR\(\?work\) > "([^"]+)"\)/.exec(query)?.[1] ?? '';
    const found = works.filter((work) => work > after).slice(0, 64);
    return {
      results: {
        bindings: found.length
          ? found.map((work) => row({ work, head: id(900), sequence: '1' }))
          : [row({ sequence: '1' })],
      },
    };
  };
  const first = await readSitemap(f.environment);
  expect(first.entries).toHaveLength(500);
  expect(first.entries[0]?.reference).toBe(id(66));
  expect(first.next).toBe(id(565));
  expect(f.batches).toHaveLength(17); // Nine candidate batches and eight final page/lookahead fences.
  const last = await readSitemap(f.environment, first.next!);
  expect(last.entries.map((item) => item.reference)).toEqual(works.slice(565));
  expect(last.next).toBeNull();
});

test('G-904: a restricted relation occurrence is gated before retained payload resolution even with readable subject Works', async () => {
  const f = fixture();
  f.restricted.add(id(11));
  const collection = id(12), definition = id(20), revision = id(21);
  const state: DefinitionState = { component: 'definition', kind: 'property', lifecycle: 'active',
    successor: null, roles: [], notation: COLLECTION_PURPOSE_NOTATION };
  f.environment.objectDirectory = directory;
  const manifest = `urn:rezics:sha256:${prepareComponent(directory, definition, state, PROFILES.definition)}`;
  // The visible ordinary Collection has a current canonical Structure and a
  // complete, empty purpose inventory. Restricted occurrences still have no
  // payload response, so accidentally resolving one keeps failing this test.
  f.session.deps.access.canReadSemanticResource = async (_principal, _actor, resource) =>
    resource === collection || resource === definition;
  f.session.deps.statementSeek = {
    coverage: async () => ({ complete: true, through_sequence: '0' }),
  } as MainWorkDependencies['statementSeek'];
  const uri = (value: string) => ({ type: 'uri', value });
  const headQuery = f.graph.query.bind(f.graph);
  f.graph.query = async (query) => {
    if (query.includes('SELECT ?work ?head ?owningWork') || query.includes('SELECT ?work ?head ?nameOwner')
      || query.includes('SELECT ?resource ?head'))
      return headQuery(query);
    if (query.includes('SELECT DISTINCT ?relation ?kind ?key'))
      return {
        results: {
          bindings: [
            row({ relation: id(12), kind: 'collection', key: `collection:${id(12)}` }),
            row({ relation: id(11), kind: 'occurrence', key: `occurrence:${id(11)}` }),
          ],
        },
      };
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return { results: { bindings: [{
      ...row({ epoch: 'epoch', sequence: '1', type: 'collection', public: 'true' }), r: uri(collection),
      label: { ...term('Ordinary collection'), 'xml:lang': 'en' },
    }] } };
    if (query.includes('SELECT ?structure WHERE')) return { results: { bindings: [{ structure: uri(id(22)) }] } };
    if (query.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest')) return { results: { bindings: [{
      component: uri(collection), profile: uri(`${RV}CollectionMembership`), head: uri(id(23)),
      generation: uri(id(24)), count: term('1'), manifest: uri(`urn:rezics:sha256:${'a'.repeat(64)}`),
    }] } };
    if (query.includes('SELECT ?owner WHERE')) return { results: { bindings: [{ owner: uri(collection) }] } };
    if (query.includes('SELECT ?definition ?head')) return { results: { bindings: [{ definition: uri(definition), head: uri(revision) }] } };
    if (query.includes('SELECT ?definition ?manifest ?kind')) return { results: { bindings: [{
      definition: uri(definition), manifest: uri(manifest), kind: uri(definitionKindIri('property')),
    }] } };
    if (query.includes('SELECT ?head ?manifest')) return { results: { bindings: [{ head: uri(revision), manifest: uri(manifest) }] } };
    if (query.includes('SELECT ?p ?o')) return { results: { bindings: new Parser()
      .parse(ownedTriples(definition, state, revision).map(triple => `<${definition}> ${triple} .`).join('\n'))
      .map(quad => ({ p: uri(quad.predicate.value), o: uri(quad.object.value) })) } };
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?policy ?realm')) return { results: { bindings: [{ policy: uri(CLASSIFICATION_INHERIT_POLICY) }] } };
    if (query.includes('?neighbourScore') && query.includes(`rdf:subject <${collection}>`)
      && query.includes(`FILTER(?predicate = <${definition}>)`)) return { results: { bindings: [] } };
    if (query.includes('SELECT ?epoch ?sequence'))
      return { results: { bindings: [row({ epoch: 'epoch', sequence: '1' })] } };
    throw new Error('Hidden relation payload was loaded');
  };
  const page = await readResourceRelations(f.environment, {
    resource: id(1),
    languages: ['en'],
    limit: 1,
    canRead: async () => true,
    disclose: systemDisclosure,
    canReadOccurrence: async () => true,
    summarize: (resources) => f.session.summaries(resources),
  }, f.session);
  expect(page.items.map((item) => item.relation)).toEqual([id(12)]);
  expect(page.next).toBeNull();
});

test('G-904: serial counts fence current child restrictions without a relay event, including signed-in callers and recovery', async () => {
  const f = fixture(),
    work = id(1),
    child = id(2);
  const variant = `urn:rezics:variant:00000000-0000-4000-8000-000000000010`;
  const revision = `urn:rezics:content:revision:00000000-0000-4000-8000-000000000011`;
  const publication = id(12), eligibility = id(13);
  const queryGraph = f.environment.fuseki.query.bind(f.environment.fuseki);
  f.environment.fuseki.query = async query => query.includes('VALUES (?work ?main ?structure)')
    ? { results: { bindings: [row({ work, head: id(900), publication: id(901) })] } }
    : query.includes('SELECT ?occurrence ?variant') ? { results: { bindings: [row({ occurrence: id(3),
      variant, revision, publication, eligibility, epoch: 'epoch', sequence: '1', public: 'true' })] } }
    : queryGraph(query);
  const access = {
    query: async (sql: string) => ({
      rows: sql.includes('FROM access.serial_chapter')
        ? [{ work, occurrence: id(3), resource: child, variant, revision, publication, eligibility }]
        : [
            {
              generation: 'g',
              graph_epoch: 'epoch',
              sequence: '1',
              work,
              main_version: id(4), structure: id(5), structure_head: id(900), publication_head: id(901),
              chapter_count: 1,
              word_count: '8',
              last_updated_at: new Date('2026-09-30T00:00:00Z'),
            },
          ],
    }),
  } as unknown as Pool;
  let relaySequence = '1';
  let retained = true;
  const projection = new SerialStatisticsProjection(
    access,
    { query: async (sql: string) => ({ rows: sql.includes('max(sequence)')
      ? [{ stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: relaySequence }]
      : retained ? [{ graph_sequence: '1' }] : [] }) } as unknown as Pool,
    {} as Pool,
    f.environment,
  );
  expect((await projection.batch([work], '1')).get(work)?.wordCount).toBe(8);
  f.restricted.add(child);
  for (const signed of [false, true]) {
    const reader = fixture(signed).session.viewer;
    const batch = await withDisclosureViewer(reader, () => projection.batch([work], '1'));
    expect(batch.get(work)).toEqual({ chapterCount: null, wordCount: null, lastUpdatedAt: null });
  }
  f.restricted.clear();
  f.restricted.add(id(3));
  expect((await projection.batch([work], '1')).get(work)?.chapterCount).toBeNull();
  f.restricted.clear();
  expect((await projection.batch([work], '1')).get(work)?.chapterCount).toBe(1);
  relaySequence = '2';
  expect((await projection.batch([work], '1')).get(work)?.chapterCount).toBe(1);
  retained = false;
  expect(await projection.batch([work], '1')).toEqual(new Map());
  relaySequence = '1';
  retained = true;
  f.fail();
  await expect(projection.batch([work], '1')).rejects.toThrow('Disclosure owner is unavailable');
});
