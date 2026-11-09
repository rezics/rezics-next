import { expect, test } from 'bun:test';
import type { KernelClient, ReviewedPersonMerge } from '@rezics/client';
import { createImportTransport, importCommandPages, ImportTransportError } from '../src/import-client.ts';
import { CredentialServiceError } from '../src/credentials.ts';
import { formatSeedError } from '../src/seed-cli.ts';
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

test('seed pages isolate identity creates and retain proposal batching, order and exact objects', () => {
  const proposal = {
    op: 'propose' as const,
    key: 'fixture:proposal',
    source: commands[0]!.source,
    subject: subjectId,
    statement: { property: { id: 'schema:inLanguage' }, value: { type: 'value' as const, content: 'en' } },
  };
  const input = [proposal, { ...proposal, key: 'fixture:proposal:2' }, ...commands, proposal];
  const pages = importCommandPages(input, (command) => command, 2);
  expect(pages.map((page) => page.length)).toEqual([2, 1, 1, 1, 1, 1]);
  expect(pages.flat()).toEqual(input);
  pages.flat().forEach((command, index) => expect(command).toBe(input[index]!));
});
for (const status of [429, 503]) {
  for (const limits of [{}, { maxAttempts: 1 }, { maxWaitMs: 0 }, { maxTotalWaitMs: 0 }, { deadlineMs: 100 }]) {
    test(`bulk transport retains original commands and bounds explicit ${status} overloads: ${JSON.stringify(limits)}`, async () => {
      const requests: unknown[] = [];
      const transport = createImportTransport({
        origin: 'https://api.importer.test',
        tokenProvider: async () => 'test-token',
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

test('batch retries keep the exact pending command through the configured attempts and start deadlines after token preparation', async () => {
  let clock = 0;
  let sends = 0;
  const requestBodies: string[] = [];
  const requestStarts: number[] = [];
  const timerStarts: number[] = [];
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => {
      clock += 450;
      return 'test-token';
    },
    maxAttempts: 4,
    now: () => clock,
    schedule: (_callback, _delay) => {
      timerStarts.push(clock);
      return () => {};
    },
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: (async (request: Request) => {
      sends++;
      requestStarts.push(clock);
      requestBodies.push(await request.text());
      const status = sends < 4 ? 503 : 201;
      return Response.json({
        results: [
          status === 201
            ? { key: commands[0]!.key, status, value: { id: subjectId, revision: 1 } }
            : {
                key: commands[0]!.key,
                status,
                problem: { type: 'about:blank', title: 'Unavailable', status, retryable: true },
              },
        ],
      });
    }) as unknown as typeof fetch,
  });

  await expect(transport.batch({ commands: [commands[0]!] })).resolves.toMatchObject({
    results: [{ key: commands[0]!.key, status: 201 }],
  });
  const exactBody = JSON.stringify({ commands: [commands[0]] });
  expect(sends).toBe(4);
  expect(requestBodies).toEqual([exactBody, exactBody, exactBody, exactBody]);
  expect(requestStarts).toEqual([450, 1000, 1650, 2500]);
  expect(timerStarts[0]).toBe(450);
});

test('batch response validation requires a retryability classification for every command problem', async () => {
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    fetch: (async () =>
      Response.json({
        results: [
          {
            key: commands[0]!.key,
            status: 503,
            problem: { type: 'about:blank', title: 'Unavailable', status: 503 },
          },
        ],
      })) as unknown as typeof fetch,
  });

  await expect(transport.batch({ commands: [commands[0]!] })).rejects.toThrow();
});

test('candidate listing keeps the kernel status when the Treaty reply has no Response', async () => {
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    client: {
      subjects: () => ({
        candidates: {
          get: async () => ({
            status: 403,
            data: null,
            error: { value: { type: 'about:blank', code: 'forbidden' } },
          }),
        },
      }),
    } as never,
  });
  try {
    await transport.reviewedCandidates(subjectId, {
      property: 'schema:name',
      context: '00000000-0000-8000-8000-000000000000',
      limit: 100,
    });
    throw new Error('expected denial');
  } catch (error) {
    expect(error).toBeInstanceOf(ImportTransportError);
    expect((error as ImportTransportError).status).toBe(403);
    expect((error as ImportTransportError).code).toBe('forbidden');
  }
});

test('reviewed Subject reads resume one remaining typed overload wait inside the original deadline', async () => {
  const waits: number[] = [];
  let requests = 0;
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: (async () => {
      requests += 1;
      if (requests <= 3)
        return Response.json(
          {
            type: 'https://rezics.com/problems/overloaded',
            status: 503,
            code: 'overloaded',
            retryable: true,
            effect_status: 'not_applicable',
            request_id: `kernel-${requests}`,
          },
          { status: 503, headers: { 'retry-after': '1' } },
        );
      return Response.json({ subject: { id: subjectId } });
    }) as unknown as typeof fetch,
  });

  await expect(transport.readReviewedSubject(subjectId)).resolves.toMatchObject({ subject: { id: subjectId } });
  expect(requests).toBe(4);
  expect(waits).toHaveLength(3);
  expect(waits.every((ms) => ms > 900 && ms <= 1000)).toBe(true);

  let refusedRequests = 0;
  const refused = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    maxWaitMs: 0,
    fetch: (async () => {
      refusedRequests += 1;
      return Response.json(
        {
          type: 'https://rezics.com/problems/overloaded',
          status: 503,
          code: 'overloaded',
          retryable: true,
          effect_status: 'not_applicable',
          request_id: 'kernel-refused',
        },
        { status: 503, headers: { 'retry-after': '1' } },
      );
    }) as unknown as typeof fetch,
  });
  await expect(refused.readReviewedSubject(subjectId)).rejects.toMatchObject({
    status: 503,
    code: 'overloaded',
    phase: 'SubjectGET503',
    correlationId: 'kernel-refused',
  });
  expect(refusedRequests).toBe(1);
});

test('fence retries HTTP 503 then returns current evidence', async () => {
  let requests = 0;
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    sleep: async () => {},
    fetch: (async (_request: Request) => {
      requests++;
      if (requests === 1)
        return Response.json(
          { type: 'https://rezics.com/problems/overloaded', title: 'Overloaded', status: 503, retryable: true },
          { status: 503 },
        );
      return Response.json({ fenced: false, securityRevision: null });
    }) as typeof fetch,
  });
  await expect(transport.fence({ source: 'bangumi', externalId: '1', fieldGroup: 'facts' })).resolves.toEqual({
    fenced: false,
    securityRevision: null,
  });
  expect(requests).toBe(2);
});

test('a thrown fetch keeps the remaining request method and path', async () => {
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    maxAttempts: 1,
    sleep: async () => {},
    fetch: (async (_request: Request): Promise<Response> => {
      throw new TypeError('ECONNREFUSED');
    }) as typeof fetch,
  });
  try {
    await transport.reviewedCandidates(subjectId, {
      property: 'schema:name',
      context: '00000000-0000-4000-8000-000000000000',
      limit: 100,
    });
    throw new Error('expected transport failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ImportTransportError);
    expect((error as ImportTransportError).method).toBe('GET');
    expect((error as ImportTransportError).path).toBe(`/v1/subjects/${subjectId}/candidates`);
  }
});

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
    }) as unknown as typeof fetch,
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

test('transport failure retains safe request metadata and its original network cause', async () => {
  const cause = Object.assign(new Error('Bearer private-token in upstream text'), { code: 'ECONNRESET' });
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'private-token',
    maxAttempts: 1,
    fetch: (async () => {
      throw cause;
    }) as unknown as typeof fetch,
  });
  const failure = await transport.readReviewedSubject(subjectId).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ImportTransportError);
  expect(failure).toMatchObject({
    method: 'GET',
    origin: 'https://api.importer.test',
    path: `/v1/subjects/${subjectId}`,
    failurePhase: 'network',
    networkCode: 'ECONNRESET',
  });
  expect((failure as ImportTransportError).cause).toBe(cause);
  const diagnostic = formatSeedError(failure);
  expect(diagnostic).toContain('network=ECONNRESET');
  expect(diagnostic).not.toContain('private-token');
  expect(diagnostic).not.toContain('upstream text');
});

test('HTTP failure retains only its public problem code and correlation ID', async () => {
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'private-token',
    maxAttempts: 1,
    fetch: (async () =>
      Response.json(
        {
          type: 'https://rezics.com/problems/dependency_unavailable',
          code: 'dependency_unavailable',
          title: 'private response text',
          detail: 'raw imported record body',
        },
        { status: 503, headers: { 'x-request-id': 'req-1234', 'x-private-header': 'secret-header' } },
      )) as unknown as typeof fetch,
  });
  const failure = await transport.readReviewedSubject(subjectId).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ImportTransportError);
  expect(failure).toMatchObject({
    method: 'GET',
    origin: 'https://api.importer.test',
    path: `/v1/subjects/${subjectId}`,
    status: 503,
    code: 'dependency_unavailable',
    phase: 'SubjectGET503',
    failurePhase: 'http',
    correlationId: 'req-1234',
  });
  const diagnostic = formatSeedError(failure);
  expect(diagnostic).toContain('problem=dependency_unavailable');
  expect(diagnostic).toContain('correlation=req-1234');
  expect(diagnostic).not.toContain('private response text');
  expect(diagnostic).not.toContain('raw imported record body');
  expect(diagnostic).not.toContain('secret-header');
  expect(diagnostic).not.toContain('private-token');
});

test('token acquisition reports its own safe Auth failure beside the Import operation', async () => {
  const credential = new CredentialServiceError({
    method: 'POST',
    origin: 'http://auth.importer.test',
    path: '/token',
    phase: 'http',
    status: 503,
    code: 'identity_unavailable',
    correlationId: 'auth-req-7',
  });
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => {
      throw credential;
    },
    maxAttempts: 1,
  });
  const failure = await transport.readReviewedSubject(subjectId).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ImportTransportError);
  expect(failure).toMatchObject({
    method: 'GET',
    path: `/v1/subjects/${subjectId}`,
    failurePhase: 'token',
  });
  expect((failure as ImportTransportError).cause).toBe(credential);
  expect(formatSeedError(failure)).toContain(
    'auth{phase=http method=POST target=http://auth.importer.test/token status=503',
  );
  expect(formatSeedError(failure)).toContain('problem=identity_unavailable');
  expect(formatSeedError(failure)).toContain('correlation=auth-req-7');
});

test('ordinary errors never supply seed diagnostic text, even when it resembles a local failure', () => {
  const untrusted = new TypeError('Bearer abc123 raw imported record body');
  untrusted.name = 'ImportedRecord';
  expect(formatSeedError(untrusted)).toBe('Cross-media seed failed');
  expect(
    formatSeedError(new TypeError('Dump download failed with HTTP 403: https://dl.vndb.org/dump/vndb-db.zst')),
  ).toBe('Cross-media seed failed');
  expect(formatSeedError(new Error('secret token=abc?x=1'))).toBe('Cross-media seed failed');
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
    Response.json(
      { operation: { id: first } },
      { status: 202, headers: { location: `/v1/subjectIdentityOperations/${first}` } },
    ),
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
  expect(await transport.mergeReviewedPersons(body, 'review-key')).toEqual({
    operation: { id: first },
    location: `/v1/subjectIdentityOperations/${first}`,
  });
  expect(await requests[1]!.json()).toEqual(body);
  expect(requests[1]!.headers.get('authorization')).toBe('Bearer review-token');
  expect(requests[1]!.headers.get('idempotency-key')).toBe('"review-key"');
  await expect(transport.mergeReviewedPersons(body, 'review-key')).rejects.toMatchObject({ status: 200 });
  const missingLocation = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'review-token',
    fetch: (async (_request: Request) => Response.json({ operation: { id: first } }, { status: 202 })) as typeof fetch,
  });
  await expect(missingLocation.mergeReviewedPersons(body, 'review-key')).rejects.toThrow(
    'Invalid native identity admission',
  );
});

test('served-variant reads accept only the admitted image decision for the requested derivative', async () => {
  const mediaId = '00000000-0000-4000-8000-000000000201';
  const decision = {
    allowed: true,
    key: 'served/avif-320',
    sha256: 'b'.repeat(64),
    mediaType: 'image/avif',
    byteCount: 2048,
    publicCache: false,
    cacheControl: 'private, no-cache',
  } as const;
  const paths: string[] = [];
  let body: unknown = decision;
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    fetch: (async (request: Request) => {
      const url = new URL(request.url);
      paths.push(`${url.pathname}${url.search}`);
      return Response.json(body);
    }) as typeof fetch,
  });
  await expect(transport.authorizeMediaVariant(mediaId, 'avif-320')).resolves.toEqual(decision);
  body = { ...decision, mediaType: 'image/png' };
  await expect(transport.authorizeMediaVariant(mediaId, 'avif-320')).rejects.toThrow();
  await expect(transport.authorizeMediaVariant(mediaId, 'png-320')).rejects.toThrow();
  expect(paths).toEqual([
    `/v1/media/${mediaId}:authorizeDownload?variant=avif-320`,
    `/v1/media/${mediaId}:authorizeDownload?variant=avif-320`,
  ]);
});

test('transport fetch throws retain the cause', async () => {
  const cause = new TypeError('connect ECONNREFUSED');
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    maxAttempts: 1,
    fetch: (async () => {
      throw cause;
    }) as unknown as typeof fetch,
  });
  try {
    await transport.fence({
      source: 'rezics_reviewed_vocabulary',
      externalId: 'walk-import-ready',
      fieldGroup: 'facts',
    });
    throw new Error('expected transport failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ImportTransportError);
    const transportError = error as ImportTransportError;
    expect(transportError.status).toBeUndefined();
    expect(transportError.failurePhase).toBe('network');
    expect(transportError.method).toBe('GET');
    expect(transportError.origin).toBe('https://api.importer.test');
    expect(transportError.path).toBe('/v1/sourceFences:check');
    expect(transportError.cause).toBe(cause);
  }
});
