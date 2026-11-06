import {
  parseAccountOperationApprovalResponse,
  parseRenameExecutionResponse,
  parseDeletionExecutionResponse,
  parseMembershipApprovalResponse,
  ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH,
  ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH,
  automatedAccountOperationRequestByteBudgets,
  type AutomatedAccountExecutionUnresolved,
  parseOrganizationExecutionResponse,
} from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import type { AccountOperation, createAccountWorkflows } from './workflows.ts';
import { managementCallerMatches } from './auth-management-client.ts';
import {
  automatedCallerMatches,
  automatedDescriptorMatches,
  automatedNativeResult,
} from './automated-account-transport.ts';
import type { OperatorTransferState } from './account-management-read-transport.ts';
import { authDeletionHandleRead, deletionConfirmationMatches } from './kernel-access.ts';

/** Kernel workflow approval and platform gate ports, bound by the composition.
 * The transport hands them an Access bearer from a live Auth proof scope and
 * never builds an actor, a scope or a bearer itself. */
export interface AccountOperationAccess<Context = { pool: unknown; deadline: number }> {
  /** One bounded context per request. */
  context(): Context;
  /** Additive native private read. Omitted bindings return typed 503. */
  readOperatorTransferState?(
    token: string,
    input: { subjectAccountId: string },
    context: Context,
  ): Promise<OperatorTransferState | null>;
  approve(
    token: string,
    input: { operationKey: string; operation: AccountOperation },
    context: Context,
  ): Promise<{ reference: string; expiresAt: string }>;
  resolveForCaller(token: string, reference: string, operation: AccountOperation, context: Context): Promise<unknown>;
  /** The kernel route-admission rule for one group: true when the group is open
   * or the person holds `gate:<group>` or `gate:any` on the Global Context. */
  admitGroup(token: string, group: string, context: Context): Promise<boolean>;
  /** Current handle of the deletion target. A live handle requires typed confirmation; handleless and omitted bindings skip it. */
  readDeletionHandle?(token: string, accountId: string, context: Context): Promise<string | null>;
}

export class TransportDenied extends Error {
  constructor(readonly status: number) {
    super('Transport denied');
  }
}

/** Bounded JSON object reader shared by the Auth host transports. */
export async function readJsonObject(request: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new TransportDenied(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new TransportDenied(413);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TransportDenied(400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TransportDenied(400);
  return parsed as Record<string, unknown>;
}

const GATED_GROUP = 'organizations';
const OPERATION_FIELDS: Record<string, readonly string[]> = {
  organization: ['kind', 'handle'],
  automated: ['kind', 'registrationId', 'operationKey', 'operatorAccountId', 'handle'],
  rename: ['kind', 'accountId', 'handle', 'expectedHandle'],
  delete: ['kind', 'accountId', 'responsibility'],
  transfer: ['kind', 'previous', 'expectedVersion', 'operatorAccountId', 'acceptance'],
  'transfer-acceptance': ['kind', 'previous', 'expectedVersion', 'operatorAccountId', 'sourceOperationKey'],
  membership: ['kind', 'organizationId', 'memberAccountId', 'role', 'reservationId'],
  'fence-operator': ['kind', 'accountId'],
  opening: ['kind', 'operatorAccountId', 'subjectAccountId'],
};
type Workflows = Pick<
  ReturnType<typeof createAccountWorkflows>,
  | 'createAutomated'
  | 'createOrganization'
  | 'renameHandle'
  | 'deleteAccount'
  | 'transferOperator'
  | 'setMembership'
  | 'fenceOperator'
>;
type Operation = Record<string, unknown> & { kind: string };

function deny(status = 400): never {
  throw new TransportDenied(status);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) deny();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny();
  return value as Record<string, unknown>;
}
function automatedApprovalOutputAdmitted(approval: { reference: string; expiresAt: string }): boolean {
  if (
    typeof approval.reference !== 'string' ||
    approval.reference.length === 0 ||
    approval.reference.length > ACCOUNT_OPERATION_REFERENCE_MAX_LENGTH ||
    typeof approval.expiresAt !== 'string' ||
    approval.expiresAt.length !== ACCOUNT_OPERATION_EXPIRY_MAX_LENGTH
  )
    return false;
  const expires = Date.parse(approval.expiresAt);
  return Number.isFinite(expires) && new Date(expires).toISOString() === approval.expiresAt && expires > Date.now();
}
/** Closed field list per kind; the kernel's closed descriptor decides authority. */
function operationOf(value: unknown): Operation {
  const operation = record(value);
  const fields = typeof operation.kind === 'string' ? OPERATION_FIELDS[operation.kind] : undefined;
  if (!fields || Object.keys(operation).some((field) => !fields.includes(field))) deny();
  if (operation.acceptance !== undefined) text(operation.acceptance);
  return operation as Operation;
}

/** `POST /account-operations/approve` and `/execute` on the Auth host. */
export function accountOperationTransport(
  service: AuthService,
  workflows: Workflows,
  fallback: (request: Request) => Promise<Response>,
  access: AccountOperationAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const command = new Map([
      ['/account-operations/approve', 'approve'],
      ['/account-operations/execute', 'execute'],
    ]).get(url.pathname);
    if (!command) return fallback(request);
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        },
      });
    const denied = (status: number) =>
      response({ error: 'account_operation_denied', effect_status: 'not_applied' }, status);
    if (!access) return denied(503);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return denied(400);
    let effectDispatched = false;
    let automatedExecutionMayHaveCompleted = false;
    try {
      const body = await readJsonObject(
        request,
        command === 'execute' ? Math.max(16384, automatedAccountOperationRequestByteBudgets.execute) : 16384,
      );
      const names =
        command === 'approve'
          ? ['operationKey', 'operation', 'accountId']
          : ['operationKey', 'operation', 'reference', 'acceptance', 'accountId', 'confirmation'];
      if (Object.keys(body).some((field) => !names.includes(field))) return denied(400);
      const key = text(body.operationKey);
      const operation = operationOf(body.operation);
      const management = Object.hasOwn(body, 'accountId');
      if (management) text(body.accountId);
      const automated = operation.kind === 'automated';
      const opening = operation.kind === 'opening';
      if (
        opening &&
        (command === 'execute' ||
          !management ||
          request.headers.has('authorization') ||
          request.headers.get('sec-fetch-site') === 'cross-site')
      )
        return denied(400);
      if (
        automated &&
        (!management ||
          !automatedDescriptorMatches(operation, key) ||
          request.headers.has('authorization') ||
          request.headers.get('sec-fetch-site') === 'cross-site')
      )
        return denied(400);
      const callerMatches = automated ? automatedCallerMatches : managementCallerMatches;
      const context = access.context();
      if (command === 'approve') {
        const approval = await service.internal.withFreshHuman({ headers: request.headers }, async (proof) => {
          if (management && !callerMatches(proof, body.accountId, operation)) deny(403);
          const token = await service.internal.accessTokenForProof(proof);
          if (operation.kind === 'organization' && !(await access.admitGroup(token, GATED_GROUP, context))) return null;
          return access.approve(
            token,
            { operationKey: key, operation: { ...operation, authorization: 'approval-request' } as AccountOperation },
            context,
          );
        });
        if (!approval) return response({ error: 'platform_closed', effect_status: 'not_applied' }, 403);
        const projected = { reference: approval.reference, expiresAt: approval.expiresAt };
        if (
          ['opening', 'rename', 'delete', 'organization'].includes(operation.kind) &&
          !parseAccountOperationApprovalResponse(projected)
        )
          return response({ error: 'unavailable' }, 503);
        if (operation.kind === 'membership' && !parseMembershipApprovalResponse(projected))
          return response({ error: 'unavailable' }, 503);
        if (automated && !automatedApprovalOutputAdmitted(approval)) return denied(503);
        return response(projected);
      }
      if (operation.kind === 'transfer-acceptance' || operation.kind === 'opening') return denied(400);
      if (body.acceptance !== undefined) {
        if (
          operation.kind !== 'transfer' ||
          (operation.acceptance !== undefined && operation.acceptance !== text(body.acceptance))
        )
          return denied(400);
        operation.acceptance = body.acceptance;
      }
      const authorization = text(body.reference);
      const executable = { ...operation, authorization } as AccountOperation;
      // The caller proves the person; the workflow resolves the approval again.
      const callerToken = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: management },
        async (proof) => {
          if (management && !callerMatches(proof, body.accountId, operation)) deny(403);
          return service.internal.accessTokenForProof(proof);
        },
      );
      if (operation.kind === 'delete') {
        if (body.confirmation !== undefined && typeof body.confirmation !== 'string') return denied(400);
        const readHandle = access.readDeletionHandle ?? authDeletionHandleRead(access)?.readDeletionHandle;
        // Handleless accounts skip typed confirmation. A live handle requires it.
        if (readHandle) {
          const handle = await readHandle(callerToken, operation.accountId as string, context);
          if (
            handle &&
            (typeof body.confirmation !== 'string' || !deletionConfirmationMatches(body.confirmation, handle))
          )
            return denied(403);
        }
      }
      await access.resolveForCaller(callerToken, authorization, executable, context);
      const input = { key, authorization } as const;
      switch (operation.kind) {
        case 'automated': {
          // From this point the native workflow may commit before an exception
          // or incompatible result reaches the transport. Do not label that
          // outcome not_applied.
          automatedExecutionMayHaveCompleted = true;
          const result = automatedNativeResult(
            await workflows.createAutomated({
              ...input,
              operatorAccountId: operation.operatorAccountId as string,
              handle: operation.handle as string,
            }),
          );
          return result
            ? response(result)
            : response({ error: 'account_operation_unresolved' } satisfies AutomatedAccountExecutionUnresolved, 503);
        }
        case 'organization': {
          effectDispatched = true;
          const result = parseOrganizationExecutionResponse(
            await workflows.createOrganization({ ...input, handle: operation.handle as string }),
          );
          // An incomplete/incompatible workflow reply may follow native effects.
          return result ? response(result) : response({ error: 'unavailable' }, 503);
        }
        case 'rename': {
          const result = parseRenameExecutionResponse(
            await workflows.renameHandle({
              ...input,
              accountId: operation.accountId as string,
              handle: operation.handle as string,
              expectedHandle: operation.expectedHandle as string | null,
            }),
          );
          // Completion may already have happened. An incompatible projection is
          // unavailable, never a fabricated not_applied refusal.
          return result && result.accountId === operation.accountId
            ? response(result)
            : response({ error: 'unavailable' }, 503);
        }
        case 'delete': {
          effectDispatched = true;
          const result = parseDeletionExecutionResponse(
            await workflows.deleteAccount({
              ...input,
              accountId: operation.accountId as string,
              ...(operation.responsibility === undefined ? {} : { responsibility: operation.responsibility as never }),
            }),
          );
          return result && result.accountId === operation.accountId
            ? response(result)
            : response({ error: 'unavailable' }, 503);
        }
        case 'transfer':
          return response(
            await workflows.transferOperator({
              ...input,
              previous: operation.previous as never,
              expectedVersion: operation.expectedVersion as string,
              operatorAccountId: operation.operatorAccountId as string,
              ...(operation.acceptance === undefined ? {} : { acceptance: text(operation.acceptance) }),
            }),
          );
        case 'membership':
          effectDispatched = true;
          return response(
            await workflows.setMembership({
              ...input,
              organizationId: operation.organizationId as string,
              memberAccountId: operation.memberAccountId as string,
              role: operation.role as 'owner' | 'member' | null,
              ...(operation.reservationId === undefined ? {} : { reservationId: operation.reservationId as string }),
            }),
          );
        default:
          return response(await workflows.fenceOperator({ ...input, accountId: operation.accountId as string }));
      }
    } catch (error) {
      // After invoking deletion, membership or organization creation, an exception can follow a committed effect.
      if (effectDispatched) return response({ error: 'unavailable' }, 503);
      if (automatedExecutionMayHaveCompleted)
        return response({ error: 'account_operation_unresolved' } satisfies AutomatedAccountExecutionUnresolved, 503);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'step_up_required')
        return response({ error: 'step_up_required', effect_status: 'not_applied' }, 401);
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return denied(typeof status === 'number' && [400, 401, 403, 409, 413, 415].includes(status) ? status : 503);
    }
  };
}
