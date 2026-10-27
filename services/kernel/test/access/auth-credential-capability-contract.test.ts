import { expect, expectTypeOf, test } from 'bun:test';
import type {
  AuthService,
  EffectPurpose,
  CredentialEffect,
  PasskeyPurpose,
  CredentialFloorPurpose,
  CredentialFloorReceipt,
  CredentialFloorBinding,
  CredentialEffectBinding,
  CredentialEffectVerifier,
  SessionProof,
  TrustedAccessPorts,
} from '@rezics/auth';
import { AuthBindingDeniedError, AuthBindingUnavailableError } from '../../src/access/auth-bindings.ts';
import type {
  PasskeyPurpose as KernelPasskeyPurpose,
  CredentialFloorPurpose as KernelCredentialFloorPurpose,
  CredentialCapability,
  CredentialOpeningLocator,
} from '../../src/access/auth-credential-capability.ts';
import type { createOperatorCommands } from '../../src/access/operator.ts';
import type {
  CredentialPurpose as ContractCredentialPurpose,
  PasskeyPurpose as ContractPasskeyPurpose,
  CredentialFloorPurpose as ContractCredentialFloorPurpose,
} from '@rezics/auth-contract';
import { createCredentialCapability } from '../../src/access/auth-credential-capability.ts';

type ConsumeInput = Parameters<NonNullable<TrustedAccessPorts['consumeAuthorization']>>[0];
type CredentialPurpose = 'set-password' | 'remove-password' | 'add-key' | 'remove-key';
type SessionInput = {
  authorization: string;
  subjectAccountId: string;
  purpose: 'session';
  human: SessionProof;
};
type CredentialInput = Omit<SessionInput, 'purpose'> & {
  purpose: CredentialPurpose;
  operationKey: string;
  effectReference: string;
};
type LegacyCredentialInput = Omit<SessionInput, 'purpose'> & {
  purpose: CredentialPurpose;
  operationKey?: undefined;
  effectReference?: undefined;
};

test('credential consume input is a closed union that leaves the session variant unchanged', () => {
  expectTypeOf<Extract<ConsumeInput, { purpose: 'session' }>>().toEqualTypeOf<SessionInput>();
  expectTypeOf<ConsumeInput['purpose']>().toEqualTypeOf<'session' | CredentialPurpose>();
  type ExactCredentialInput = Extract<ConsumeInput, { operationKey: string }>;
  type LegacyInput = Extract<ConsumeInput, { operationKey?: undefined; purpose: CredentialPurpose }>;
  expectTypeOf<ExactCredentialInput>().toMatchTypeOf<CredentialInput>();
  expectTypeOf<LegacyInput>().toEqualTypeOf<never>();
  expectTypeOf<Exclude<ConsumeInput, SessionInput | ExactCredentialInput | LegacyInput>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<ExactCredentialInput, { purpose: 'set-password' }>>().not.toEqualTypeOf<never>();
  expectTypeOf<Extract<ExactCredentialInput, { purpose: 'remove-password' }>>().not.toEqualTypeOf<never>();
  expectTypeOf<Extract<ExactCredentialInput, { purpose: 'add-key' }>>().not.toEqualTypeOf<never>();
  expectTypeOf<Extract<ExactCredentialInput, { purpose: 'remove-key' }>>().not.toEqualTypeOf<never>();
  expectTypeOf<CredentialInput>().toMatchTypeOf<ConsumeInput>();
  expectTypeOf<Extract<ConsumeInput, { purpose: CredentialPurpose }>['operationKey']>().toEqualTypeOf<string>();
  expectTypeOf<Extract<ConsumeInput, { purpose: CredentialPurpose }>['effectReference']>().toEqualTypeOf<string>();
  expectTypeOf<LegacyCredentialInput>().not.toMatchTypeOf<ConsumeInput>();
  expectTypeOf<Omit<CredentialInput, 'operationKey'>>().not.toMatchTypeOf<ConsumeInput>();
  expectTypeOf<Omit<CredentialInput, 'effectReference'>>().not.toMatchTypeOf<ConsumeInput>();
  expectTypeOf<SessionInput & { purpose: 'device' }>().toEqualTypeOf<never>();
});

function fixture() {
  let calls = 0;
  const io = () => {
    calls++;
    throw new Error('Credential contract must perform no I/O');
  };
  const config = {
    pool: { query: io, connect: io },
    access: { authenticate: io, prepare: io, authorize: io },
    operators: { authorizeOpening: io, consumeOpening: io },
    workflowApprovals: { approve: io, resolve: io, resolveForCaller: io },
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) },
    accessTokenForProof: io,
    verifyCredentialEffect: io,
  } as unknown as Parameters<typeof createCredentialCapability>[0];
  return { config, calls: () => calls };
}

function unread<T>(): T {
  return new Proxy({} as object, {
    get() {
      throw new Error('Unavailable credential methods must not inspect input');
    },
  }) as T;
}

test('credential capability validates config and refuses malformed or legacy input without I/O', async () => {
  const { config, calls } = fixture();
  for (const value of [undefined, null, {}]) {
    expect(() => createCredentialCapability(value as unknown as typeof config)).toThrow();
  }
  for (const key of Object.keys(config)) {
    const incomplete = { ...config };
    delete incomplete[key as keyof typeof incomplete];
    expect(() => createCredentialCapability(incomplete)).toThrow();
  }
  for (const referenceKeys of [
    { current: 1, keys: new Map() },
    { current: 2, keys: new Map([[1, new Uint8Array(32)]]) },
    { current: 1, keys: new Map([[1, new Uint8Array(31)]]) },
    { current: 256, keys: new Map([[256, new Uint8Array(32)]]) },
  ]) {
    expect(() => createCredentialCapability({ ...config, referenceKeys })).toThrow();
  }
  const capability = createCredentialCapability(config);
  expect(calls()).toBe(0);
  expect(Object.keys(capability).sort()).toEqual([
    'advanceCredentialFloor',
    'approveCredentialEffect',
    'consumeAuthAuthorization',
    'createOpeningReference',
    'revalidateCredentialEffect',
  ]);
  expect(() => capability.createOpeningReference({} as never)).toThrow(AuthBindingDeniedError);
  for (const purpose of ['set-password', 'remove-password', 'add-key', 'remove-key'] as const) {
    await expect(
      capability.consumeAuthAuthorization({
        authorization: 'opening-reference',
        subjectAccountId: 'subject',
        purpose,
        operationKey: 'operation',
        effectReference: 'stage-reference',
        human: unread(),
      }),
    ).rejects.toThrow();
    await expect(
      capability.consumeAuthAuthorization({
        authorization: 'opening-reference',
        subjectAccountId: 'subject',
        purpose,
        human: unread(),
      } as unknown as Parameters<typeof capability.consumeAuthAuthorization>[0]),
    ).rejects.toBeInstanceOf(AuthBindingUnavailableError);
  }
  await expect(
    capability.advanceCredentialFloor({
      stage: { subjectAccountId: 'invalid-subject' },
      consumedOpening: {},
      expectedPreviousFloor: 1,
    } as never),
  ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  expect(calls()).toBe(0);
});

test('credential binding and stage commands are typed nonsecret locators', () => {
  type Internal = AuthService['internal'];
  type Stage = Awaited<ReturnType<Internal['stageCredentialEffect']>>;
  type Approve = Awaited<ReturnType<Internal['approveCredentialEffect']>>;
  type Apply = Awaited<ReturnType<Internal['applyCredentialEffect']>>;
  expectTypeOf<Stage>().toEqualTypeOf<{
    effectRef: string;
    key: string;
    subjectId: string;
    purpose: CredentialPurpose;
    digest: string;
  }>();
  expectTypeOf<Approve>().toEqualTypeOf<{ reference: string; expiresAt: string }>();
  expectTypeOf<Apply>().toEqualTypeOf<{ receiptId: string; replayed: boolean }>();
  expectTypeOf<Internal['verifyCredentialEffect']>().toEqualTypeOf<CredentialEffectVerifier>();
  expectTypeOf<Awaited<ReturnType<CredentialEffectVerifier>>>().toEqualTypeOf<CredentialEffectBinding>();
  expectTypeOf<CredentialEffectBinding>().toMatchTypeOf<{
    operationKey: string;
    effectReference: string;
    effectDigest: string;
    subjectAccountId: string;
    purpose: CredentialPurpose;
    actingHumanId: string;
    clientId: string;
    scopes: string[];
  }>();
  expectTypeOf<
    Extract<keyof CredentialEffectBinding, 'password' | 'privateKey' | 'cookie' | 'jwt'>
  >().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof Stage, 'credential' | 'human' | 'headers'>>().toEqualTypeOf<never>();
  expectTypeOf<Parameters<Internal['approveCredentialEffect']>[0]>().toEqualTypeOf<{
    effectRef: string;
    key: string;
    subjectAccountId: string;
    headers: Headers;
    deadline?: number;
  }>();
  expectTypeOf<Parameters<Internal['applyCredentialEffect']>[0]>().toEqualTypeOf<{
    authorization: string;
    effectRef: string;
    key: string;
    subjectAccountId: string;
    headers: Headers;
    deadline?: number;
  }>();
});

test('passkey purposes are own-human types outside the frozen credential effect union', () => {
  expectTypeOf<EffectPurpose>().toEqualTypeOf<'session' | CredentialPurpose>();
  expectTypeOf<ContractCredentialPurpose>().toEqualTypeOf<CredentialPurpose>();
  expectTypeOf<Extract<CredentialEffect, { kind: 'passkey' }>>().toEqualTypeOf<never>();
  expectTypeOf<PasskeyPurpose>().toEqualTypeOf<'add-passkey' | 'remove-passkey'>();
  expectTypeOf<ContractPasskeyPurpose>().toEqualTypeOf<PasskeyPurpose>();
  expectTypeOf<KernelPasskeyPurpose>().toEqualTypeOf<PasskeyPurpose>();
  expectTypeOf<CredentialFloorPurpose>().toEqualTypeOf<CredentialPurpose | PasskeyPurpose>();
  expectTypeOf<ContractCredentialFloorPurpose>().toEqualTypeOf<CredentialFloorPurpose>();
  expectTypeOf<KernelCredentialFloorPurpose>().toEqualTypeOf<CredentialFloorPurpose>();
  expectTypeOf<CredentialFloorReceipt['purpose']>().toEqualTypeOf<CredentialFloorPurpose>();
  expectTypeOf<CredentialFloorBinding['purpose']>().toEqualTypeOf<CredentialFloorPurpose>();
  type PasskeyInput = Parameters<NonNullable<TrustedAccessPorts['consumePasskeyAuthorization']>>[0];
  expectTypeOf<PasskeyInput['purpose']>().toEqualTypeOf<PasskeyPurpose>();
  type OwnPorts = Extract<TrustedAccessPorts, { passkeys: true }>;
  type OwnApproval = Parameters<NonNullable<OwnPorts['approveCredentialEffect']>>[0];
  expectTypeOf<OwnApproval['stage']['purpose']>().toEqualTypeOf<CredentialFloorPurpose>();
  type OperatorOpening = Extract<CredentialOpeningLocator, { kind: 'operator-opening' }>;
  expectTypeOf<OperatorOpening['purpose']>().toEqualTypeOf<CredentialPurpose>();
  type Operator = ReturnType<typeof createOperatorCommands>;
  type OperatorInput = Parameters<Operator['authorizeOpening']>[1];
  expectTypeOf<NonNullable<OperatorInput['credential']>['purpose']>().toEqualTypeOf<CredentialPurpose>();
  type PasskeyStage = Awaited<ReturnType<AuthService['internal']['stagePasskeyEffect']>>;
  expectTypeOf<PasskeyStage['purpose']>().toEqualTypeOf<PasskeyPurpose>();
  type FloorInput = Parameters<CredentialCapability['consumeAuthAuthorization']>[0];
  expectTypeOf<FloorInput['purpose']>().toEqualTypeOf<CredentialFloorPurpose>();
  type Stage = AuthService['internal']['stageCredentialEffect'];
  expectTypeOf<Extract<Parameters<Stage>[0]['credential'], { kind: 'passkey' }>>().toEqualTypeOf<never>();
});
