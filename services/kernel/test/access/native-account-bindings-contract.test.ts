import { expect, expectTypeOf, test } from 'bun:test';
import type { AccountWorkflowOptions } from '@rezics/auth';
import type { AutomatedOperatorAccess } from '../../src/access/automated-operator-source.ts';
import type {
  AccountWorkflowPorts,
  AuthSessionPort,
  AuthCredentialPort,
  AuthRecoveryPort,
  BarrierProofPort,
  ProvisioningEvidencePort,
  TrustedAccessPorts,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import {
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
import type { CommittedContinuations } from '../../src/access/committed-continuations.ts';
import type { Access, ActionCatalogue } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { systemClock } from '../../src/clock.ts';

test('ordinary durable composition requires actual native factories and Auth-host proof capabilities', () => {
  expectTypeOf<NativeWorkflowProofPorts>().toEqualTypeOf<{
    recordPending(input: { accountId: string; reservationId: string; reference: string }): Promise<void>;
    pendingReference(input: { accountId: string; reservationId: string }): Promise<string | null>;
    provisioningEvidence(input: { accountId: string; reservationId: string }): Promise<unknown>;
  }>();
  expectTypeOf<NativeAccountBindingProofs>().toEqualTypeOf<{
    provisioning: ProvisioningEvidencePort;
    barriers: BarrierProofPort;
    workflow: NativeWorkflowProofPorts;
    recoveryEvidence?: (reference: unknown) => Promise<RecoveryEvidence | null>;
  }>();
  expectTypeOf<NativeAccountBindingsConfig>().toEqualTypeOf<{
    pool: Pool;
    access: Access;
    actions: ActionCatalogue;
    routeKey: Uint8Array;
    clock?: () => Date;
    referenceKeys: KeyRing;
    auth: () => AuthSessionPort & AuthCredentialPort & AuthRecoveryPort;
    proofs: NativeAccountBindingProofs;
  }>();
  expectTypeOf<NativeAccountBindings>().toEqualTypeOf<{
    trustedAccess: TrustedAccessPorts & AutomatedOperatorAccess;
    workflowPorts: AccountWorkflowPorts<LifecycleRequest>;
    continuations: CommittedContinuations;
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

test('pure construction never invokes Auth, proof capabilities or database I/O', () => {
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error('Construction performed I/O');
      },
    },
  );
  const config: NativeAccountBindingsConfig = {
    pool: untouched as Pool,
    clock: systemClock,
    access: untouched as Access,
    actions: new Map([['account:manage', { anonymous: false }]]),
    routeKey: new Uint8Array(32).fill(3),
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(4)]]) },
    auth() {
      throw new Error('Auth is not constructed yet');
    },
    proofs: {
      provisioning: untouched as NativeAccountBindingProofs['provisioning'],
      barriers: untouched as NativeAccountBindingProofs['barriers'],
      workflow: untouched as NativeWorkflowProofPorts,
    },
  };
  const bindings = createNativeAccountBindings(config);
  expect(typeof bindings.trustedAccess.readAutomatedCreationPage).toBe('function');
  expect(Object.keys(bindings).sort()).toEqual([
    'continuations',
    'delegations',
    'grants',
    'internalLifecycle',
    'lifecycle',
    'operators',
    'trustedAccess',
    'workflowPorts',
  ]);
});

test('the production seam imports native capabilities without an Auth host, DBOS runtime or pool ownership', async () => {
  const source = await Bun.file(new URL('../../src/access/native-account-bindings.ts', import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  const imports = transpiler.scanImports(source).map((entry) => entry.path);
  expect(imports).toContain('./auth-bindings.ts');
  expect(imports).toContain('./registration-proof.ts');
  expect(imports).toContain('./auth-barriers.ts');
  expect(imports).toContain('./auth-session-capability.ts');
  expect(imports).toContain('./workflow-approvals.ts');
  expect(imports).not.toContain('@rezics/auth');
  expect(imports).not.toContain('pg');
  expect(imports.some((path) => /dbos|host|website|provider/.test(path))).toBe(false);
  const compiled = transpiler.transformSync(source);
  expect(transpiler.scan(compiled).exports.sort()).toEqual([
    'NativeAccountBindingsUnavailableError',
    'createNativeAccountBindings',
  ]);
});
