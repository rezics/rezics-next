import { expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import {
  KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_NATIVE_RESULT_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
  kindConsentEnrollmentVerifiedActual,
  kindConsentEnrollmentVerifiedBound,
  kindConsentOperationBound,
  kindConsentTransportActual,
  kindConsentTransportBound,
  type KindConsentEnrollmentInput,
  type KindConsentInvalidationInput,
  type KindConsentOperation,
  type KindConsentWorkDeclaration,
} from '@rezics/auth-contract';
import { testDatabase } from '../scripts/database.ts';
import { createKindConsentParticipant, withKindConsentEnrollmentDeadline } from '../src/kind-consent.ts';

test('canonical enrollment ceiling covers every admitted maximum JSON row-array path and native actual composition', async () => {
  const scopes = Array.from({ length: 512 }, (_, index) => `${index.toString(16).padStart(3, '0')}${'x'.repeat(125)}`);
  const identifier = '\\'.repeat(1024);
  const referenceId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const input: KindConsentEnrollmentInput = {
    accountId: identifier,
    clientId: identifier,
    requestedScopes: scopes,
    consumer: {
      route: identifier,
      ownerAccountId: identifier,
      collectionId: identifier,
      preparationId: identifier,
      originId: identifier,
    },
  };
  const currentRow = {
    client_id: identifier,
    client_scopes: scopes,
    first_party: false,
    ready: true,
    reducing: false,
    consent_scopes: scopes,
    pending_scopes: scopes,
    revision: '9223372036854775807',
  };
  const existingRow = {
    reference_id: referenceId,
    account_id: identifier,
    client_id: identifier,
    requested_scopes: scopes,
    effective_scopes: scopes,
    consumer_route: identifier,
    owner_account_id: identifier,
    collection_id: identifier,
    preparation_id: identifier,
    origin_id: identifier,
    active: false,
  };
  const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
  const emptyRowsBytes = jsonBytes([]);
  const noStoredConsentCurrentRow = {
    ...currentRow,
    consent_scopes: null,
    pending_scopes: null,
    revision: null,
  };
  const admittedPathBytes = [
    2 * emptyRowsBytes + jsonBytes([currentRow]) + jsonBytes([{ reference_id: referenceId }]),
    2 * emptyRowsBytes + jsonBytes([noStoredConsentCurrentRow]) + jsonBytes([{ reference_id: referenceId }]),
    3 * emptyRowsBytes + jsonBytes([currentRow]),
    emptyRowsBytes + jsonBytes([currentRow]) + jsonBytes([existingRow]),
    2 * emptyRowsBytes + jsonBytes([{ ...currentRow, ready: false }]),
    jsonBytes([{ '?column?': 1 }]),
  ];
  expect(KIND_CONSENT_ENROLLMENT_NATIVE_RESULT_MAX_BYTES).toBe(Math.max(...admittedPathBytes));

  const inputBytes =
    128 +
    [
      input.accountId,
      input.clientId,
      input.consumer.route,
      input.consumer.ownerAccountId,
      input.consumer.collectionId,
      input.consumer.preparationId,
      input.consumer.originId,
      ...input.requestedScopes,
    ].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  const bound = kindConsentOperationBound(input);
  expect(bound?.source.bytes).toBe(inputBytes + KIND_CONSENT_ENROLLMENT_NATIVE_RESULT_MAX_BYTES);

  const connection = {
    async query(sql: string) {
      if (sql.startsWith('SELECT 1 FROM auth_kind_consent_transition')) return { rows: [] };
      if (sql.startsWith('SELECT c.client_id')) return { rows: [currentRow] };
      if (sql.startsWith('SELECT reference_id,account_id,client_id')) return { rows: [existingRow] };
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const database = { connect: async () => connection } as unknown as Pool;
  const { participant } = createKindConsentParticipant({ database });
  const result = await participant.enroll(input);
  expect(result).toEqual({ status: 'unavailable' });

  const lookalikeInput = {
    ...input,
    requestedScopes: [...input.requestedScopes],
    consumer: { ...input.consumer },
  };
  expect(participant.enroll.actual(lookalikeInput, result)).toBeUndefined();
  const nativeActual = participant.enroll.actual(input, result);
  expect(nativeActual?.source.bytes).toBe(inputBytes + admittedPathBytes[2]!);
  expect(nativeActual?.source.bytes).toBeLessThanOrEqual(bound!.source.bytes);
  expect(participant.enroll.actual(input, result)).toBeUndefined();

  const verifiedBound = kindConsentEnrollmentVerifiedBound(input)!;
  const verifiedActual = kindConsentEnrollmentVerifiedActual(input, nativeActual, {
    accessTokenBytes: KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES,
    jwksRequestBytes: KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES,
    jwksResponseBytes: KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES,
    httpControlBytes: KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES,
  })!;
  expect(verifiedActual.source.bytes).toBe(verifiedBound.source.bytes);
  const transportBound = kindConsentTransportBound(input)!;
  const transportActual = kindConsentTransportActual(
    input,
    verifiedActual,
    KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES,
    KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
    KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES,
  )!;
  expect(transportActual.source.bytes).toBe(transportBound.source.bytes);
});

test('a native enrolled Kind consumer is fenced before consent/client authority changes and concurrent or restored enrollment cannot escape', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url });
  const committed = new Map<string, KindConsentInvalidationInput>();
  const verified = new Set<string>();
  const receiverWork: KindConsentWorkDeclaration = {
    source: {
      candidateKeys: 1,
      nativeRows: 1,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: 2,
      witnessKeys: 1,
      statements: 2,
      bytes: 1024,
    },
    access: { keys: 1, points: 4, witnesses: 1, rows: 2, bytes: 1024, emptySeeks: 1 },
  };
  function receiverOperation<Input, Output>(
    run: (input: Input) => Promise<Output>,
  ): KindConsentOperation<Input, Output> {
    return Object.assign(run, {
      bound: (_input: Input) => receiverWork,
      actual: (_input: Input, _output: Output) => receiverWork,
    });
  }
  let paused: { entered(): void; wait: Promise<void>; resume(): void } | undefined;
  const receiver = {
    invalidate: receiverOperation(async (input: KindConsentInvalidationInput) => {
      const current = paused;
      if (current) {
        paused = undefined;
        current.entered();
        await current.wait;
      }
      const receiptReference = `${input.transitionId}:${input.reference.id}`;
      committed.set(receiptReference, input);
      return { status: 'committed' as const, receiptReference };
    }),
    verify: receiverOperation(async (input: KindConsentInvalidationInput & { receiptReference: string }) => {
      const prior = committed.get(input.receiptReference);
      if (
        !prior ||
        JSON.stringify(prior) !==
          JSON.stringify({
            reference: input.reference,
            consumer: input.consumer,
            transitionId: input.transitionId,
          })
      )
        return { status: 'pending' as const };
      verified.add(input.receiptReference);
      return { status: 'verified' as const, receiptReference: input.receiptReference };
    }),
  };
  const { participant, writer } = createKindConsentParticipant({ database, receiver });
  const consumer = (preparationId: string) => ({
    route: 'collection-kind',
    ownerAccountId: 'kind-owner',
    collectionId: 'kind-collection',
    preparationId,
    originId: 'kind-origin',
  });
  const pauseNext = () => {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const wait = new Promise<void>((resolve) => (resume = resolve));
    paused = { entered: enter, wait, resume };
    return { entered, resume };
  };
  try {
    await database.query(`
      INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('kind-owner','','kind-owner@example.test',false);
      INSERT INTO auth_client (client_id,first_party,scopes) VALUES
        ('kind-consent-client',false,ARRAY['read','write']),('kind-client-client',false,ARRAY['read']);
      INSERT INTO auth_client_coverage (client_id,ready) VALUES
        ('kind-consent-client',true),('kind-client-client',true);
      INSERT INTO auth_consent (account_id,client_id,scopes) VALUES
        ('kind-owner','kind-consent-client',ARRAY['read','write']),('kind-owner','kind-client-client',ARRAY['read']);
    `);

    const enrollmentInput = {
      accountId: 'kind-owner',
      clientId: 'kind-consent-client',
      requestedScopes: ['read'],
      consumer: consumer('consent-preparation'),
    };
    const enrolled = await withKindConsentEnrollmentDeadline(
      Date.now() + 3_000,
      () => participant.enroll(enrollmentInput),
      new AbortController().signal,
    );
    expect(enrolled.status).toBe('enrolled');
    if (enrolled.status !== 'enrolled') throw new Error('Kind enrollment refused');
    expect(enrolled.effectiveScopes).toEqual(['read']);
    const successWork = participant.enroll.actual(enrollmentInput, enrolled);
    expect(successWork).toMatchObject({
      source: { candidateKeys: 1, nativeRows: 2, emptySeeks: 2, nativePoints: 4, witnessKeys: 3, statements: 10 },
      access: { keys: 1, rows: 2, emptySeeks: 2, points: 4, witnesses: 3 },
    });
    expect(successWork?.source.bytes).toBe(successWork?.access.bytes);
    expect(participant.enroll.actual(enrollmentInput, enrolled)).toBeUndefined();

    const duplicate = await withKindConsentEnrollmentDeadline(
      Date.now() + 3_000,
      () => participant.enroll(enrollmentInput),
      new AbortController().signal,
    );
    expect(duplicate.status).toBe('enrolled');
    const duplicateWork = participant.enroll.actual(enrollmentInput, duplicate);
    expect(duplicateWork).toMatchObject({
      source: { candidateKeys: 1, nativeRows: 2, emptySeeks: 1, nativePoints: 3, witnessKeys: 3, statements: 9 },
      access: { keys: 1, rows: 2, emptySeeks: 1, points: 3, witnesses: 3 },
    });

    const emptyRetryInput = { ...enrollmentInput, requestedScopes: [] as string[] };
    const emptyRetry = await withKindConsentEnrollmentDeadline(
      Date.now() + 3_000,
      () => participant.enroll(emptyRetryInput),
      new AbortController().signal,
    );
    expect(emptyRetry).toEqual({ status: 'unavailable' });
    const emptyRetryWork = participant.enroll.actual(emptyRetryInput, emptyRetry);
    expect(emptyRetryWork).toMatchObject({
      source: { candidateKeys: 1, nativeRows: 2, emptySeeks: 1, nativePoints: 3, witnessKeys: 3, statements: 9 },
    });
    const emptyRetryInputBytes =
      128 +
      [
        emptyRetryInput.accountId,
        emptyRetryInput.clientId,
        emptyRetryInput.consumer.route,
        emptyRetryInput.consumer.ownerAccountId,
        emptyRetryInput.consumer.collectionId,
        emptyRetryInput.consumer.preparationId,
        emptyRetryInput.consumer.originId,
      ].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    expect(emptyRetryWork?.source.bytes).toBeGreaterThan(emptyRetryInputBytes);

    const emptyRequestInput = {
      ...enrollmentInput,
      requestedScopes: [] as string[],
      consumer: consumer('empty-request-preparation'),
    };
    const emptyRequest = await withKindConsentEnrollmentDeadline(
      Date.now() + 3_000,
      () => participant.enroll(emptyRequestInput),
      new AbortController().signal,
    );
    expect(emptyRequest).toMatchObject({ status: 'enrolled', effectiveScopes: [] });
    const emptyRequestWork = participant.enroll.actual(emptyRequestInput, emptyRequest);
    const emptyRequestInputBytes =
      128 +
      [
        emptyRequestInput.accountId,
        emptyRequestInput.clientId,
        emptyRequestInput.consumer.route,
        emptyRequestInput.consumer.ownerAccountId,
        emptyRequestInput.consumer.collectionId,
        emptyRequestInput.consumer.preparationId,
        emptyRequestInput.consumer.originId,
      ].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    expect(emptyRequestWork?.source.bytes).toBeGreaterThan(emptyRequestInputBytes);

    const failedStatements: string[] = [];
    const failingDatabase = {
      async connect() {
        const connection = await database.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const statement = sql.trim().replace(/\s+/g, ' ').toUpperCase();
            failedStatements.push(statement);
            if (statement === 'COMMIT') throw new Error('simulated uncertain commit');
            return connection.query(sql, values as never[]);
          },
          release(error?: Error) {
            connection.release(error);
          },
        } as unknown as import('pg').PoolClient;
      },
    } as unknown as Pool;
    const failingParticipant = createKindConsentParticipant({ database: failingDatabase }).participant;
    const failedInput = { ...enrollmentInput, consumer: consumer('commit-failure-preparation') };
    const failedResult = await withKindConsentEnrollmentDeadline(
      Date.now() + 3_000,
      () => failingParticipant.enroll(failedInput),
      new AbortController().signal,
    );
    expect(failedResult).toEqual({ status: 'unavailable' });
    expect(failedStatements).toHaveLength(11);
    expect(failedStatements.slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(failingParticipant.enroll.actual(failedInput, failedResult)).toBeUndefined();

    const holdConsent = pauseNext();
    let appliedAfterVerified = false;
    const consentChange = {
      transitionKey: 'kind-consent-test:grant-reduction',
      kind: 'consent' as const,
      accountId: 'kind-owner',
      clientId: 'kind-consent-client',
      target: { operation: 'consent-upsert', scopes: [], pendingScopes: null, pendingReference: null },
      async apply(connection: import('pg').PoolClient) {
        const fence = (
          await connection.query<{ active: boolean; receipt_reference: string | null }>(
            'SELECT active,receipt_reference FROM auth_kind_consent_dependency WHERE reference_id=$1',
            [enrolled.reference.id],
          )
        ).rows[0];
        expect(fence).toMatchObject({ active: false });
        expect([...verified].some((key) => key.endsWith(`:${enrolled.reference.id}`))).toBe(true);
        appliedAfterVerified = true;
        await connection.query('UPDATE auth_consent SET scopes=$3 WHERE account_id=$1 AND client_id=$2', [
          'kind-owner',
          'kind-consent-client',
          [],
        ]);
      },
    };
    const firstConsent = writer.change(consentChange);
    await holdConsent.entered;
    expect(
      (
        await database.query<{ scopes: string[] }>(
          'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
          ['kind-owner', 'kind-consent-client'],
        )
      ).rows[0]?.scopes,
    ).toEqual(['read', 'write']);
    const refusedInput = {
      accountId: 'kind-owner',
      clientId: 'kind-consent-client',
      requestedScopes: ['read'],
      consumer: consumer('racing-consent-preparation'),
    };
    const refused = await withKindConsentEnrollmentDeadline(
      Date.now() + 3_000,
      () => participant.enroll(refusedInput),
      new AbortController().signal,
    );
    expect(refused).toEqual({ status: 'unavailable' });
    expect(participant.enroll.actual(refusedInput, refused)).toMatchObject({
      source: { candidateKeys: 0, nativeRows: 1, emptySeeks: 0, nativePoints: 1, witnessKeys: 3, statements: 7 },
      access: { keys: 0, rows: 1, emptySeeks: 0, points: 1, witnesses: 3 },
    });
    holdConsent.resume();
    let consentResult = await firstConsent;
    while (consentResult.status === 'pending') consentResult = await writer.change(consentChange);
    expect(appliedAfterVerified).toBe(true);
    expect(
      (
        await database.query<{ scopes: string[] }>(
          'SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2',
          ['kind-owner', 'kind-consent-client'],
        )
      ).rows[0]?.scopes,
    ).toEqual([]);

    const clientEnrollment = await participant.enroll({
      accountId: 'kind-owner',
      clientId: 'kind-client-client',
      requestedScopes: ['read'],
      consumer: consumer('client-preparation'),
    });
    expect(clientEnrollment.status).toBe('enrolled');
    if (clientEnrollment.status !== 'enrolled') throw new Error('Client enrollment refused');
    const clientChange = {
      transitionKey: 'kind-consent-test:client-authority',
      kind: 'client' as const,
      clientId: 'kind-client-client',
      target: { operation: 'client-config', scopes: [], firstParty: false },
      async apply(connection: import('pg').PoolClient) {
        const fence = (
          await connection.query<{ active: boolean }>(
            'SELECT active FROM auth_kind_consent_dependency WHERE reference_id=$1',
            [clientEnrollment.reference.id],
          )
        ).rows[0];
        expect(fence?.active).toBe(false);
        expect([...verified].some((key) => key.endsWith(`:${clientEnrollment.reference.id}`))).toBe(true);
        await connection.query('UPDATE auth_client SET scopes=$2 WHERE client_id=$1', ['kind-client-client', []]);
      },
    };
    let clientResult = await writer.change(clientChange);
    while (clientResult.status === 'pending') clientResult = await writer.change(clientChange);
    expect(
      (
        await database.query<{ scopes: string[] }>('SELECT scopes FROM auth_client WHERE client_id=$1', [
          'kind-client-client',
        ])
      ).rows[0]?.scopes,
    ).toEqual([]);

    const restoredEnrollment = await participant.enroll({
      accountId: 'kind-owner',
      clientId: 'kind-client-client',
      requestedScopes: ['read'],
      consumer: consumer('restore-preparation'),
    });
    expect(restoredEnrollment.status).toBe('enrolled');
    if (restoredEnrollment.status !== 'enrolled') throw new Error('Restored enrollment refused');
    const holdRestore = pauseNext();
    const restoreChange = () =>
      writer.fenceAll({
        transitionKey: 'kind-consent-test:restore-generation',
        operation: 'restore-admission',
        identity: 'restore-generation',
      });
    const firstRestore = restoreChange();
    await holdRestore.entered;
    expect(
      await participant.enroll({
        accountId: 'kind-owner',
        clientId: 'kind-consent-client',
        requestedScopes: ['read'],
        consumer: consumer('restore-race-preparation'),
      }),
    ).toEqual({ status: 'unavailable' });
    holdRestore.resume();
    let restoreResult = await firstRestore;
    while (restoreResult.status === 'pending') restoreResult = await restoreChange();
    expect(
      (
        await database.query<{ active: boolean }>(
          'SELECT active FROM auth_kind_consent_dependency WHERE reference_id=$1',
          [restoredEnrollment.reference.id],
        )
      ).rows[0]?.active,
    ).toBe(false);
  } finally {
    await database.end();
    fixture.close();
  }
}, 60_000);

test('short original deadline aborts native pool acquisition and releases a late connection', async () => {
  let resolveConnection!: (connection: import('pg').PoolClient) => void;
  let releaseError: Error | undefined;
  let queryCount = 0;
  const database = {
    connect: () =>
      new Promise<import('pg').PoolClient>((resolve) => {
        resolveConnection = resolve;
      }),
  } as unknown as Pool;
  const participant = createKindConsentParticipant({ database }).participant;
  const input = {
    accountId: 'short-deadline-account',
    clientId: 'short-deadline-client',
    requestedScopes: [],
    consumer: {
      route: 'collection-kind',
      ownerAccountId: 'short-deadline-account',
      collectionId: 'short-deadline-collection',
      preparationId: 'short-deadline-preparation',
      originId: 'short-deadline-origin',
    },
  };
  const controller = new AbortController();
  const deadline = Date.now() + 40;
  const abortTimer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  const result = await withKindConsentEnrollmentDeadline(deadline, () => participant.enroll(input), controller.signal);
  clearTimeout(abortTimer);
  expect(result).toEqual({ status: 'unavailable' });
  expect(participant.enroll.actual(input, result)).toBeUndefined();
  resolveConnection({
    async query() {
      queryCount++;
      throw new Error('late pool checkout must not query');
    },
    release(error?: Error) {
      releaseError = error;
    },
  } as unknown as import('pg').PoolClient);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(queryCount).toBe(0);
  expect(releaseError).toBeInstanceOf(Error);
});
