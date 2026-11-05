import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  createInitiatorRestorer,
  DurableInitiatorUnavailableError,
  type DurableOperationAnchor,
  type DurableInitiatorRecord,
  type DurableInitiatorReader,
  type InitiatorRestoreInput,
  type InitiatorRestorerConfig,
  type InitiatorRestorer,
} from '../../src/access/durable-initiator.ts';
import type { CurrentConsentReader } from '../../src/request/auth-consent.ts';
import type { AuthorizationAnchor } from '../../src/access/resource-authorization.ts';
import type { AuthoritativeTime, CommandAuthorization } from '../../src/command/command.ts';
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
    ) => Promise<DurableInitiatorRecord | null>
  >();
  expectTypeOf<InitiatorRestoreInput>().toEqualTypeOf<
    Readonly<{ operation: DurableOperationAnchor; action: string; anchor: AuthorizationAnchor; context: AccessContext }>
  >();
  expectTypeOf<InitiatorRestorerConfig>().toEqualTypeOf<
    Readonly<{ pool: Pool; access: Access; readOperation: DurableInitiatorReader; readConsent: CurrentConsentReader }>
  >();
  expectTypeOf<InitiatorRestorer>().toEqualTypeOf<
    Readonly<{ restoreInitiator(operation: InitiatorRestoreInput, time: AuthoritativeTime): Promise<AccountActor> }>
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
