import { expect, expectTypeOf, test } from 'bun:test';
import type {
  AccountWorkflowOptions,
  AccountWorkflowPorts,
  AuthService,
  TrustedAccessPorts,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
} from '@rezics/auth';
import type { Pool } from 'pg';
import {
  NativeAccountBindingsUnavailableError,
  createNativeAccountBindings,
  type NativeAccountBindings,
  type NativeAccountBindingsConfig,
  type NativeAccountBindingProofs,
  type NativeWorkflowProofPorts,
} from '../../src/access/native-account-bindings.ts';
import type {
  LifecycleRequest,
  RecoveryEvidence,
  createLifecycleCommands,
  createLifecycleInternals,
} from '../../src/access/lifecycle.ts';
import type { createOperatorCommands } from '../../src/access/operator.ts';
import type { createGrantCommands } from '../../src/access/grant-commands.ts';
import type { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import type { Access, ActionCatalogue } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

test('ordinary durable composition requires actual native factories and Auth-host proof capabilities', () => {
  expectTypeOf<NativeWorkflowProofPorts>().toEqualTypeOf<{
    recordPending(input: { accountId: string; reservationId: string; reference: string }): Promise<void>;
    pendingReference(input: { accountId: string; reservationId: string }): Promise<string | null>;
    provisioningEvidence(input: { accountId: string; reservationId: string }): Promise<unknown>;
  }>();
  expectTypeOf<NativeAccountBindingProofs>().toEqualTypeOf<{
    provisioning: ReturnType<typeof createProvisioningEvidenceVerifier>;
    barriers: ReturnType<typeof createBarrierProofVerifier>;
    workflow: NativeWorkflowProofPorts;
    recoveryEvidence?: (reference: unknown) => Promise<RecoveryEvidence | null>;
  }>();
  expectTypeOf<NativeAccountBindingsConfig>().toEqualTypeOf<{
    pool: Pool;
    access: Access;
    actions: ActionCatalogue;
    routeKey: Uint8Array;
    referenceKeys: KeyRing;
    auth: () => AuthService;
    proofs: NativeAccountBindingProofs;
  }>();
  expectTypeOf<NativeAccountBindings>().toEqualTypeOf<{
    trustedAccess: TrustedAccessPorts;
    workflowPorts: AccountWorkflowPorts<LifecycleRequest>;
    lifecycle: ReturnType<typeof createLifecycleCommands>;
    internalLifecycle: ReturnType<typeof createLifecycleInternals>;
    operators: ReturnType<typeof createOperatorCommands>;
    grants: ReturnType<typeof createGrantCommands>;
    delegations: ReturnType<typeof createDelegationCommands>;
  }>();
  expectTypeOf<Parameters<typeof createNativeAccountBindings>>().toEqualTypeOf<[NativeAccountBindingsConfig]>();
  expectTypeOf<ReturnType<typeof createNativeAccountBindings>>().toEqualTypeOf<NativeAccountBindings>();
  expectTypeOf<NativeAccountBindings['workflowPorts']>().toEqualTypeOf<
    AccountWorkflowOptions<LifecycleRequest>['access']
  >();
});

test('construction throws named unavailable before reading configuration or invoking any capability', () => {
  const config = new Proxy({} as NativeAccountBindingsConfig, {
    get() {
      throw new Error('Construction must not read pools, keys, Auth, or proof callbacks');
    },
    ownKeys() {
      throw new Error('Construction must not enumerate configuration');
    },
  });
  expect(() => createNativeAccountBindings(config)).toThrow(NativeAccountBindingsUnavailableError);
  try {
    createNativeAccountBindings(config);
    throw new Error('Unavailable construction returned bindings');
  } catch (error) {
    expect(error).toBeInstanceOf(NativeAccountBindingsUnavailableError);
    expect(error).toHaveProperty('name', 'NativeAccountBindingsUnavailableError');
    expect(String(error)).not.toContain('Construction must not');
  }
});

test('the production seam has no runtime imports, website provider, Auth host launch, or pool ownership', async () => {
  const source = await Bun.file(new URL('../../src/access/native-account-bindings.ts', import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  expect(transpiler.scanImports(source)).toEqual([]);
  const compiled = transpiler.transformSync(source);
  expect(transpiler.scan(compiled).exports.sort()).toEqual([
    'NativeAccountBindingsUnavailableError',
    'createNativeAccountBindings',
  ]);
});
