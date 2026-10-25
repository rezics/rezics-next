import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { AccountOperation } from '@rezics/auth';
import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, ActionCatalogue } from '../request/access.ts';
import { seal, type KeyRing } from '../tokens/seal.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { authoritativeTimeValue, runCommand, type CommandAuthorization } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './authenticate.ts';
import { readAccount } from './account-data.ts';
import {
  APPROVAL_REFERENCE_PURPOSE,
  approvalRowDigest,
  readApprovedIdentity,
  verifiedBearerExpiry,
} from './approved-identity.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import type { LifecycleRequest } from './lifecycle.ts';
import approvalInsert from './workflow-approvals-insert.sql';
import approvalSweep from './workflow-approvals-sweep.sql';

export const MAX_WORKFLOW_APPROVAL_LIFETIME_MS = 300_000;
/** Nonsecret integrity-bound locator only; no actor, credentials or authority. */
export type WorkflowApproval = { reference: string; expiresAt: string };
export type WorkflowApprovalConfig = { pool: Pool; access: Access; actions: ActionCatalogue; referenceKeys: KeyRing };
export type WorkflowApprovalRequest = { operationKey: string; operation: AccountOperation };
export type WorkflowApprovalBinding = Readonly<{
  operationKey: string;
  digest: string;
  /** Stable across fresh approvals and DBOS attempts. Append a fixed native step
   * name, and keep the native command's complete input digest on every retry. */
  commandKeyPrefix: string;
}>;
const bindings = new WeakMap<LifecycleRequest, WorkflowApprovalBinding>();
/** Return only durable binding metadata; never serialize the resolved context. */
export function workflowApprovalBinding(request: LifecycleRequest): WorkflowApprovalBinding | undefined {
  return bindings.get(request);
}
export class WorkflowApprovalUnavailableError extends Error {
  constructor() {
    super('Durable workflow approvals are unavailable');
    this.name = 'WorkflowApprovalUnavailableError';
  }
}
const denied = () => new WorkflowApprovalUnavailableError();
function requireAllowed(value: unknown): asserts value {
  if (!value) throw denied();
}
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const handle = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && routeOf(value) !== null;
const text = (value: unknown, max = 255): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

type NativeKind = 'rename' | 'delete' | 'membership';
type Descriptor = { action: string; target: string; targetKind: 'actor' | 'organization' | 'either' };
/** Server-owned closed descriptors. Missing adapters deny explicitly; a catalogue
 * entry alone can never manufacture native authority for one of these kinds. */
const unavailableAdapters = {
  organization: 'organization creation parent',
  automated: 'pending registration and operator management',
  transfer: 'operator responsibility transfer',
  revoke: 'Auth session revocation',
  'fence-operator': 'operator fence',
  consent: 'Auth consent reduction',
  'client-reduction': 'Auth client management',
  opening: 'operator session opening',
} as const satisfies Record<Exclude<AccountOperation['kind'], NativeKind>, string>;

function operationSnapshot(value: AccountOperation): { operation: AccountOperation; descriptor: Descriptor } {
  requireAllowed(value && typeof value === 'object' && !Array.isArray(value));
  const encoded = canonicalize(value);
  requireAllowed(typeof encoded === 'string' && Buffer.byteLength(encoded) <= 12000);
  const operation = JSON.parse(encoded) as AccountOperation;
  requireAllowed(!Object.hasOwn(unavailableAdapters, operation.kind));
  let descriptor: Descriptor;
  let fields: string[];
  switch (operation.kind) {
    case 'rename':
      requireAllowed(
        id(operation.accountId) &&
          handle(operation.handle) &&
          (operation.expectedHandle === null || handle(operation.expectedHandle)),
      );
      fields = ['kind', 'accountId', 'handle', 'expectedHandle', 'authorization'];
      descriptor = { action: 'account:update', target: operation.accountId, targetKind: 'either' };
      break;
    case 'delete':
      requireAllowed(id(operation.accountId));
      if (operation.responsibility !== undefined) {
        const r = operation.responsibility;
        requireAllowed(
          r &&
            id(r.operatorAccountId) &&
            id(r.subjectAccountId) &&
            r.subjectAccountId === operation.accountId &&
            text(r.reservationId),
        );
        requireAllowed(Object.keys(r).sort().join(',') === 'operatorAccountId,reservationId,subjectAccountId');
      }
      fields = ['kind', 'accountId', 'responsibility', 'authorization'];
      descriptor = { action: 'account:delete', target: operation.accountId, targetKind: 'either' };
      break;
    case 'membership':
      requireAllowed(
        id(operation.organizationId) &&
          id(operation.memberAccountId) &&
          [null, 'owner', 'member'].includes(operation.role),
      );
      requireAllowed(operation.reservationId === undefined || text(operation.reservationId));
      fields = ['kind', 'organizationId', 'memberAccountId', 'role', 'reservationId', 'authorization'];
      descriptor = { action: 'organization:membership', target: operation.organizationId, targetKind: 'organization' };
      break;
    default:
      throw denied();
  }
  requireAllowed(text(operation.authorization, 4096) && Object.keys(operation).every((key) => fields.includes(key)));
  return { operation, descriptor };
}
// The reference is transport metadata, not part of the business operation.
// Never persist it: a hostile authorization field may itself contain a bearer.
function businessOperation(operation: AccountOperation): unknown {
  const { authorization: _reference, ...complete } = operation as AccountOperation & { authorization?: string };
  return complete;
}
const resourceOf = (descriptor: Descriptor) => ({ route: routeOf(descriptor.target)!, id: descriptor.target });
function anchor(descriptor: Descriptor) {
  const resource = resourceOf(descriptor);
  return {
    resource,
    async validate(client: Parameters<Access['authorize']>[0]) {
      const account = await readAccount(client, resource.route, resource.id);
      return (
        !!account &&
        account.state === 'active' &&
        !account.fenced &&
        (descriptor.targetKind === 'either' || account.kind === descriptor.targetKind)
      );
    },
  };
}

/** Native durable approval storage only. Resolve separately in every protected
 * step; the actual command must still authorize at its own T before receipts.
 * Auth consent reductions invalidate these original scopes through the shared
 * Access epoch floor. No Auth database, introspection or runtime is consulted.
 */
export function createWorkflowApprovals(config: WorkflowApprovalConfig) {
  function boundary(context: AccessContext): AccessContext {
    requireAllowed(context.pool === config.pool && Number.isFinite(context.deadline) && Date.now() < context.deadline);
    return { pool: config.pool, deadline: context.deadline };
  }
  function authorization(actor: AccountActor, descriptor: Descriptor, context: AccessContext): CommandAuthorization {
    requireAllowed(config.actions.has(descriptor.action));
    return resourceAuthorization({
      access: config.access,
      actor,
      action: descriptor.action,
      anchor: anchor(descriptor),
      context: { ...context, partition: partitionOf(routeOf(actor.accountId)!) },
    });
  }
  async function resolve(
    reference: string,
    input: AccountOperation,
    context: AccessContext,
    caller?: AccountActor,
  ): Promise<LifecycleRequest> {
    const bounded = boundary(context);
    const { operation, descriptor } = operationSnapshot(input);
    const { row, actor } = await within(bounded.deadline, () =>
      readApprovedIdentity(config.access, config.referenceKeys, reference, bounded),
    );
    requireAllowed(
      !caller ||
        (caller.accountId === actor.accountId &&
          caller.clientId === actor.clientId &&
          caller.requestedBy === actor.requestedBy &&
          canonicalize([...caller.scopes].sort()) === canonicalize([...actor.scopes].sort())),
    );
    requireAllowed(
      hash([row.operationKey, businessOperation(operation)]) === row.digest &&
        canonicalize(row.operation) === canonicalize(businessOperation(operation)),
    );
    requireAllowed(config.actions.has(descriptor.action));
    const deadline = Math.min(bounded.deadline, Date.parse(row.expiresAt), Date.parse(row.jwtExpiresAt));
    requireAllowed(Date.now() < deadline && config.access.prepare);
    const evidence = await config.access.prepare(actor, descriptor.action, resourceOf(descriptor), {
      pool: config.pool,
      deadline,
    });
    // The final native formula obtains authoritative SQL T. Identity/principal
    // preparation has released its connections before this resource checkout.
    const allowed = await within(deadline, () =>
      withConnection(config.pool, async (client) => {
        const boundedClient = deadlineClient(client, deadline);
        return (
          (await anchor(descriptor).validate(boundedClient)) &&
          (await config.access.authorize(boundedClient, actor, descriptor.action, resourceOf(descriptor), evidence))
        );
      }),
    );
    requireAllowed(allowed && Date.now() < deadline);
    const request: LifecycleRequest = Object.freeze({ actor, deadline });
    bindings.set(
      request,
      Object.freeze({
        operationKey: row.operationKey,
        digest: row.digest,
        commandKeyPrefix: `wf:${hash([actor.accountId, row.operationKey])}`,
      }),
    );
    return request;
  }
  return {
    async approve(token: string, input: WorkflowApprovalRequest, context: AccessContext): Promise<WorkflowApproval> {
      try {
        const bounded = boundary(context);
        requireAllowed(input && text(input.operationKey));
        const operationKey = input.operationKey;
        const { operation, descriptor } = operationSnapshot(input.operation);
        const actor = await config.access.authenticate(token, bounded);
        const expires = verifiedBearerExpiry(config.access, actor, bounded);
        const deadline = Math.min(bounded.deadline, expires);
        const route = routeOf(actor.accountId)!;
        const digest = hash([operationKey, businessOperation(operation)]);
        const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
        // A native exact receipt permanently binds this logical key to one complete
        // operation and original actor/client/principal. Fresh approval may resume
        // it, but a different digest cannot produce another business effect.
        await runCommand(
          config.pool,
          {
            partition: partitionOf(route),
            deadline,
            basis,
            authorization: authorization(actor, descriptor, { pool: config.pool, deadline }),
            receipt: {
              actorAccountId: actor.accountId,
              kind: 'access.workflow-approval.binding',
              key: `${route}:${hash(operationKey)}`,
              digest: Buffer.from(hash([basis, digest]), 'hex'),
            },
          },
          async () => ({
            value: { operationKey, digest },
            events: [{ type: 'com.rezics.access.workflow-bound.v1', data: { digest } }],
          }),
        );
        const approvalId = newId(route);
        const result = await runCommand(
          config.pool,
          {
            partition: partitionOf(route),
            deadline,
            basis,
            authorization: authorization(actor, descriptor, { pool: config.pool, deadline }),
            receipt: {
              actorAccountId: actor.accountId,
              kind: 'access.workflow-approval.create',
              key: `${route}:${approvalId}`,
              digest: Buffer.from(digest, 'hex'),
            },
          },
          async (tx, command) => {
            const rows = await approvalInsert.run(tx, {
              route,
              approval_id: approvalId,
              actor_id: actor.accountId,
              client_id: actor.clientId,
              scopes: [...actor.scopes],
              requested_by: actor.requestedBy,
              authn_epoch: actor.authnEpoch,
              operation_key: operationKey,
              operation: businessOperation(operation),
              digest,
              at: authoritativeTimeValue(command.time),
              jwt_expires_at: new Date(expires).toISOString(),
              transaction_id: command.transactionId,
            });
            const row = rows[0];
            requireAllowed(row);
            const value = {
              reference: seal(config.referenceKeys, APPROVAL_REFERENCE_PURPOSE, {
                route,
                id: approvalId,
                binding: approvalRowDigest(row),
              }),
              expiresAt: new Date(row.expiresAt).toISOString(),
            };
            return {
              value,
              events: [
                {
                  type: 'com.rezics.access.workflow-approved.v1',
                  subject: actor.accountId,
                  data: { approvalId, digest },
                },
              ],
            };
          },
        );
        return result.value;
      } catch {
        throw denied();
      }
    },
    /** Trusted server workflow port, never an unauthenticated HTTP endpoint. */
    async resolve(reference: string, operation: AccountOperation, context: AccessContext): Promise<LifecycleRequest> {
      try {
        return await resolve(reference, operation, context);
      } catch {
        throw denied();
      }
    },
    async resolveForCaller(
      token: string,
      reference: string,
      operation: AccountOperation,
      context: AccessContext,
    ): Promise<LifecycleRequest> {
      try {
        const bounded = boundary(context);
        const caller = await config.access.authenticate(token, bounded);
        return await resolve(reference, operation, bounded, caller);
      } catch {
        throw denied();
      }
    },
  };
}

/** Internal scheduling port; one route/partition and at most 1000 exact expiry
 * keys per command. Expiry correctness never depends on this cleanup running. */
export async function sweepWorkflowApprovals(pool: Pool, route: number, limit: number): Promise<number> {
  requireAllowed(
    Number.isInteger(route) && route >= 0 && route <= 65535 && Number.isInteger(limit) && limit >= 1 && limit <= 1000,
  );
  const result = await runCommand(pool, { partition: partitionOf(route) }, async (tx, command) => {
    const rows = await approvalSweep.run(tx, { route, limit, at: authoritativeTimeValue(command.time) });
    return {
      value: rows.length,
      events: [{ type: 'com.rezics.access.workflow-approvals-swept.v1', data: { route, count: rows.length } }],
    };
  });
  return result.value;
}
