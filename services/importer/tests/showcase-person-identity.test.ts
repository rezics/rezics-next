import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bangumiVoiceDraft, deliverBangumiCreatorCredits } from '../src/bangumi-creator-credits.ts';
import { CrossMediaGraph, type GraphEdgeDraft } from '../src/cross-media-bindings.ts';
import { bundledDigest } from '@rezics/definitions/bundled';
import {
  observePersonIdentity,
  personIdentityForSource,
  selectPersonReviewPair,
} from '../src/showcase-person-identity.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaPort,
} from '../src/cross-media-seed.ts';
import { buildShowcaseManifest } from '../src/showcase-manifest.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../src/showcase-publication.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const currentPersonId = '4a7a8b35-32b5-45a1-9b5f-c0d69fc23108';

test('seed review keeps admitted source bytes and original bindings across canonical reads and reopen', async () => {
  // Source-shaped controls and a local protocol double; no native merge or pinned-dump pass is implied.
  const plan = emptyCrossMediaPlan();
  plan.entities.bangumi.push({
    source: 'bangumi',
    key: 'person:1916',
    revision: 'fixture-1',
    payload: {
      id: 1916,
      type: 1,
      name: '麻枝准',
      summary: 'Source biography',
    },
  });
  plan.entities.vndb.push({
    source: 'vndb',
    key: 's224',
    revision: 'fixture-2',
    payload: {
      id: 's224',
      main: '28069',
      prod: null,
      name: '前田 純',
      staff_alias: [{ id: 's224', aid: '28069', name: '前田 純', latin: 'Maeda Jun' }],
    },
  });
  const original = new Map<string, string>();
  const commands: BatchCommand[] = [];
  const port: CrossMediaPort = {
    async batch(request) {
      commands.push(...structuredClone(request.commands));
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const id = randomUUID();
            original.set(command.source.external_id, id);
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          return {
            key: command.key,
            status: 201 as const,
            value: command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 },
          };
        }),
      };
    },
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject() {
      return read({
        id: currentPersonId,
        type: 'schema:Person',
        labels: { und: '麻枝准' },
        statements: {
          'wdt:P6298': [{ value: { type: 'value', content: '1916' } }],
          'wdt:P3180': [{ value: { type: 'value', content: 's224' } }],
        },
      });
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'person-review-handoff-'));
  const journal = new ShowcaseJournal(join(directory, 'journal.sqlite'));
  const captured = captureShowcaseCommands(port, journal);
  try {
    const path = join(directory, 'state.sqlite');
    const first = await seedCrossMedia(plan, path, captured, { origin: 'https://fixture.test' });
    const pair = first.personReview!.pair;
    expect(pair.state).toBe('selected');
    if (pair.state !== 'selected') throw new Error('Expected selected source records');
    expect(pair.sources.map((entry) => entry.boundSubjectId)).toEqual([
      original.get('person:1916')!,
      original.get('s224')!,
    ]);
    expect(pair.sources.map((entry) => entry.record)).toEqual([plan.entities.bangumi[0]!, plan.entities.vndb[0]!]);
    expect(first.personIdentities.map((entry) => entry.currentSubjectId)).toEqual([currentPersonId, currentPersonId]);
    const manifest = buildShowcaseManifest({
      plan,
      readings: first.readings,
      acknowledgements: journal.acknowledgedCommands(),
      aliases: crossMediaAliases,
    });
    for (const record of manifest.records) {
      expect(record.subjectId).toBe(original.get(record.sourceKey)!);
      expect(record.assertions.length).toBeGreaterThan(0);
    }
    expect(manifest.records).toHaveLength(2);
    for (const entry of pair.sources) {
      const identifier = commands.find(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === entry.identity.externalId &&
          command.statement.property.id === entry.identity.property,
      );
      expect(identifier?.source).toMatchObject({ digest: entry.digest, converter_revision: entry.converterRevision });
    }
    const sealed = JSON.stringify(commands);
    const reopened = await seedCrossMedia(plan, path, captured, { origin: 'https://fixture.test' });
    expect(reopened.personReview).toEqual(first.personReview);
    expect(JSON.stringify(commands)).toBe(sealed);
    expect(selectPersonReviewPair(first.personReviewSources!, { bangumi: 'person:1917', vndb: 's224' })).toEqual({
      state: 'incomplete',
      missing: [{ source: 'bangumi', externalId: 'person:1917' }],
    });
    // A caller editing its plan after selection cannot rewrite the captured comparison evidence.
    plan.entities.bangumi[0]!.payload.name = 'Changed name';
    expect(pair.sources[0].record.payload.name).toBe('麻枝准');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('review and public reads follow native canonical redirects without changing source bindings or origins', async () => {
  const { createImportTransport } = await import('../src/import-client.ts');
  const original = '00000000-0000-4000-8000-000000000008';
  const seen: Request[] = [];
  const native = read({ id: currentPersonId, type: 'schema:Person', statements: {} });
  let cyclic = false;
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request);
    return new URL(request.url).pathname.endsWith(original)
      ? Response.json(
          { redirect: { from: original, to: cyclic ? original : currentPersonId } },
          { status: 308, headers: { location: 'https://foreign.test/private' } },
        )
      : Response.json(native);
  }) as typeof fetch;
  const publicClient = createPublicBulkClient({ origin: 'https://kernel.test', fetch: upstream });
  expect(await publicClient.readSubject(original)).toEqual(native);
  const transport = createImportTransport({
    origin: 'https://kernel.test',
    tokenProvider: async () => 'reviewer',
    fetch: upstream,
    maxAttempts: 1,
  });
  expect(await transport.readReviewedSubject(original)).toEqual(native);
  expect(seen.every((request) => new URL(request.url).origin === 'https://kernel.test')).toBe(true);
  expect(seen.slice(0, 2).every((request) => !request.headers.has('authorization'))).toBe(true);
  expect(seen.slice(2).every((request) => request.headers.get('authorization') === 'Bearer reviewer')).toBe(true);
  cyclic = true;
  await expect(publicClient.readSubject(original)).rejects.toThrow('Cyclic public subject redirect');
  await expect(transport.readReviewedSubject(original)).rejects.toThrow('Cyclic reviewed subject redirect');
});

function read(subject: unknown): ReviewedSubjectRead {
  return { subject } as ReviewedSubjectRead;
}

test('a reviewed native merge resolves both exact provider bindings to the current Person', () => {
  // Authored IDs keep this unit fixture independent of the pinned source data.
  const bangumi = personIdentityForSource('bangumi', 'person:8', 'schema:Person')!;
  const vndb = personIdentityForSource('vndb', 's7', 'schema:Person')!;
  const current = read({
    id: currentPersonId,
    type: 'schema:Person',
    statements: {
      'wdt:P6298': [{ value: { type: 'value', content: '8' } }],
      'wdt:P3180': [{ value: { type: 'value', content: 's7' } }],
    },
  });

  expect(observePersonIdentity(bangumi, current)).toEqual({
    state: 'current',
    currentSubjectId: currentPersonId,
    identity: bangumi,
  });
  expect(observePersonIdentity(vndb, current)).toEqual({
    state: 'current',
    currentSubjectId: currentPersonId,
    identity: vndb,
  });
});

test('missing, conflicting and non-Person identity evidence stays unresolved', () => {
  const identity = personIdentityForSource('vndb', 's7', 'schema:Person')!;
  expect(
    observePersonIdentity(
      identity,
      read({
        id: currentPersonId,
        type: 'schema:Person',
        statements: {},
      }),
    ).state,
  ).toBe('missing');
  expect(
    observePersonIdentity(
      identity,
      read({
        id: currentPersonId,
        type: 'schema:Person',
        statements: {
          'wdt:P3180': [{ value: { type: 'value', content: 's7' } }, { value: { type: 'value', content: 's9' } }],
        },
      }),
    ).state,
  ).toBe('conflicting');
  expect(
    observePersonIdentity(
      identity,
      read({
        id: currentPersonId,
        type: 'schema:Organization',
        statements: { 'wdt:P3180': [{ value: { type: 'value', content: 's7' } }] },
      }),
    ).state,
  ).toBe('wrong_type');
});

test('only exact source key forms on Person records participate in reviewed identity reads', () => {
  expect(personIdentityForSource('bangumi', 'person:8', 'schema:Person')).toMatchObject({
    property: 'wdt:P6298',
    value: '8',
  });
  expect(personIdentityForSource('vndb', 's7', 'schema:Person')).toMatchObject({
    property: 'wdt:P3180',
    value: 's7',
  });
  expect(personIdentityForSource('vndb', 'p7', 'schema:Person')).toBeUndefined();
  expect(personIdentityForSource('bangumi', 'person:8', 'schema:Organization')).toBeUndefined();
  expect(personIdentityForSource('bangumi', 'person:8\n', 'schema:Person')).toBeUndefined();
  expect(personIdentityForSource('vndb', 's7\n', 'schema:Person')).toBeUndefined();
});

test('current identity ignores deprecated identifiers but retains conflicting non-value evidence', () => {
  const identity = personIdentityForSource('vndb', 's224', 'schema:Person')!;
  const subject = {
    id: currentPersonId,
    type: 'schema:Person',
    statements: {
      'wdt:P3180': [
        { rank: 'normal', value: { type: 'value', content: 's224' } },
        { rank: 'deprecated', value: { type: 'value', content: 's7' } },
      ],
    },
  };
  expect(observePersonIdentity(identity, read(subject)).state).toBe('current');
  subject.statements['wdt:P3180'].push({ rank: 'normal', value: { type: 'someValue', content: '' } });
  expect(observePersonIdentity(identity, read(subject)).state).toBe('conflicting');
});

test('Jun Maeda discovery retains the exact source records until a reviewer confirms the human bridge', () => {
  // Public-record candidate; the pinned dump rows, digests, and native bindings remain separately required.
  const candidate = {
    bangumi: {
      externalId: 'person:1916',
      record: 'https://bgm.tv/person/1916',
      work: 'https://bgm.tv/subject/1851',
      creditedName: '麻枝准',
    },
    vndb: {
      externalId: 's224',
      record: 'https://vndb.org/s224',
      work: 'https://vndb.org/v4',
      creditedName: 'Maeda Jun',
    },
    independentEvidence: 'https://artist.cdjournal.com/a/maeda-jun/842760',
  } as const;
  const bangumi = personIdentityForSource('bangumi', candidate.bangumi.externalId, 'schema:Person')!;
  const vndb = personIdentityForSource('vndb', candidate.vndb.externalId, 'schema:Person')!;

  expect(bangumi).toEqual({
    source: 'bangumi',
    externalId: 'person:1916',
    property: 'wdt:P6298',
    value: '1916',
  });
  expect(vndb).toEqual({
    source: 'vndb',
    externalId: 's224',
    property: 'wdt:P3180',
    value: 's224',
  });
  const bangumiOriginal = read({
    id: '00000000-0000-4000-8000-000000001916',
    type: 'schema:Person',
    statements: { 'wdt:P6298': [{ value: { type: 'value', content: '1916' } }] },
  });
  expect(observePersonIdentity(bangumi, bangumiOriginal).state).toBe('current');
  expect(observePersonIdentity(vndb, bangumiOriginal).state).toBe('missing');
});

test('Bangumi credit replay keeps the durable source endpoint after its reviewed Person is redirected', async () => {
  // Synthetic bindings, native UUIDs and source fields are authored controls for this unit test.
  const bound = {
    '1': '00000000-0000-4000-8000-000000000001',
    'person:8': '00000000-0000-4000-8000-000000000008',
    'character:3': '00000000-0000-4000-8000-000000000003',
  };
  const canonicalPerson = '00000000-0000-4000-8000-000000000018';
  const current = new Map<string, unknown>([
    [
      bound['1']!,
      {
        subject: {
          id: bound['1'],
          type: 'schema:TVSeries',
          statements: { 'wdt:P5732': [{ value: { type: 'value', content: '1' } }] },
        },
      },
    ],
    [
      bound['person:8']!,
      {
        subject: {
          id: canonicalPerson,
          type: 'schema:Person',
          statements: { 'wdt:P6298': [{ value: { type: 'value', content: '8' } }] },
        },
      },
    ],
    [
      bound['character:3']!,
      {
        subject: {
          id: bound['character:3'],
          type: 'wd:Q95074',
          statements: { 'wdt:P6296': [{ value: { type: 'value', content: '3' } }] },
        },
      },
    ],
  ]);
  const commands: Extract<BatchCommand, { op: 'propose' }>[] = [];
  const result = await deliverBangumiCreatorCredits({
    alias: 'bangumi_cross_media',
    drafts: [bangumiVoiceDraft({ subject_id: 1, person_id: 8, character_id: 3 }, 2)],
    bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    claim: ({ external_id }) => ({ state: 'bound', subject: bound[external_id as keyof typeof bound]! }),
    async batch(request) {
      for (const command of request.commands) if (command.op === 'propose') commands.push(command);
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value: { candidate: currentPersonId, revision: 1 },
        })),
      };
    },
    async fence() {
      return { fenced: false };
    },
    async read(id) {
      return current.get(id) as ReviewedSubjectRead;
    },
    expectedNativeType(externalId) {
      return externalId === '1' ? 'schema:TVSeries' : externalId.startsWith('person:') ? 'schema:Person' : 'wd:Q95074';
    },
    metadataFor() {
      return { digest: 'a'.repeat(64), recordRevision: 'authored', recordUrl: 'https://bgm.tv/subject/1' };
    },
  });

  expect(result.gaps).toEqual([]);
  expect(result.identities['person:8']).toMatchObject({ id: bound['person:8'], type: 'schema:Person' });
  expect(result.canonicalPersons['person:8']).toBe(canonicalPerson);
  expect(commands).toHaveLength(1);
  expect(commands[0]!.statement.value).toMatchObject({ type: 'value', content: bound['person:8'] });
});

test('VNDB Person credits stay unresolved when the current exact provider identity is withdrawn', async () => {
  const database = new Database(':memory:');
  const graph = new CrossMediaGraph(database);
  const draft: GraphEdgeDraft = {
    source: 'vndb',
    alias: 'vndb_cross_media',
    table: 'vn_seiyuu',
    holder: 'v1',
    target: 's7',
    property: 'wdt:P725',
    url: 'https://vndb.org/v1',
    membership: 'family',
    record: { id: 'v1', aid: '7', cid: 'c3' },
    fields: ['vn_seiyuu'],
  };
  graph.remember([draft]);
  let batches = 0;
  try {
    const result = await graph.deliver({
      claim: ({ external_id }) => ({
        state: 'bound',
        subject: external_id === 'v1' ? currentPersonId : '00000000-0000-4000-8000-000000000007',
      }),
      nativeType: (externalId) => (externalId === 's7' ? 'schema:Person' : 'wd:Q20631656'),
      currentRelationEndpoint: async () => 'current',
      async currentPersonIdentity() {
        const identity = personIdentityForSource('vndb', 's7', 'schema:Person')!;
        const withdrawn = read({ id: currentPersonId, type: 'schema:Person', statements: {} });
        return observePersonIdentity(identity, withdrawn).state === 'current';
      },
      async fence() {
        return { fenced: false, securityRevision: null };
      },
      async batch() {
        batches++;
        return { results: [] };
      },
    });

    expect(batches).toBe(0);
    expect(result.unresolved).toMatchObject([{ reason: 'current_person_identity_unavailable:s7' }]);
  } finally {
    database.close();
  }
});

test('review transport keeps original source observations, decimal security revisions and exact uncertain retries', async () => {
  const { createImportTransport, ImportTransportError } = await import('../src/import-client.ts');
  const original = '00000000-0000-4000-8000-000000000008';
  const other = '00000000-0000-4000-8000-000000000007';
  const endpoint = {
    subject: original,
    revision: 9,
    securityRevision: '9007199254740993',
    source: 'bangumi' as const,
    externalId: 'person:8',
    claimTransactionId: '00000000-0000-4000-8000-000000000088',
    property: 'wdt:P6298' as const,
    value: '8',
  };
  const body = {
    subjects: [original, other],
    expectedIdentity: {
      endpoints: [
        endpoint,
        {
          ...endpoint,
          subject: other,
          source: 'vndb',
          externalId: 's7',
          property: 'wdt:P3180',
          value: 's7',
        },
      ],
    },
  } as import('@rezics/client').ReviewedPersonMerge;
  let synchronousMergeCalls = 0;
  const synchronousMerge = createImportTransport({
    origin: 'https://kernel.import.test',
    tokenProvider: async () => 'original-token',
    maxAttempts: 1,
    fetch: Object.assign(
      async () => {
        synchronousMergeCalls++;
        return Response.json({ survivor: original, redirected: other, revision: 2 }, { status: 200 });
      },
      { preconnect() {} },
    ),
  });
  await expect(synchronousMerge.mergeReviewedPersons(body, 'synchronous-result')).rejects.toMatchObject({
    status: 200,
  });
  expect(synchronousMergeCalls).toBe(1);

  const requests: { url: URL; headers: Headers; body: string }[] = [];
  let attempt = 0;
  const transport = createImportTransport({
    origin: 'https://kernel.import.test',
    tokenProvider: async () => 'original-token',
    session: 'original-session',
    maxAttempts: 1,
    fetch: (async (request: Request) => {
      requests.push({ url: new URL(request.url), headers: request.headers, body: await request.text() });
      if (request.method === 'GET')
        return Response.json({
          subject: { id: original, type: 'schema:Person', statements: {} },
          reviewedIdentity: endpoint,
        });
      if (++attempt === 1) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      return Response.json({ operation: { id: currentPersonId } }, { status: 202 });
    }) as typeof fetch,
  });
  const observed = await transport.readReviewedPersonIdentity(original, { source: 'bangumi', externalId: 'person:8' });
  expect(observed.reviewedIdentity?.securityRevision).toBe('9007199254740993');
  expect(requests[0]!.url.searchParams.get('reviewIdentitySource')).toBe('bangumi');
  expect(requests[0]!.url.searchParams.get('reviewIdentityExternalId')).toBe('person:8');
  await expect(transport.mergeReviewedPersons(body, 'review-intent')).rejects.toBeInstanceOf(ImportTransportError);
  expect(await transport.mergeReviewedPersons(body, 'review-intent')).toEqual({ operation: { id: currentPersonId } });
  expect(requests[1]!.url.pathname).toBe('/v1/subjects:merge');
  expect(requests[2]!.body).toBe(requests[1]!.body);
  expect(JSON.parse(requests[2]!.body)).toEqual(body);
  for (const request of requests.slice(1)) {
    expect(request.headers.get('idempotency-key')).toBe('"review-intent"');
    expect(request.headers.get('authorization')).toBe('Bearer original-token');
    expect(request.headers.get('rezics-session-token')).toBe('original-session');
  }
});

test('an identity observation for a followed endpoint cannot stand in for the reviewed original', async () => {
  const { createImportTransport } = await import('../src/import-client.ts');
  const transport = createImportTransport({
    origin: 'https://kernel.import.test',
    tokenProvider: async () => 'token',
    maxAttempts: 1,
    fetch: (async (_request: Request) =>
      Response.json({
        subject: { id: currentPersonId, type: 'schema:Person', statements: {} },
        reviewedIdentity: {
          subject: currentPersonId,
          revision: 1,
          securityRevision: '1',
          source: 'vndb',
          externalId: 's7',
          claimTransactionId: currentPersonId,
          property: 'wdt:P3180',
          value: 's7',
        },
      })) as typeof fetch,
  });
  await expect(
    transport.readReviewedPersonIdentity('00000000-0000-4000-8000-000000000007', {
      source: 'vndb',
      externalId: 's7',
    }),
  ).rejects.toThrow('Invalid import transport data');
});
