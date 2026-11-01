import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import type {
  KindConsentInvalidationInput,
  KindConsentOperation,
  KindConsentWorkDeclaration,
} from '@rezics/auth-contract';
import { testDatabase } from '../scripts/database.ts';
import { createKindConsentParticipant } from '../src/kind-consent.ts';

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

    const enrolled = await participant.enroll({
      accountId: 'kind-owner',
      clientId: 'kind-consent-client',
      requestedScopes: ['read'],
      consumer: consumer('consent-preparation'),
    });
    expect(enrolled.status).toBe('enrolled');
    if (enrolled.status !== 'enrolled') throw new Error('Kind enrollment refused');
    expect(enrolled.effectiveScopes).toEqual(['read']);
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
    expect(
      await participant.enroll({
        accountId: 'kind-owner',
        clientId: 'kind-consent-client',
        requestedScopes: ['read'],
        consumer: consumer('racing-consent-preparation'),
      }),
    ).toEqual({ status: 'unavailable' });
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
