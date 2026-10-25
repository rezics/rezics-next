import { expect, expectTypeOf, test } from 'bun:test';
import type { AccountOperation } from '@rezics/auth';
import type { Pool } from 'pg';
import {
  MAX_WORKFLOW_APPROVAL_LIFETIME_MS,
  WorkflowApprovalUnavailableError,
  createWorkflowApprovals,
  type WorkflowApproval,
  type WorkflowApprovalConfig,
  type WorkflowApprovalRequest,
} from '../../src/access/workflow-approvals.ts';
import type { LifecycleRequest } from '../../src/access/lifecycle.ts';
import type { Access, AccessContext, ActionCatalogue } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

function untouched<T extends object>(): T {
  return new Proxy({} as T, {
    get() {
      throw new Error('Malformed evidence must fail closed');
    },
  });
}

function fixture() {
  const config: WorkflowApprovalConfig = {
    pool: untouched<Pool>(),
    access: untouched<Access>(),
    actions: untouched<ActionCatalogue>(),
    referenceKeys: untouched<KeyRing>(),
  };
  return { approvals: createWorkflowApprovals(config), context: untouched<AccessContext>() };
}

test('durable workflow approval interface constructs with explicit trusted configuration', () => {
  expect(MAX_WORKFLOW_APPROVAL_LIFETIME_MS).toBe(300_000);
  expectTypeOf<WorkflowApproval>().toEqualTypeOf<{ reference: string; expiresAt: string }>();
  expectTypeOf<WorkflowApprovalConfig>().toEqualTypeOf<{
    pool: Pool;
    access: Access;
    actions: ActionCatalogue;
    referenceKeys: KeyRing;
  }>();
  expectTypeOf<WorkflowApprovalRequest>().toEqualTypeOf<{ operationKey: string; operation: AccountOperation }>();
  expectTypeOf<Parameters<typeof createWorkflowApprovals>>().toEqualTypeOf<[WorkflowApprovalConfig]>();
  const { approvals } = fixture();
  expectTypeOf<typeof approvals>().toEqualTypeOf<{
    approve(token: string, input: WorkflowApprovalRequest, context: AccessContext): Promise<WorkflowApproval>;
    resolve(reference: string, operation: AccountOperation, context: AccessContext): Promise<LifecycleRequest>;
    resolveForCaller(
      token: string,
      reference: string,
      operation: AccountOperation,
      context: AccessContext,
    ): Promise<LifecycleRequest>;
  }>();
  expect(Object.keys(approvals).sort()).toEqual(['approve', 'resolve', 'resolveForCaller']);
});

test('malformed approval and resolution evidence fails closed', async () => {
  const { approvals, context } = fixture();
  const operation: AccountOperation = { kind: 'organization', handle: 'example', authorization: 'reference' };
  const hostile = {
    operationKey: 'stable-operation',
    operation,
    actor: { kind: 'account', accountId: 'forged', clientId: 'forged', authnEpoch: 999 },
    expiresAt: '9999-12-31T23:59:59.999Z',
  };
  for (const input of [hostile, untouched<WorkflowApprovalRequest>(), null as unknown as WorkflowApprovalRequest]) {
    await expect(approvals.approve('unverified-bearer', input, context)).rejects.toBeInstanceOf(
      WorkflowApprovalUnavailableError,
    );
  }
  for (const input of [
    operation,
    { kind: 'unknown-operation' } as unknown as AccountOperation,
    untouched<AccountOperation>(),
    null as unknown as AccountOperation,
  ]) {
    await expect(approvals.resolve('unverified-reference', input, context)).rejects.toBeInstanceOf(
      WorkflowApprovalUnavailableError,
    );
    await expect(
      approvals.resolveForCaller('other-caller', 'unverified-reference', input, context),
    ).rejects.toBeInstanceOf(WorkflowApprovalUnavailableError);
  }
});

test('failed contract requests never expose bearers or retain contexts', async () => {
  // Unavailable native dependencies must deny without exposing the supplied token.
  const { approvals, context } = fixture();
  const token = 'private-bearer-must-not-escape';
  const operation: AccountOperation = { kind: 'revoke', accountId: 'account' };
  const attempts = [
    approvals.approve(token, { operationKey: 'stable-operation', operation }, context),
    approvals.resolve('reference', operation, context),
    approvals.resolveForCaller(token, 'reference', operation, context),
  ];
  for (const attempt of attempts) {
    await expect(attempt).rejects.toBeInstanceOf(WorkflowApprovalUnavailableError);
    await expect(attempt).rejects.toHaveProperty('name', 'WorkflowApprovalUnavailableError');
    const error = await attempt.catch((error: Error) => error);
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  }
  expect(Reflect.ownKeys(approvals).sort()).toEqual(['approve', 'resolve', 'resolveForCaller']);
  expect(JSON.stringify(approvals)).toBe('{}');
});
