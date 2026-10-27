import { DurableInitiatorUnavailableError } from './durable-initiator.ts';
import { accessEvidence } from './evidence.ts';
import { ACCESS_EVIDENCE_TTL_MS, accessEvidenceDeadline } from './evidence-deadline.ts';
import { requireAccessDeadline } from './unavailable.ts';
import canonicalize from 'canonicalize';
import { durableInitiatorCommitment } from './durable-initiator-capture.ts';
import type { Access, AccessContext, AccountActor } from '../request/access.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import delegationRead from './durable-initiator-delegation.sql';
import receiptRead from '../command/read-receipt.sql';
import { deadlineClient, within } from './authenticate.ts';
import { readAccount, type Account } from './account-data.ts';
import type { DurableInitiatorRecord, InitiatorRestoreInput, InitiatorRestorerConfig } from './durable-initiator.ts';
import { accessRoot } from './derived-access.ts';

// This bridge is deliberately separate from the expiring workflow approval
// bridge. Neither serializable rows nor an exported captureActor port mint it.
declare const durableIdentity: unique symbol;
export type DurableIdentity = { readonly [durableIdentity]: true };
type Facts = {
  scope: object;
  context: AccessContext;
  time: AuthoritativeTime;
  operation: InitiatorRestoreInput['operation'];
  action: string;
  resource: InitiatorRestoreInput['anchor']['resource'];
  actor: AccountActor;
  account: Account;
  deadline: number;
};
type Bridge = {
  scope: object;
  restore(proof: DurableIdentity, context: AccessContext, time: AuthoritativeTime): Promise<AccountActor>;
  discard(actor: AccountActor): void;
};
const proofs = new WeakMap<DurableIdentity, Facts>();
const bridges = new WeakMap<Access, Bridge>();
export function installDurableIdentityBridge(access: Access, bridge: Bridge): void {
  const root = accessRoot(access);
  if (root !== access) throw new Error('Cannot install durable identity bridge on derived Access');
  if (bridges.has(root)) throw new Error('Durable identity bridge already installed');
  bridges.set(root, bridge);
}
/** Consumed once, only by the installed authenticator for this exact call. */
export function consumeDurableIdentity(
  proof: DurableIdentity,
  scope: object,
  context: AccessContext,
  time: AuthoritativeTime,
): Facts | undefined {
  const facts = proofs.get(proof);
  proofs.delete(proof);
  requireAccessDeadline(context.deadline);
  if (facts) requireAccessDeadline(facts.deadline);
  authoritativeTimeValue(time);
  if (
    !facts ||
    facts.scope !== scope ||
    facts.context !== context ||
    facts.context.pool !== context.pool ||
    facts.time !== time
  )
    return undefined;
  return facts;
}
export function discardDurableIdentity(access: Access, actor: AccountActor): void {
  bridges.get(accessRoot(access))?.discard(actor);
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && value.length <= max;
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
const resource = (value: { route: number; id: string }) =>
  routeOf(value.id) !== null && routeOf(value.id) === value.route;
const scopes = (value: readonly string[]) =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((s) => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(s));

/** The only mint path: actual owning-module read, exact native creation receipt,
 * Auth-owned current consent and independently anchored native account evidence.
 * The module reader's provenance obligations are exported in durable-initiator.
 */
export async function restoreOperationIdentity(
  config: InitiatorRestorerConfig,
  input: InitiatorRestoreInput,
  time: AuthoritativeTime,
): Promise<AccountActor> {
  const { access, pool, readOperation, readConsent } = config;
  const bridge = bridges.get(accessRoot(access));
  const { context, operation } = input;
  requireAccessDeadline(context.deadline);
  authoritativeTimeValue(time);
  if (
    !bridge ||
    context.pool !== pool ||
    !Number.isFinite(context.deadline) ||
    !resource(operation) ||
    !text(operation.kind, 255) ||
    routeOf(operation.sourceId) === null ||
    !resource(input.anchor.resource) ||
    !text(input.action, 128) ||
    typeof readOperation !== 'function' ||
    typeof readConsent !== 'function'
  )
    throw new Error('Durable identity unavailable');
  const deadline = accessEvidenceDeadline(context.deadline, ACCESS_EVIDENCE_TTL_MS);
  // Copy the allowlisted result before releasing the module's reader. Subsequent
  // callback/JSON mutations can never change the verified receipt binding.
  const record: DurableInitiatorRecord | null = await within(deadline, () =>
    withConnection(pool, async (client) => {
      const row = await accessEvidence(
        () => readOperation(deadlineClient(client, deadline), Object.freeze({ ...operation }), time),
        () => new DurableInitiatorUnavailableError(),
        deadline,
      );
      return row === null ? null : structuredClone(row);
    }),
  );
  if (
    !record ||
    !exact(record, [
      'operation',
      'initiatorAccountId',
      'actor',
      'recordedTransactionId',
      'sourceDigest',
      'originalAccount',
      'originalDelegation',
      'creation',
    ])
  )
    throw new Error('Missing operation evidence');
  const { actor, creation, originalAccount, originalDelegation } = record;
  if (
    !exact(record.operation, ['route', 'id', 'kind', 'sourceId']) ||
    canonicalize(record.operation) !== canonicalize(operation) ||
    !actor ||
    !exact(actor, ['kind', 'accountId', 'clientId', 'scopes', 'requestedBy', 'authnEpoch']) ||
    actor.kind !== 'account' ||
    routeOf(actor.accountId) === null ||
    actor.accountId !== record.initiatorAccountId ||
    !text(actor.clientId, 1024) ||
    !scopes(actor.scopes) ||
    !Number.isSafeInteger(actor.authnEpoch) ||
    actor.authnEpoch <= 0 ||
    (actor.requestedBy !== null && !text(actor.requestedBy, 128)) ||
    routeOf(record.recordedTransactionId) === null ||
    !hex(record.sourceDigest) ||
    !originalAccount ||
    !exact(originalAccount, ['minimumAuthnEpoch', 'operatorAccountId']) ||
    !/^[1-9][0-9]{0,18}$/.test(originalAccount.minimumAuthnEpoch) ||
    (originalAccount.operatorAccountId !== null && routeOf(originalAccount.operatorAccountId) === null) ||
    !creation ||
    !exact(creation, ['commandKind', 'idempotencyKey', 'requestDigest', 'target']) ||
    !text(creation.commandKind, 255) ||
    !text(creation.idempotencyKey, 255) ||
    !hex(creation.requestDigest) ||
    !creation.target ||
    !exact(creation.target, ['route', 'id']) ||
    !resource(creation.target)
  )
    throw new Error('Invalid operation evidence');
  const delegation = actor.requestedBy === null ? null : /^urn:rezics:request:([^:]+):([^:]+)$/.exec(actor.requestedBy);
  if (
    actor.requestedBy === null
      ? originalDelegation !== null
      : !delegation ||
        routeOf(delegation[1]!) === null ||
        routeOf(delegation[2]!) === null ||
        !originalDelegation ||
        !exact(originalDelegation, ['transactionId', 'issuedValid']) ||
        routeOf(originalDelegation.transactionId) === null ||
        typeof originalDelegation.issuedValid !== 'string' ||
        originalDelegation.issuedValid.length > 256
  )
    throw new Error('Invalid original delegation');
  const receipt = await receiptRead.run(deadlineClient(pool, deadline), {
    partition_no: partitionOf(operation.route),
    principal_kind: 'account',
    principal_id: actor.accountId,
    command_kind: creation.commandKind,
    idempotency_key: creation.idempotencyKey,
  });
  const binding = durableInitiatorCommitment(record);
  const response = receipt?.response as { durableInitiator?: unknown } | undefined;
  if (
    !receipt ||
    receipt.transactionId !== record.recordedTransactionId ||
    Buffer.from(receipt.requestDigest).toString('hex') !== creation.requestDigest ||
    response?.durableInitiator !== binding
  )
    throw new Error('Uncommitted operation evidence');
  // Auth owns this current tuple at its own home and clock; never infer it from
  // the recorded token epoch or an Access account observation.
  const consent = await within(deadline, () =>
    readConsent({ actorAccountId: actor.accountId, clientId: actor.clientId, deadline }),
  );
  if (
    !consent ||
    consent.actorAccountId !== actor.accountId ||
    consent.clientId !== actor.clientId ||
    !scopes(consent.scopes)
  )
    throw new Error('Current consent unavailable');
  const account = await readAccount(deadlineClient(pool, deadline), routeOf(actor.accountId)!, actor.accountId);
  if (
    !account ||
    account.accountId !== actor.accountId ||
    account.route !== routeOf(actor.accountId) ||
    account.kind !== 'actor' ||
    account.state !== 'active' ||
    account.fenced ||
    account.minimumAuthnEpoch.toString() !== originalAccount.minimumAuthnEpoch ||
    BigInt(actor.authnEpoch) < account.minimumAuthnEpoch ||
    account.operatorAccountId !== originalAccount.operatorAccountId
  )
    throw new Error('Current identity unavailable');
  if (delegation && originalDelegation) {
    const current = await delegationRead.run(deadlineClient(pool, deadline), {
      route: routeOf(delegation[1]!)!,
      principal_id: delegation[1]!,
      request_id: delegation[2]!,
      actor_id: actor.accountId,
      at: authoritativeTimeValue(time),
    });
    if (
      !current ||
      current.transactionId !== originalDelegation.transactionId ||
      current.issuedValid !== originalDelegation.issuedValid
    )
      throw new Error('Current delegation unavailable');
  }
  const currentScopes = new Set(consent.scopes);
  const restored: AccountActor = Object.freeze({
    ...actor,
    scopes: Object.freeze([...new Set(actor.scopes.filter((scope) => currentScopes.has(scope)))]),
  });
  const proof = Object.freeze({}) as DurableIdentity;
  proofs.set(proof, {
    scope: bridge.scope,
    context,
    time,
    operation: Object.freeze({ ...operation }),
    action: input.action,
    resource: Object.freeze({ ...input.anchor.resource }),
    actor: restored,
    account: Object.freeze(account),
    deadline,
  });
  try {
    return await bridge.restore(proof, context, time);
  } finally {
    proofs.delete(proof);
  }
}
