import type { NativeCreationContextRequest, NativeCreationContextResult } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access, AccessContext } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { accessClock } from './access-clock.ts';
import { readAccount } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';
import { readAssignment } from './delegation-commands.ts';
import type { LifecycleRequest } from './lifecycle.ts';
import { requireAccessDeadline } from '../request/unavailable.ts';
import {
  type createWorkflowApprovals,
  workflowApprovalBinding,
  workflowApprovalCreationSource,
  WorkflowApprovalDeniedError,
  WorkflowApprovalUnavailableError,
} from './workflow-approvals.ts';

type NativeSource = { pool: Pool; access: Access };
type CopyActor = { accountId: string; role: 'human' | 'initiator' | 'delegate' };

/** Shared with copyActors: classify only facts proved by native rows. An
 * automated bearer does not carry an opening locator, so it cannot identify a
 * human (or prove that no human was involved) from its actor claim alone. */
async function readParties(config: NativeSource, request: LifecycleRequest) {
  requireAccessDeadline(request.deadline);
  const binding = workflowApprovalBinding(request);
  const source = workflowApprovalCreationSource(request, config.pool);
  if (!binding || !source) return { kind: 'unavailable', reason: 'historical-provenance' } as const;
  if (accessClock(config.access)().getTime() >= Date.parse(binding.expiresAt)) throw new WorkflowApprovalDeniedError();
  const actor = request.actor;
  const account = await within(request.deadline, () =>
    withConnection(config.pool, (client) =>
      readAccount(deadlineClient(client, request.deadline), routeOf(actor.accountId)!, actor.accountId),
    ),
  );
  if (
    !account ||
    account.kind !== 'actor' ||
    account.state !== 'active' ||
    account.fenced ||
    BigInt(actor.authnEpoch) < account.minimumAuthnEpoch
  )
    throw new WorkflowApprovalDeniedError();
  if (account.operatorAccountId !== null) return { kind: 'unavailable', reason: 'opening-provenance' } as const;
  const assignment =
    actor.requestedBy === null
      ? ({ kind: 'none' } as const)
      : await within(request.deadline, () =>
          withConnection(config.pool, (client) =>
            readAssignment(
              deadlineClient(client, request.deadline),
              actor.requestedBy,
              actor.accountId,
              accessClock(config.access),
            ),
          ),
        );
  if (assignment.kind === 'unresolved') throw new WorkflowApprovalDeniedError();
  requireAccessDeadline(request.deadline);
  if (accessClock(config.access)().getTime() >= Date.parse(binding.expiresAt)) throw new WorkflowApprovalDeniedError();
  return {
    kind: 'available',
    context: Object.freeze({
      actorAccountId: actor.accountId,
      actingHumanId: account.accountId,
      operatorAccountId: source.operatorAccountId,
      principalAccountId: assignment.kind === 'resolved' ? assignment.principalId : null,
      sourceClientId: actor.clientId,
      approvalReference: source.approvalReference,
      commandKey: binding.commandKeyPrefix,
      operationKey: binding.operationKey,
      operationDigest: binding.digest,
      operation: source.operation,
    }),
  } as const;
}

/** Trusted composition only. Resolve through the existing approval engine at
 * current source T, including full original operation/key, assignment and grant
 * checks. This read does not consume, renew or create an approval. */
export async function readNativeCreationContext(
  config: NativeSource & { approvals: Pick<ReturnType<typeof createWorkflowApprovals>, 'resolve'> },
  input: NativeCreationContextRequest,
  boundary: AccessContext,
): Promise<NativeCreationContextResult> {
  requireAccessDeadline(boundary.deadline);
  if (boundary.pool !== config.pool) throw new WorkflowApprovalDeniedError();
  if (input.approvalReference === null) return { kind: 'unavailable', reason: 'historical-provenance' };
  if (
    typeof input.operationKey !== 'string' ||
    input.operationKey.length === 0 ||
    input.operationKey.length > 255 ||
    (input.operation.operationKey !== undefined && input.operation.operationKey !== input.operationKey)
  )
    throw new WorkflowApprovalDeniedError();
  const operation = { ...input.operation, operationKey: input.operationKey };
  const request = await config.approvals.resolve(input.approvalReference, operation, boundary);
  // Opening approval names both sides, but naming is not relation provenance.
  if (operation.kind === 'opening') {
    const subject = await within(boundary.deadline, () =>
      withConnection(config.pool, (client) =>
        readAccount(
          deadlineClient(client, boundary.deadline),
          routeOf(operation.subjectAccountId)!,
          operation.subjectAccountId,
        ),
      ),
    );
    if (
      !subject ||
      subject.kind !== 'actor' ||
      subject.state !== 'active' ||
      subject.fenced ||
      subject.operatorAccountId !== operation.operatorAccountId
    )
      throw new WorkflowApprovalDeniedError();
  }
  return readParties(config, request);
}

/** Existing native shared-copy roles and the private projection use one basis. */
export async function readNativeCopyActors(
  config: NativeSource,
  request: LifecycleRequest,
): Promise<readonly CopyActor[]> {
  const result = await readParties(config, request);
  if (result.kind !== 'available') throw new WorkflowApprovalUnavailableError();
  const { actorAccountId, actingHumanId, principalAccountId } = result.context;
  const roles: CopyActor[] = [];
  if (actingHumanId) roles.push({ accountId: actingHumanId, role: 'human' });
  roles.push({ accountId: actorAccountId, role: 'initiator' });
  if (principalAccountId) roles.push({ accountId: principalAccountId, role: 'delegate' });
  return roles;
}
