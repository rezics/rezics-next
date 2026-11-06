import { afterAll, expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import type { Source } from '../../../../specs/imports-api-driver.ts';
import { discoveryKey } from '../support/released-discovery.ts';
import { closeOwnedSemanticAuth } from '../semantic/outcome-auth.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryDump,
  observedBangumi,
  openDiscoveryImports,
  searchBooks,
  successful,
} from './discovery-user-cases-fixture.ts';

// Cache native setup, including genuine admission failure, without retrying failed writes per case.
let released: ReturnType<typeof createReleasedDiscoveryFixture> | undefined;
const fixture = () =>
  (released ??= (async () => {
    const native = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
    await native.setup.openFeatures(['search', 'search_advanced']);
    return native;
  })());
let population: ReturnType<Awaited<ReturnType<typeof fixture>>['books']> | undefined;
async function books() {
  return (population ??= (await fixture()).books());
}
afterAll(async () => {
  if (released) await (await released).close();
}, 120000);

async function predicates() {
  const f = await fixture();
  const c = await f.classification();
  const words: FilterDocument = {
    and: [
      { type: { in: ['schema:Book'] } },
      { statement: { property: f.meaning.words, range: { gte: 1000001, unit: '1' } } },
    ],
  };
  const formHarem: FilterDocument = {
    and: [
      { type: { in: ['schema:Book'] } },
      { statement: { property: f.meaning.form, in: [c.lightNovel.id] } },
      { statement: { property: 'schema:keywords', in: [c.harem.id] } },
    ],
  };
  return { words, formHarem, combined: { and: [words, formHarem] } as FilterDocument, c };
}

test('catalogue words strictly over one million returns only B-long', async () => {
  const b = await books();
  await searchBooks(await fixture(), (await predicates()).words, [b.subjects['B-long'].id]);
}, 300000);

test('catalogue released light-novel form AND harem returns exactly three books', async () => {
  const b = await books();
  await searchBooks(
    await fixture(),
    (await predicates()).formHarem,
    ['B-long', 'B-edge', 'B-characters'].map((key) => b.subjects[key as keyof typeof b.subjects].id),
  );
}, 300000);

test('catalogue conjunction of words and released form AND harem returns only B-long', async () => {
  const b = await books();
  await searchBooks(await fixture(), (await predicates()).combined, [b.subjects['B-long'].id]);
}, 300000);

test('catalogue harem facet returns the exact selected Concept without population counts', async () => {
  await books();
  const { formHarem, c } = await predicates();
  const response = await (
    await fixture()
  ).request('anonymous', 'POST', '/v1/subjects:facets', {
    filter: formHarem,
    facets: [{ property: 'schema:keywords', size: 20 }],
  });
  successful(response);
  expect(response.body).not.toHaveProperty('total');
  expect(response.body.facets).toEqual([
    {
      property: 'schema:keywords',
      next: null,
      values: [{ value: c.harem.id, labels: expect.any(Object) }],
    },
  ]);
}, 300000);

test('readable Book detail retains selected word amounts and unit without edition page inference', async () => {
  const b = await books();
  const f = await fixture();
  for (const [key, amount] of [
    ['B-long', '+1200001'],
    ['B-edge', '+1000000'],
    ['B-short', '+999999'],
  ] as const) {
    const response = await f.read(b.subjects[key]);
    successful(response);
    expect(response.body.subject).toMatchObject({
      statements: {
        [f.meaning.words]: [expect.objectContaining({ value: { type: 'value', content: { amount, unit: '1' } } })],
      },
    });
  }
  for (const key of ['B-unknown', 'B-characters'] as const) {
    const response = await f.read(b.subjects[key]);
    successful(response);
    expect((response.body.subject as { statements: object }).statements).not.toHaveProperty(f.meaning.words);
  }
}, 300000);

test('readable Book detail projects actual adopted light-novel and source-scoped harem Concept IDs', async () => {
  const f = await fixture();
  const c = await f.classification();
  const b = await books();
  const response = await f.read(b.subjects['B-long']);
  successful(response);
  expect(response.body.subject).toMatchObject({
    statements: {
      [f.meaning.form]: [expect.objectContaining({ value: { type: 'value', content: c.lightNovel.id } })],
      'schema:keywords': [expect.objectContaining({ value: { type: 'value', content: c.harem.id } })],
    },
  });
}, 300000);

test('independently imported selection is shared while Alice and Bob keep separate Library and Collection populations', async () => {
  const f = await fixture();
  const imported = await f.importedHarem();
  const book = { id: imported.subject, release: f.release.digest, revision: 1 };
  const before = await f.read(book);
  successful(before);
  expect(before.body.subject).toMatchObject({
    statements: {
      'schema:keywords': [
        expect.objectContaining({ id: imported.candidate, value: { type: 'value', content: imported.sourceConcept } }),
      ],
    },
  });
  await f.setup.openFeatures(['personal_library']);
  const profile = f.release.definition.libraryProfiles![f.release.definition.types['schema:Book']!.library!.profileId]!;
  const state = profile.entryStateSet!.states[0]!.id;
  successful(await f.request('alice', 'PUT', `/v1/libraryEntries/${book.id}`, { state }, discoveryKey()), 201);
  const alice = await f.request('alice', 'GET', `/v1/libraryEntries/${book.id}`);
  const bob = await f.request('bob', 'GET', `/v1/libraryEntries/${book.id}`);
  successful(alice);
  expect(alice.body.libraryEntry).toMatchObject({ state });
  expect(bob.status).toBe(404);
  expect(bob.body).toMatchObject({ code: 'not_found' });
  expect(bob.body).not.toHaveProperty('libraryEntry');

  for (const [owner, visibility, copies] of [
    ['alice', 'public', 2],
    ['alice', 'private', 1],
    ['bob', 'private', 1],
  ] as const) {
    const created = await f.request(
      owner,
      'POST',
      '/v1/collections',
      {
        title: `${owner} ${visibility} imported reading`,
        visibility,
      },
      discoveryKey(),
    );
    successful(created, 201);
    const collection = created.body.collection as { id: string };
    const memberIds: string[] = [];
    for (let index = 0; index < copies; index++) {
      const added = await f.request(
        owner,
        'POST',
        `/v1/collections/${collection.id}/members`,
        {
          subjectId: book.id,
          note: `${owner} occurrence ${index}`,
        },
        discoveryKey(),
      );
      successful(added, 201);
      memberIds.push((added.body.member as { id: string }).id);
    }
    for (const viewer of ['alice', 'bob', 'anonymous'] as const) {
      const metadata = await f.request(viewer, 'GET', `/v1/collections/${collection.id}`);
      const members = await f.request(viewer, 'GET', `/v1/collections/${collection.id}/members`);
      if (visibility === 'private' && viewer !== owner) {
        expect([metadata.status, members.status]).toEqual([404, 404]);
        expect(metadata.body).not.toHaveProperty('collection');
        expect(members.body).not.toHaveProperty('members');
      } else {
        successful(metadata);
        successful(members);
        expect(metadata.body.collection).toMatchObject({ memberCount: copies });
        expect(members.body.members).toEqual(
          memberIds.map((id) => expect.objectContaining({ id, subjectId: book.id })),
        );
        expect(members.body.next).toBeNull();
      }
    }
  }
  // Neither private population nor a public Collection occurrence adopts catalogue facts.
  for (const viewer of ['anonymous', 'editor', 'alice', 'bob'] as const) {
    const current = await f.read(book, viewer);
    successful(current);
    expect(current.body.subject).toEqual(before.body.subject);
  }
}, 300000);

let imported: ReturnType<typeof openDiscoveryImports> | undefined;
const imports = () =>
  (imported ??= (async () => {
    // Auth's native workflow host is process-owned. Finish the released consumer group before starting Imports.
    if (released) await (await released).close();
    await closeOwnedSemanticAuth();
    return openDiscoveryImports();
  })());
const importedRuns = new Map<Source, Promise<void>>();
async function load(source: Source) {
  if (!importedRuns.has(source))
    importedRuns.set(
      source,
      (async () => {
        const native = await imports();
        expect((await native.runtime.run(await discoveryDump(source))).outcome).toBe('complete');
      })(),
    );
  await importedRuns.get(source);
  return imports();
}
afterAll(async () => {
  if (imported) await (await imported).close();
}, 120000);

const providerCases = [
  ['bangumi', '498', 'schema:Book', ['schema:name']],
  ['vndb', 'v1', 'wd:Q689445', ['schema:name', 'schema:inLanguage']],
  ['openlibrary', '/works/OL1W', 'schema:Book', ['schema:name']],
  ['wikidata', 'Q1', 'schema:Book', ['schema:name', 'wdt:P648']],
] as const;
for (const [source, key, type, properties] of providerCases)
  test(`${source} ordinary importer candidates survive editor accept/adopt and anonymous selected read with citations`, async () => {
    const native = await load(source);
    const result = await native.selected(source, key, properties);
    expect(result.subject.type).toBe(type);
    expect(result.subject.statements).not.toHaveProperty('schema:wordCount');
    for (const candidate of result.view.proposals) {
      expect(candidate.source).toBe(source);
      expect(candidate.externalId).toBe(key);
      expect(candidate.recordDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(candidate.references)).toContain(
        {
          bangumi: 'https://bgm.tv/subject/498',
          vndb: 'https://vndb.org/v1.7',
          openlibrary: 'https://openlibrary.org/works/OL1W',
          wikidata: 'https://www.wikidata.org/wiki/Q1?oldid=101',
        }[source],
      );
    }
  }, 300000);

test('Open Library edition keeps unsupported pages unknown and language separate from work identity and absent work words', async () => {
  const native = await load('openlibrary');
  const work = await native.observer.read('openlibrary', '/works/OL1W');
  const edition = await native.selected('openlibrary', '/books/OL1M', ['schema:inLanguage']);
  expect(edition.subject.type).toBe('bf:Instance');
  expect(edition.subject.id).not.toBe(work.subject!.id);
  expect(edition.subject.statements).not.toHaveProperty('schema:numberOfPages');
  expect(edition.view.proposals.some((p) => p.statement?.property.id === 'schema:numberOfPages')).toBe(false);
  // Current runtime has no identifierLookup. Preserve unresolved work evidence, never inject its returned ID.
  expect(edition.view.proposals).toContainEqual(
    expect.objectContaining({
      statement: expect.objectContaining({
        property: expect.objectContaining({ id: 'schema:exampleOfWork' }),
        value: { type: 'somevalue' },
      }),
    }),
  );
  expect(work.subject!.statements).not.toHaveProperty('schema:wordCount');
}, 300000);

test('Bangumi observed manga meta_tags and ordinary novel tags never imply light novel or imported words', async () => {
  const native = await load('bangumi');
  const observed = await observedBangumi();
  expect(observed.meta_tags).toContain('后宫');
  const view = await native.observer.read('bangumi', '498');
  expect(view.proposals.some((p) => ['schema:wordCount', 'wdt:P7937'].includes(p.statement?.property.id ?? ''))).toBe(
    false,
  );
  // Separate controlled native input; no invented observation or classification binding.
  const dump = await discoveryDump('bangumi');
  dump.bytes = new TextEncoder().encode(
    JSON.stringify(observed) +
      '\n' +
      JSON.stringify({
        id: 499,
        type: 1,
        name: 'Controlled light novel',
        tags: [{ name: '后宫' }, { name: '小说' }],
        platform: '小说',
      }) +
      '\n',
  );
  expect((await native.runtime.run(dump)).outcome).toBe('complete');
  const control = await native.observer.read('bangumi', '499');
  expect(
    control.proposals.some((p) =>
      ['schema:keywords', 'wdt:P7937', 'schema:wordCount'].includes(p.statement?.property.id ?? ''),
    ),
  ).toBe(false);
}, 300000);

test('imported selected metadata public read exposes sourceRecords without inventing unknown registration metadata', async () => {
  const native = await load('bangumi');
  // Read the selection established through the actual editor APIs; no source-record writer or facts rights.
  const response = await native.runtime.request(
    `/v1/subjects/${native.observer.subject('bangumi', '498')}?${new URLSearchParams({ context: native.context })}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { subject: { sourceRecords?: unknown[] } };
  expect(body.subject.sourceRecords).toEqual([]);
}, 300000);

test('imported synopsis remains a proposal until separate Context and Global adoption, then exact support is independently current', async () => {
  const native = await load('bangumi');
  const dump = await discoveryDump('bangumi');
  dump.bytes = new TextEncoder().encode(
    `${JSON.stringify({
      ...(await observedBangumi()),
      summary: 'Controlled imported synopsis for independent current reads.',
    })}\n`,
  );
  expect((await native.runtime.run(dump)).outcome).toBe('complete');
  const view = await native.observer.read('bangumi', '498');
  const candidate = view.proposals.find((proposal) => proposal.statement?.property.id === 'schema:abstract')!;
  expect(candidate).toBeDefined();
  const id = view.subject!.id;
  const global = '00000000-0000-8000-8000-000000000000';
  const publicRead = async () => {
    const response = await native.runtime.request(`/v1/subjects/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as { subject: typeof view.subject };
  };
  expect((await publicRead()).subject!.statements).not.toHaveProperty('schema:abstract');
  await native.selected('bangumi', '498', ['schema:abstract']);
  // Selection in an editorial Context does not silently select the same candidate in Global.
  expect((await publicRead()).subject!.statements).not.toHaveProperty('schema:abstract');
  successful(
    await native.observer.http('/v1/grants', {
      resource: { route: 0, id: global },
      subject: { kind: 'account', id: native.runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    }),
    201,
  );
  successful(
    await native.observer.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, {
      context: global,
      expected_head: null,
    }),
  );
  // Acceptance alone also leaves the current public slot unchanged.
  expect((await publicRead()).subject!.statements).not.toHaveProperty('schema:abstract');
  successful(
    await native.observer.http(`/v1/subjects/${id}:adopt`, {
      context: global,
      property: 'schema:abstract',
      mode: 'replace',
      expected_head: null,
      selection: [{ candidate: candidate.id, rank: 'normal' }],
    }),
  );
  const current = (await publicRead()).subject!;
  expect(current.statements['schema:abstract']).toHaveLength(1);
  const selected = current.statements['schema:abstract']![0]!;
  expect(selected.id).toBe(candidate.id);
  const reference = selected.value.content as { document: string; digest: string; language: string };
  const document = await native.runtime.request(`/v1/documents/${reference.document}`);
  expect(document.status).toBe(200);
  expect(JSON.stringify(await document.json())).toContain('Controlled imported synopsis');
  const query = {
    statement: candidate.id,
    document: reference.document,
    digest: reference.digest,
    language: reference.language,
    context: global,
    release: current.release,
  };
  const exact = await native.runtime.request(
    `/v1/subjects/${id}?${new URLSearchParams({
      selectedSynopsis: JSON.stringify(query),
    })}`,
  );
  expect(exact.status).toBe(200);
  const support = ((await exact.json()) as { selectedSynopsis: unknown }).selectedSynopsis;
  expect(support).toMatchObject({
    kind: 'matched',
    context: global,
    release: current.release,
    fact: { id: candidate.id, value: { type: 'somevalue' }, references: selected.references },
  });
  for (const operand of [reference.document, reference.digest, 'Controlled imported synopsis'])
    expect(JSON.stringify(support)).not.toContain(operand);
}, 300000);
