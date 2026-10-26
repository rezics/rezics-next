import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Access, AccessContext, AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { unseal, type KeyRing } from '../tokens/seal.ts';
import receiptRead from '../command/read-receipt.sql';
import approvalRead from './workflow-approvals-read.sql';
import { accessRoot } from './derived-access.ts';
import { systemClock, type KernelClock } from '../clock.ts';

export class ApprovalIdentityDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Approval denied');
    this.name = 'ApprovalIdentityDeniedError';
  }
}
export class ApprovalIdentityUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('Approval identity bridge unavailable');
    this.name = 'ApprovalIdentityUnavailableError';
  }
}

export const APPROVAL_REFERENCE_PURPOSE = 'access.workflow-approval.v1';
export type ApprovalRow = NonNullable<Awaited<ReturnType<typeof approvalRead.run>>>;
declare const approvedIdentity: unique symbol;
/** Internal opaque evidence. Only a verified native row can mint this brand. */
export type ApprovedIdentity = { readonly [approvedIdentity]: true };
type Claims = { actor: AccountActor; expires: number; scope: object; pool: AccessContext['pool'] };
const proofs = new WeakMap<ApprovedIdentity, Claims>();
type Bridge = {
  scope: object;
  clock?: KernelClock;
  expiry(actor: AccountActor, context: AccessContext): number | undefined;
  restore(proof: ApprovedIdentity, context: AccessContext): Promise<AccountActor>;
};
const bridges = new WeakMap<Access, Bridge>();

/** The factory supplies its root clock with the identity bridge. Keeping this
 * lookup here avoids importing the factory and its standalone Access during setup. */
export function approvalClock(access: Access): KernelClock {
  return bridges.get(accessRoot(access))?.clock ?? systemClock;
}

/** Factory composition only; no actor JSON registration or public bearer port. */
export function installApprovalIdentityBridge(access: Access, bridge: Bridge): void {
  const root = accessRoot(access);
  if (root !== access) throw new Error('Cannot install approval identity bridge on derived Access');
  if (bridges.has(root)) throw new Error('Approval identity bridge already installed');
  bridges.set(root, Object.freeze(bridge));
}
export function approvedIdentityClaims(
  proof: ApprovedIdentity,
  scope: object,
  pool: AccessContext['pool'],
): Claims | undefined {
  const facts = proofs.get(proof);
  return facts?.scope === scope && facts.pool === pool ? facts : undefined;
}
export function verifiedBearerExpiry(access: Access, actor: AccountActor, context: AccessContext): number {
  const bridge = bridges.get(accessRoot(access));
  if (!bridge) throw new ApprovalIdentityUnavailableError();
  const expires = bridge.expiry(actor, context);
  if (expires === undefined || approvalClock(access)().getTime() >= expires) throw new ApprovalIdentityDeniedError();
  return expires;
}
/** Bind every immutable column, including original scope ceiling and JWT expiry. */
export function approvalRowDigest(row: ApprovalRow): string {
  return createHash('sha256').update(canonicalize(row)!).digest('hex');
}

/** This is the only approval identity minting path. It requires the configured
 * MAC, exact native row, immutable binding and strict live native expiry. The
 * authenticator additionally reads the current actor and assignment on its pool.
 */
export async function readApprovedIdentity(
  access: Access,
  keys: KeyRing,
  reference: string,
  context: AccessContext,
): Promise<{ row: ApprovalRow; actor: AccountActor }> {
  const bridge = bridges.get(accessRoot(access));
  if (!bridge) throw new ApprovalIdentityUnavailableError();
  if (typeof reference !== 'string' || reference.length > 4096) throw new ApprovalIdentityDeniedError();
  const locator = unseal(keys, APPROVAL_REFERENCE_PURPOSE, reference) as
    | { route?: unknown; id?: unknown; binding?: unknown }
    | undefined;
  if (
    !locator ||
    typeof locator.id !== 'string' ||
    routeOf(locator.id) !== locator.route ||
    typeof locator.binding !== 'string'
  )
    throw new ApprovalIdentityDeniedError();
  const at = approvalClock(access)();
  const row = await approvalRead.run(context.pool, {
    route: locator.route as number,
    approval_id: locator.id,
    at: at.toISOString(),
  });
  if (!row || approvalRowDigest(row) !== locator.binding) throw new ApprovalIdentityDeniedError();
  const expires = Math.min(Date.parse(row.expiresAt), Date.parse(row.jwtExpiresAt));
  if (!Number.isFinite(expires) || at.getTime() >= expires) throw new ApprovalIdentityDeniedError();
  // A row-shaped fixture, restored dump fragment or caller JSON is insufficient:
  // approve must have committed this exact row and reference through core.
  const receipt = await receiptRead.run(context.pool, {
    partition_no: partitionOf(row.route),
    principal_kind: 'account',
    principal_id: row.actorId,
    command_kind: 'access.workflow-approval.create',
    idempotency_key: `${row.route}:${row.approvalId}`,
  });
  const response = receipt?.response as { reference?: unknown; expiresAt?: unknown } | undefined;
  if (
    !receipt ||
    receipt.transactionId !== row.transactionId ||
    !Buffer.from(receipt.requestDigest).equals(Buffer.from(row.digest, 'hex')) ||
    response?.reference !== reference ||
    response.expiresAt !== new Date(row.expiresAt).toISOString()
  )
    throw new ApprovalIdentityDeniedError();
  const scopes = row.scopes;
  if (!scopes.every((scope): scope is string => typeof scope === 'string')) throw new ApprovalIdentityDeniedError();
  const actor: AccountActor = Object.freeze({
    kind: 'account',
    accountId: row.actorId,
    clientId: row.clientId,
    scopes: Object.freeze([...scopes]),
    requestedBy: row.requestedBy,
    authnEpoch: Number(row.authnEpoch),
  });
  const proof = Object.freeze({}) as ApprovedIdentity;
  proofs.set(proof, { actor, expires, scope: bridge.scope, pool: context.pool });
  try {
    return { row: Object.freeze(row), actor: await bridge.restore(proof, context) };
  } finally {
    proofs.delete(proof);
  }
}
