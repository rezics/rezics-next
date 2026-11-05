import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { bangumiVoiceDraft, deliverBangumiCreatorCredits } from '../src/bangumi-creator-credits.ts';
import { CrossMediaGraph, type GraphEdgeDraft } from '../src/cross-media-bindings.ts';
import { bundledDigest } from '@rezics/definitions/bundled';
import { observePersonIdentity, personIdentityForSource } from '../src/showcase-person-identity.ts';

const currentPersonId = '4a7a8b35-32b5-45a1-9b5f-c0d69fc23108';

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
