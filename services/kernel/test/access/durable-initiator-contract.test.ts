import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import {
  createInitiatorRestorer,
  DurableInitiatorUnavailableError,
  type DurableOperationAnchor,
  type DurableInitiatorRecord,
  type DurableInitiatorReader,
  type InitiatorRestoreInput,
  type InitiatorRestorerConfig,
  type InitiatorRestorer,
  type InitiatorRestoreFailure,
} from '../../src/access/durable-initiator.ts';
import type { CurrentConsentReader } from '../../src/access/auth-consent.ts';
import type { AuthorizationAnchor } from '../../src/access/resource-authorization.ts';
import { mintReadTime, type AuthoritativeTime, type CommandAuthorization } from '../../src/command/command.ts';
import { bindReceiptKeys } from '../../src/command/receipt-key.ts';
import { installDurableIdentityBridge } from '../../src/access/durable-identity.ts';
import { durableInitiatorCommitment } from '../../src/access/durable-initiator-capture.ts';
import { newId } from '../../src/route/route.ts';
import { composeCommunityDomainPorts } from '../../src/composition/community-domain-ports.ts';
import {
  MEMBERSHIP_OPERATION_COMMANDS,
  membershipSourceDigest,
  readMembershipInitiator,
} from '../../src/community/membership.ts';
import type { Access, AccessClient, AccessContext, AccountActor } from '../../src/request/access.ts';

test('durable initiator contract accepts an anchored nonsecret committed tuple reader and live command time', () => {
  expectTypeOf<DurableOperationAnchor>().toEqualTypeOf<
    Readonly<{ route: number; id: string; kind: string; sourceId: string }>
  >();
  expectTypeOf<DurableInitiatorRecord>().toEqualTypeOf<
    Readonly<{
      operation: DurableOperationAnchor;
      initiatorAccountId: string;
      actor: AccountActor;
      recordedTransactionId: string;
      sourceDigest: string;
      originalDelegation: Readonly<{ transactionId: string; issuedValid: string }> | null;
      originalAccount: Readonly<{ minimumAuthnEpoch: string; operatorAccountId: string | null }>;
      creation: Readonly<{
        commandKind: string;
        idempotencyKey: string;
        requestDigest: string;
        target: Readonly<{ route: number; id: string }>;
      }>;
    }>
  >();
  expectTypeOf<DurableInitiatorReader>().toEqualTypeOf<
    (
      client: AccessClient,
      operation: DurableOperationAnchor,
      time: AuthoritativeTime,
      enterOperationReceipt?: () => void,
    ) => Promise<DurableInitiatorRecord | null>
  >();
  expectTypeOf<InitiatorRestoreInput>().toEqualTypeOf<
    Readonly<{ operation: DurableOperationAnchor; action: string; anchor: AuthorizationAnchor; context: AccessContext }>
  >();
  expectTypeOf<InitiatorRestorerConfig>().toEqualTypeOf<
    Readonly<{ pool: Pool; access: Access; readOperation: DurableInitiatorReader; readConsent: CurrentConsentReader }>
  >();
  expectTypeOf<InitiatorRestorer>().toEqualTypeOf<
    Readonly<{
      restoreInitiator(
        operation: InitiatorRestoreInput,
        time: AuthoritativeTime,
        onFailure?: (failure: InitiatorRestoreFailure) => void,
      ): Promise<AccountActor>;
    }>
  >();
  expectTypeOf<typeof createInitiatorRestorer>().toEqualTypeOf<
    (config: InitiatorRestorerConfig) => InitiatorRestorer
  >();

  // Server composition receives T from prepare, before target checkout. This is
  // a type example only; the native formula must still authorize the step.
  const compose =
    (restorer: InitiatorRestorer, input: InitiatorRestoreInput): CommandAuthorization['prepare'] =>
    async (attempt) => {
      const actor = await restorer.restoreInitiator(input, attempt.time);
      expectTypeOf(actor).toEqualTypeOf<AccountActor>();
      throw new Error('Native same-attempt formula/body composition is not implemented');
    };
  expectTypeOf(compose).returns.toEqualTypeOf<CommandAuthorization['prepare']>();
});

test('callers pass no bearer or arbitrary identity-registration port', () => {
  expectTypeOf<keyof InitiatorRestorerConfig>().toEqualTypeOf<'pool' | 'access' | 'readOperation' | 'readConsent'>();
  expectTypeOf<keyof InitiatorRestoreInput>().toEqualTypeOf<'operation' | 'action' | 'anchor' | 'context'>();
  expectTypeOf<keyof DurableInitiatorRecord>().toEqualTypeOf<
    | 'operation'
    | 'initiatorAccountId'
    | 'actor'
    | 'recordedTransactionId'
    | 'sourceDigest'
    | 'originalAccount'
    | 'originalDelegation'
    | 'creation'
  >();
  expectTypeOf<keyof AccountActor>().toEqualTypeOf<
    'kind' | 'accountId' | 'clientId' | 'scopes' | 'requestedBy' | 'authnEpoch'
  >();
  expectTypeOf<Date>().not.toExtend<AuthoritativeTime>();
  expectTypeOf<string>().not.toExtend<AuthoritativeTime>();
  expectTypeOf<unknown>().not.toExtend<DurableInitiatorRecord>();
  expectTypeOf<() => Promise<boolean>>().not.toExtend<DurableInitiatorReader>();
});

test('missing trusted current-consent configuration denies with zero I/O or caller-data inspection', async () => {
  const calls: string[] = [];
  const unreadable = <T extends object>(value: T, label: string): T =>
    new Proxy(value, {
      get(_target, key) {
        calls.push(`${label}.${String(key)}`);
        throw new Error('Unavailable restoration must not inspect caller data');
      },
    });
  const pool = unreadable({} as Pool, 'pool');
  const config: Omit<InitiatorRestorerConfig, 'readConsent'> = {
    pool,
    access: unreadable({} as Access, 'access'),
    async readOperation() {
      calls.push('readOperation');
      throw new Error('Missing trusted consent must not read storage');
    },
  };
  const input: InitiatorRestoreInput = {
    operation: { route: 0x1234, id: 'operation', kind: 'native-workflow', sourceId: 'immutable-native-source' },
    action: 'subject:write',
    anchor: {
      resource: { route: 0x5678, id: 'actual-step-authority' },
      async validate() {
        calls.push('validate');
        return true;
      },
    },
    context: { pool, deadline: Date.now() + 60_000 },
  };
  // A denial test may supply hostile time; it never represents a live command T.
  const time = unreadable({} as AuthoritativeTime, 'time');
  for (const installed of [config, unreadable(config, 'config')]) {
    const restorer = createInitiatorRestorer(installed as InitiatorRestorerConfig);
    expect(calls).toEqual([]);
    for (const operation of [input, unreadable(input, 'input')]) {
      await expect(restorer.restoreInitiator(operation, time)).rejects.toBeInstanceOf(DurableInitiatorUnavailableError);
    }
  }
  expect(calls).toEqual([]);
  const error = new DurableInitiatorUnavailableError();
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('DurableInitiatorUnavailableError');
});

test.each(['read_operation_receipt', 'read_current_consent'] as const)(
  'attributes a Realm initiator deadline to %s and denies before resource access',
  async (stall) => {
    composeCommunityDomainPorts();
    const route = 4;
    const realmId = newId(route);
    const accountId = newId(route);
    const memberId = newId(route);
    const operationId = newId(route);
    const spaceId = newId(route);
    const target = { route, id: realmId };
    const operation = { route, id: operationId, kind: MEMBERSHIP_OPERATION_COMMANDS.join, sourceId: operationId };
    const facts = { realmId, spaceId, memberAccountId: memberId, reservationId: null, banId: null };
    const record: DurableInitiatorRecord = {
      operation,
      initiatorAccountId: accountId,
      actor: {
        kind: 'account',
        accountId,
        clientId: 'test-client',
        scopes: ['realm:manage'],
        requestedBy: null,
        authnEpoch: 1,
      },
      recordedTransactionId: newId(route),
      sourceDigest: membershipSourceDigest(operation, target, facts),
      originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null },
      originalDelegation: null,
      creation: { commandKind: operation.kind, idempotencyKey: 'test-key', requestDigest: 'a'.repeat(64), target },
    };
    const commitment = durableInitiatorCommitment(record);
    const client = {
      release() {},
      async query(query: string | { text: string }) {
        const text = typeof query === 'string' ? query : query.text;
        // The fake service grants no catalog access. Reylo can proceed after a settled refusal.
        if (text.includes('AS fresh_table'))
          throw Object.assign(new Error('test catalog unavailable'), { code: '42501', severity: 'ERROR' });
        if (text.includes('transaction_timestamp()')) return { rows: [{ at: new Date().toISOString() }] };
        if (text.includes('community.realm_membership_operation'))
          return {
            rows: [
              {
                route,
                operation_id: operationId,
                kind: 'join',
                realm_id: realmId,
                space_id: spaceId,
                member_account_id: memberId,
                reservation_id: null,
                ban_id: null,
                initiator_account_id: accountId,
                actor_client_id: record.actor.clientId,
                actor_scopes: record.actor.scopes,
                actor_requested_by: null,
                actor_authn_epoch: '1',
                recorded_transaction_id: record.recordedTransactionId,
                source_digest: record.sourceDigest,
                original_minimum_authn_epoch: '1',
                original_operator_account_id: null,
                original_delegation_transaction_id: null,
                original_delegation_issued_valid: null,
                creation_command_kind: operation.kind,
                creation_idempotency_key: record.creation.idempotencyKey,
                creation_request_digest: record.creation.requestDigest,
                creation_target_route: route,
                creation_target_id: realmId,
              },
            ],
          };
        if (text.includes('receipt_commitment')) {
          if (stall === 'read_operation_receipt')
            throw Object.assign(new Error('test query cancelled'), { code: '57014', severity: 'ERROR' });
          return {
            rows: [
              {
                receipt_transaction_id: record.recordedTransactionId,
                receipt_request_digest: record.creation.requestDigest,
                receipt_commitment: commitment,
              },
            ],
          };
        }
        if (text.includes('core.receipt'))
          return {
            rows: [
              {
                requestDigest: Buffer.from(record.creation.requestDigest, 'hex'),
                epoch: '1',
                position: '1',
                transactionId: record.recordedTransactionId,
                response: { durableInitiator: commitment },
                payloadState: 'retained',
              },
            ],
          };
        throw new Error('Unexpected SQL after the deadline');
      },
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const keys = { current: 1, keys: new Map([[1, Buffer.alloc(32, 1)]]) };
    bindReceiptKeys(pool, keys);
    bindReceiptKeys(client, keys);
    const access = {} as Access;
    const identity = {
      restore: async () => {
        throw new Error('Unexpected identity mint');
      },
      discard() {},
      scope: {},
    };
    installDurableIdentityBridge(access, identity);
    let finishConsent: ((value: null) => void) | undefined;
    let resourceReads = 0;
    let failure: InitiatorRestoreFailure | undefined;
    const restorer = createInitiatorRestorer({
      pool,
      access,
      readOperation: readMembershipInitiator,
      async readConsent(input) {
        expect(input).toMatchObject({ actorAccountId: accountId, clientId: record.actor.clientId });
        return new Promise<null>((resolve) => {
          finishConsent = resolve;
        });
      },
    });
    const time = await mintReadTime(client);
    const deadline = Date.now() + 30_000;
    try {
      await expect(
        restorer.restoreInitiator(
          {
            operation,
            action: 'realm:manage',
            anchor: {
              resource: target,
              async validate() {
                resourceReads++;
                return true;
              },
            },
            context: { pool, deadline },
          },
          time,
          (value) => {
            failure = value;
          },
        ),
      ).rejects.toMatchObject({ name: 'AccessUnavailableError', reason: 'deadline' });
    } finally {
      finishConsent?.(null);
    }
    expect(failure).toMatchObject({
      initiatorStage: stall,
      requestRemainingMs: expect.any(Number),
      evidenceRemainingMs: expect.any(Number),
    });
    expect(failure!.requestRemainingMs).toBeGreaterThan(20_000);
    expect(failure!.initiatorStageElapsedMs).toBeLessThanOrEqual(failure!.initiatorElapsedMs);
    if (stall === 'read_current_consent') expect(failure!.evidenceRemainingMs).toBe(0);
    expect(finishConsent !== undefined).toBe(stall === 'read_current_consent');
    expect(resourceReads).toBe(0);
  },
);
