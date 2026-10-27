import { createCredentialCapability } from '../../src/access/auth-credential-capability.ts';
import { newId } from '../../src/route/route.ts';
import { expect, test } from 'bun:test';
import type { CredentialEffectBinding, CredentialEffectAuthorization, SessionProof } from '@rezics/auth-contract';
import type { Access } from '../../src/request/access.ts';
import type { Pool } from 'pg';

const accessReached = new Error('Access authentication reached');

function fixture() {
  const subjectAccountId = newId(0x9300);
  const operatorAccountId = newId(0x9310);
  const actingHumanId = newId(0x9320);
  const receiptId = newId(0x9330);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const binding: CredentialEffectBinding<'add-key'> = {
    operationKey: 'deadline-operation',
    effectReference: 'deadline-stage',
    effectDigest: 'a'.repeat(64),
    subjectAccountId,
    purpose: 'add-key',
    credentialRowId: null,
    credentialRowVersion: null,
    actingHumanId,
    clientId: 'deadline-client',
    scopes: ['account:manage'],
  };
  const human = {
    account_id: actingHumanId,
    client_id: binding.clientId,
    scope: binding.scopes,
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
  } as SessionProof;
  const consumedOpening: CredentialEffectAuthorization = {
    operationKey: binding.operationKey,
    effectReference: binding.effectReference,
    effectDigest: binding.effectDigest,
    subjectAccountId,
    purpose: 'add-key',
    receiptId,
    actingHumanId,
    operatorAccountId,
    clientId: binding.clientId,
    scopes: [...binding.scopes],
    humanEpoch: 1,
    subjectEpoch: 1,
    expiresAt,
  };

  const accessDeadlines: number[] = [];
  let tokenRequests = 0;
  let queries = 0;
  const pool = {
    async query() {
      queries++;
      return {
        rows: [
          {
            data: {
              credential_operation_key: binding.operationKey,
              credential_effect_reference: binding.effectReference,
              credential_effect_digest: binding.effectDigest,
              credential_purpose: binding.purpose,
              subject_account_id: subjectAccountId,
              client_id: binding.clientId,
              scopes: binding.scopes,
              requested_by: null,
              acting_human_id: actingHumanId,
              human_authn_epoch: 1,
              subject_epoch_floor: 1,
              expires_at: expiresAt,
            },
          },
        ],
      };
    },
    async connect() {
      throw new Error('Unexpected database connection');
    },
  } as unknown as Pool;
  const access = {
    async authenticate(_token: string, context: { deadline: number }) {
      accessDeadlines.push(context.deadline);
      throw accessReached;
    },
    async prepare() {
      throw new Error('Unexpected Access prepare');
    },
    async authorize() {
      throw new Error('Unexpected Access authorize');
    },
  } as unknown as Access;
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(71)]]) };
  const capability = createCredentialCapability({
    pool,
    access,
    operators: {
      authorizeOpening: async () => {
        throw new Error('Unexpected operator opening');
      },
      consumeOpening: async () => {
        throw new Error('Unexpected operator consumption');
      },
    } as never,
    workflowApprovals: {
      approve: async () => {
        throw new Error('Unexpected workflow approval');
      },
      resolve: async () => {
        throw new Error('Unexpected workflow resolution');
      },
      resolveForCaller: async () => {
        throw new Error('Unexpected workflow caller resolution');
      },
    } as never,
    referenceKeys,
    async accessTokenForProof() {
      tokenRequests++;
      return 'session-token';
    },
    async verifyCredentialEffect() {
      return structuredClone(binding);
    },
  });
  const openingReference = capability.createOpeningReference({
    kind: 'operator-opening',
    operationKey: binding.operationKey,
    effectReference: binding.effectReference,
    effectDigest: binding.effectDigest,
    subjectAccountId,
    purpose: binding.purpose,
    operatorAccountId,
    receiptId,
  });

  return {
    binding,
    human,
    consumedOpening,
    openingReference,
    capability,
    accessDeadlines,
    calls: () => ({ tokenRequests, queries }),
  };
}

test('credential capability passes the caller deadline to each Access authentication path', async () => {
  const f = fixture();
  const deadline = Date.now() + 60_000;

  await expect(f.capability.approveCredentialEffect({ stage: f.binding, human: f.human, deadline })).rejects.toBe(
    accessReached,
  );

  await expect(
    f.capability.consumeAuthAuthorization({
      authorization: f.openingReference,
      subjectAccountId: f.binding.subjectAccountId,
      purpose: f.binding.purpose,
      operationKey: f.binding.operationKey,
      effectReference: f.binding.effectReference,
      human: f.human,
      deadline,
    }),
  ).rejects.toBe(accessReached);

  await expect(
    f.capability.revalidateCredentialEffect({
      stage: f.binding,
      human: f.human,
      authorization: f.openingReference,
      consumedOpening: f.consumedOpening,
      replay: false,
      deadline,
    }),
  ).rejects.toBe(accessReached);

  expect(f.accessDeadlines).toEqual([deadline, deadline, deadline]);
});

test('a credential capability call with an expired deadline applies nothing', async () => {
  const f = fixture();
  const deadline = Date.now() - 1;
  const credentialInput = {
    authorization: f.openingReference,
    subjectAccountId: f.binding.subjectAccountId,
    purpose: f.binding.purpose,
    operationKey: f.binding.operationKey,
    effectReference: f.binding.effectReference,
    human: f.human,
    deadline,
  } as const;

  await expect(f.capability.approveCredentialEffect({ stage: f.binding, human: f.human, deadline })).rejects.toThrow();
  await expect(f.capability.consumeAuthAuthorization(credentialInput)).rejects.toThrow();
  await expect(
    f.capability.revalidateCredentialEffect({
      stage: f.binding,
      human: f.human,
      authorization: f.openingReference,
      consumedOpening: f.consumedOpening,
      replay: false,
      deadline,
    }),
  ).rejects.toThrow();
  await expect(
    f.capability.advanceCredentialFloor({
      stage: f.binding,
      consumedOpening: f.consumedOpening,
      expectedPreviousFloor: 1,
      key: f.binding.operationKey,
      purpose: f.binding.purpose,
      deadline,
    }),
  ).rejects.toThrow();

  expect(f.accessDeadlines).toEqual([]);
  expect(f.calls()).toEqual({ tokenRequests: 0, queries: 0 });
});

test('credential capability uses an ample caller deadline unchanged', async () => {
  const f = fixture();
  const deadline = Date.now() + 60_000;

  await expect(
    f.capability.consumeAuthAuthorization({
      authorization: f.openingReference,
      subjectAccountId: f.binding.subjectAccountId,
      purpose: f.binding.purpose,
      operationKey: f.binding.operationKey,
      effectReference: f.binding.effectReference,
      human: f.human,
      deadline,
    }),
  ).rejects.toBe(accessReached);

  expect(f.accessDeadlines).toEqual([deadline]);
});
