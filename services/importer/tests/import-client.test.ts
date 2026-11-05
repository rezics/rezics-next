import { expect, test } from 'bun:test';
import type { KernelClient, ReviewedPersonMerge } from '@rezics/client';
import { createImportTransport } from '../src/import-client.ts';
import type {
  ClassificationAssociation,
  ImportSourceClassificationPutResult,
  ImportSourceClassificationClearResult,
} from '../src/import-contract.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type ClassificationAPI = ReturnType<KernelClient['subjects']>['source-classifications'];
type GeneratedPut = NonNullable<Awaited<ReturnType<ClassificationAPI['$put']['post']>>['data']>;
type GeneratedClear = NonNullable<Awaited<ReturnType<ClassificationAPI['$clear']['post']>>['data']>;
const generatedMutationClosure: [
  Assert<Equal<ImportSourceClassificationPutResult, GeneratedPut>>,
  Assert<Equal<ImportSourceClassificationClearResult, GeneratedClear>>,
  Assert<Equal<ImportSourceClassificationPutResult['state'], 'published' | 'cleared'>>,
  Assert<Equal<ImportSourceClassificationClearResult['state'], 'published' | 'cleared'>>,
] = [true, true, true, true];

const subjectId = '00000000-0000-4000-8000-000000000101';
const commands = [1, 2, 3, 4].map((n) => ({
  op: 'create' as const,
  key: `fixture:${n}:create`,
  source: {
    source: 'fixture',
    external_id: String(n),
    record_revision: '1',
    converter_revision: 'fixture@1',
    digest: 'a'.repeat(64),
    field_group: 'facts' as const,
  },
  subject: { type: 'schema:Book', labels: { en: 'Book' } },
}));
for (const status of [429, 503]) {
  for (const limits of [{}, { maxWaitMs: 0 }, { maxTotalWaitMs: 0 }, { deadlineMs: 100 }]) {
    test(`bulk transport retains original commands and bounds explicit ${status} overloads: ${JSON.stringify(limits)}`, async () => {
      const requests: unknown[] = [];
      const transport = createImportTransport({
        origin: 'https://api.importer.test',
        tokenProvider: async () => 'test-token',
        maxAttempts: 1,
        ...limits,
        sleep: async () => {},
        fetch: (async (request: Request) => {
          const body = (await request.json()) as { commands: typeof commands };
          requests.push(body);
          return Response.json({
            results: body.commands.map((command) =>
              command.key === commands[2]!.key
                ? {
                    key: command.key,
                    status: 403,
                    problem: {
                      type: 'about:blank',
                      title: 'Forbidden',
                      status: 403,
                      code: 'forbidden',
                      retryable: false,
                    },
                  }
                : command.key === commands[1]!.key && requests.length === 1
                  ? {
                      key: command.key,
                      status,
                      problem: {
                        type: 'about:blank',
                        title: 'Overloaded',
                        status,
                        code: 'overloaded',
                        retryable: true,
                      },
                    }
                  : command.key === commands[3]!.key
                    ? {
                        key: command.key,
                        status,
                        problem: { type: 'about:blank', title: 'Refused', status, retryable: false },
                      }
                    : { key: command.key, status: 201, value: { id: subjectId, revision: 1 } },
            ),
          });
        }) as typeof fetch,
      });
      const result = await transport.batch({ commands });
      const retries = Object.keys(limits).length === 0;
      expect(requests).toEqual(retries ? [{ commands }, { commands: [commands[1]] }] : [{ commands }]);
      expect(result.results.map((r) => r.status)).toEqual([201, retries ? 201 : status, 403, status]);
    });
  }
}

test('one batch deadline cancels a pending member retry and releases its timer', async () => {
  let expire!: () => void;
  let clears = 0;
  let sends = 0;
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    importFetch: (async (_request: Request) => {
      sends++;
      return Response.json({
        results: [
          {
            key: commands[0]!.key,
            status: 503,
            problem: { type: 'about:blank', title: 'Overloaded', status: 503, retryable: true },
          },
        ],
      });
    }) as typeof fetch,
    schedule: (callback) => {
      expire = callback;
      return () => {
        clears++;
      };
    },
    sleep: () => {
      expire();
      return new Promise(() => {});
    },
  });
  await expect(transport.batch({ commands: [commands[0]!] })).rejects.toThrow('Import batch deadline exceeded');
  expect(sends).toBe(1);
  expect(clears).toBe(1);
});
const association: ClassificationAssociation = {
  subjectId,
  candidateId: '00000000-0000-4000-8000-000000000201',
  contextId: '00000000-0000-4000-8000-000000000202',
  targetId: '00000000-0000-4000-8000-000000000203',
  property: 'wdt:P136',
  revision: 1,
  release: `sha256:${'a'.repeat(64)}`,
  qualifiersDigest: 'b'.repeat(64),
};
const digest = 'c'.repeat(64);
const observation = {
  sourceAlias: 'trusted-fixture',
  sourceRecordId: 'v123',
  sourceAssociationId: 'g12',
  asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'revision' as const, revision: '7' },
  attribution: 'Example classification provider',
  licence: 'Fixture-1.0',
  confidence: 2.4,
};
const figure = {
  provider: 'vndb' as const,
  association,
  observation: { digest, sourceVersion: observation.sourceVersion },
  sourceAlias: observation.sourceAlias,
  sourceRecordId: observation.sourceRecordId,
  sourceAssociationId: observation.sourceAssociationId,
  confidence: {
    state: 'available' as const,
    value: 2.4,
    unit: 'vndb-tag-rating' as const,
    minExclusive: 0 as const,
    max: 3 as const,
  },
  lie: { state: 'unavailable' as const, reason: 'not_supplied' as const },
  asOf: observation.asOf,
  ageSeconds: 0,
  attribution: observation.attribution,
  licence: observation.licence,
};

test('import transport posts generated classification read, put and clear client methods', async () => {
  const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    fetch: (async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body: JSON.parse(await request.text()),
      });
      const path = new URL(request.url).pathname;
      if (path.endsWith(':read')) return Response.json({ items: [{ state: 'unavailable', reason: 'not_observed' }] });
      if (path.endsWith(':clear')) return Response.json({ observationDigest: digest, state: 'cleared' });
      return Response.json({ observationDigest: digest, state: 'published', figure });
    }) as typeof fetch,
    maxAttempts: 1,
  });

  await expect(
    transport.readSourceClassifications!({
      subjectId,
      associations: [{ ...association, release: 'a'.repeat(64) }],
    }),
  ).rejects.toThrow();
  await expect(transport.readSourceClassifications({ subjectId, associations: [association] })).resolves.toEqual([
    { state: 'unavailable', reason: 'not_observed' },
  ]);
  await expect(
    transport.writeSourceClassification({
      subjectId,
      association,
      value: observation,
      expectedObservation: null,
      idempotencyKey: 'classification:write-1',
    }),
  ).resolves.toEqual({ observationDigest: digest, state: 'published', figure });
  await expect(
    transport.clearSourceClassification({
      subjectId,
      association,
      value: {
        sourceAlias: observation.sourceAlias,
        sourceRecordId: observation.sourceRecordId,
        sourceAssociationId: observation.sourceAssociationId,
        asOf: '2026-11-04T00:00:00.000Z',
        cleared: true,
      },
      expectedObservation: digest,
      idempotencyKey: 'classification:clear-1',
    }),
  ).resolves.toEqual({ observationDigest: digest, state: 'cleared' });

  expect(requests).toEqual([
    {
      method: 'POST',
      path: `/v1/subjects/${subjectId}/source-classifications:read`,
      key: null,
      body: { associations: [association] },
    },
    {
      method: 'POST',
      path: `/v1/subjects/${subjectId}/source-classifications:put`,
      key: '"classification:write-1"',
      body: { association, expectedObservation: null, value: observation },
    },
    {
      method: 'POST',
      path: `/v1/subjects/${subjectId}/source-classifications:clear`,
      key: '"classification:clear-1"',
      body: {
        association,
        expectedObservation: digest,
        value: {
          sourceAlias: observation.sourceAlias,
          sourceRecordId: observation.sourceRecordId,
          sourceAssociationId: observation.sourceAssociationId,
          asOf: '2026-11-04T00:00:00.000Z',
          cleared: true,
        },
      },
    },
  ]);
  expect(generatedMutationClosure).toEqual([true, true, true, true]);
});

test('classification mutation transport rejects malformed and opposite-state success responses', async () => {
  const responses = [
    { operation: 'put', body: { observationDigest: digest, state: 'cleared', figure: {} } },
    { operation: 'put', body: { state: 'published', figure: {} } },
    { operation: 'clear', body: { observationDigest: digest, state: 'published', figure: {} } },
    { operation: 'clear', body: { state: 'cleared' } },
  ] as const;

  for (const item of responses) {
    const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
    const transport = createImportTransport({
      origin: 'https://api.importer.test',
      tokenProvider: async () => 'test-token',
      fetch: (async (request: Request) => {
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          key: request.headers.get('idempotency-key'),
          body: JSON.parse(await request.text()),
        });
        return Response.json(item.body);
      }) as typeof fetch,
    });
    const key = `classification:${item.operation}-uncertain`;
    const clearValue = {
      sourceAlias: observation.sourceAlias,
      sourceRecordId: observation.sourceRecordId,
      sourceAssociationId: observation.sourceAssociationId,
      asOf: '2026-11-04T00:00:00.000Z',
      cleared: true as const,
    };
    const pending =
      item.operation === 'put'
        ? transport.writeSourceClassification!({
            subjectId,
            association,
            value: observation,
            expectedObservation: null,
            idempotencyKey: key,
          })
        : transport.clearSourceClassification!({
            subjectId,
            association,
            value: clearValue,
            expectedObservation: digest,
            idempotencyKey: key,
          });

    await expect(pending).rejects.toThrow();
    expect(requests).toEqual([
      {
        method: 'POST',
        path: `/v1/subjects/${subjectId}/source-classifications:${item.operation}`,
        key: `"${key}"`,
        body: {
          association,
          expectedObservation: item.operation === 'put' ? null : digest,
          value: item.operation === 'put' ? observation : clearValue,
        },
      },
    ]);
  }
});

test('review transport retains coherent query, nullable evidence, exact admission and immutable request bytes', async () => {
  const first = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const second = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const endpoint = {
    subject: first,
    revision: 2,
    securityRevision: '9007199254740993',
    source: 'bangumi' as const,
    externalId: 'person:123',
    claimTransactionId: first,
    property: 'wdt:P6298' as const,
    value: '123',
  };
  const body: ReviewedPersonMerge = {
    subjects: [first, second],
    expectedIdentity: {
      endpoints: [
        endpoint,
        { ...endpoint, subject: second, source: 'vndb', externalId: 's123', property: 'wdt:P3180', value: 's123' },
      ],
    },
  };
  const requests: Request[] = [];
  const answers = [
    Response.json({ subject: { id: first, type: 'schema:Person' }, reviewedIdentity: null }),
    Response.json({ operation: { id: first } }, { status: 202 }),
    Response.json({ survivor: first, redirected: second, revision: 3 }),
  ];
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'review-token',
    fetch: (async (request: Request) => {
      requests.push(request.clone());
      return answers.shift()!;
    }) as typeof fetch,
  });
  expect((await transport.readReviewedPersonIdentity(first, endpoint)).reviewedIdentity).toBeNull();
  const query = new URL(requests[0]!.url).searchParams;
  expect([
    query.get('reviewIdentitySource'),
    query.get('reviewIdentityExternalId'),
    query.get('includeViewerActions'),
  ]).toEqual(['bangumi', 'person:123', 'true']);
  expect(await transport.mergeReviewedPersons(body, 'review-key')).toEqual({ operation: { id: first } });
  expect(await requests[1]!.json()).toEqual(body);
  expect(requests[1]!.headers.get('authorization')).toBe('Bearer review-token');
  expect(requests[1]!.headers.get('idempotency-key')).toBe('"review-key"');
  await expect(transport.mergeReviewedPersons(body, 'review-key')).rejects.toMatchObject({ status: 200 });
});
