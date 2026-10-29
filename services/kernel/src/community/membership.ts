import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { MembershipWorkInput } from '@rezics/auth-contract';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import {
  DurableInitiatorUnavailableError,
  type DurableInitiatorReader,
  type DurableInitiatorRecord,
  type DurableOperationAnchor,
  type InitiatorRestorer,
} from '../access/durable-initiator.ts';
import type { LifecycleRequest } from '../access/lifecycle.ts';
import type { MembershipBootstrapStep, MembershipReservation } from '../access/membership-inverse.ts';
import type { RealmMembershipCommands } from '../access/membership-work.ts';
import type { MembershipRoleProof, RealmRoleReader } from '../access/permission.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
  type PrincipalCommandIdentity,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import {
  accessCheck,
  accessCommandAuthorization,
  type AccessCommandAuthorization,
  type Access,
  type AccessClient,
} from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor } from '../request/deadline.ts';
import { unseal, type KeyRing } from '../tokens/seal.ts';
import { ensureRealmMemberGrant } from './participation.ts';
import realmActive from './membership-realm.sql';
import openMembership from './membership-open.sql';
import closeMembership from './membership-close.sql';
import writeTerminal from './membership-terminal.sql';
import readTerminalRow from './membership-read-terminal.sql';
import readChangeRow from './membership-read-change.sql';
import readCurrent from './membership-current.sql';
import readRoles from './membership-role.sql';
import readRoleBatch from './membership-role-batch.sql';
import readRealmHead from './realm-read.sql';
import currentBan from './ban-current.sql';
import readOperationRow from './membership-operation-read.sql';
import readOperationReceipt from './membership-operation-receipt.sql';

type MembershipInput = Extract<MembershipWorkInput, { kind: 'membership' }>;
type Row = Record<string, unknown>;
const MEMBERSHIP_KIND = 'community.realm.membership';
const TERMINAL_KIND = 'community.realm.membership.terminal';
const CLIENT_ID = 'realm-membership';
const AUTHORIZE_DEADLINE_MS = 30_000;
/** Shared by the HTTP issuer and the workflow authorizer. */
export const REALM_MEMBERSHIP_SEAL_SCOPE = 'community.realm.membership';

export type MembershipOperationKind = 'join' | 'leave' | 'removal';
/** Command kind of each acceptance command. It is also the durable operation's kind. */
export const MEMBERSHIP_OPERATION_COMMANDS = {
  join: 'community.realm.join',
  leave: 'community.realm.leave',
  removal: 'community.realm.removal',
} as const satisfies Record<MembershipOperationKind, string>;
/** The request's facts, committed with the operation. They carry no authority. */
export type MembershipOperationFacts = Readonly<{
  realmId: string;
  spaceId: string;
  memberAccountId: string;
  reservationId: string | null;
  banId: string | null;
}>;

/** Exact immutable source commitment: the operation, its creation target and the request's facts. */
export function membershipSourceDigest(
  operation: DurableOperationAnchor,
  target: DurableInitiatorRecord['creation']['target'],
  facts: MembershipOperationFacts,
): string {
  return createHash('sha256').update(canonicalize({ operation, target, facts })!).digest('hex');
}

/** The action the initiator holds on the Realm for this operation. */
export function membershipOperationAction(
  kind: MembershipOperationKind,
  initiatorAccountId: string,
  memberAccountId: string,
): 'realm:ban' | 'realm:join' | 'realm:manage' {
  return kind === 'removal' ? 'realm:ban' : initiatorAccountId === memberAccountId ? 'realm:join' : 'realm:manage';
}

/** Realm owners are identity grants, not membership rows. */
export class RealmMembershipRoleError extends Error {
  readonly code = 'realm_owner_membership';
  constructor() {
    super('Realm owners are identity grants');
    this.name = 'RealmMembershipRoleError';
  }
}

export type RealmMembershipDependencies = {
  pool: Pool;
  access: Access;
  clock?: () => Date;
  /** Session key ring shared with HTTP. Authorize denies when it is absent. */
  referenceKeys?: KeyRing;
  /** Restores the initiator of a sealed workflow at every step. Without it, sealed steps fail closed. */
  restorer?: InitiatorRestorer;
};

export type RealmMembership = RealmMembershipCommands & { roleReader: RealmRoleReader };

function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function asRow(value: unknown): Row | null {
  if (Array.isArray(value)) return asRow(value[0]);
  return value !== null && typeof value === 'object' ? (value as Row) : null;
}

function asRows(value: unknown): Row[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => (asRow(item) ? [asRow(item)!] : []));
  const row = asRow(value);
  return row ? [row] : [];
}

async function readOne(query: Promise<unknown>): Promise<Row | null> {
  try {
    return asRow(await query);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Expected exactly one row, got 0')) return null;
    const code = postgresCode(error);
    if (code === '23P01' || code === '23505') throw new GrantDeniedError();
    throw error;
  }
}

function text(row: Row | null, key: string): string | null {
  const value = row?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function flag(row: Row, key: string): boolean | null {
  const value = row[key];
  return typeof value === 'boolean' ? value : null;
}

function denyUnless(value: unknown): asserts value {
  if (!value) throw new GrantDeniedError();
}

function digest(identity: ReturnType<typeof principalCommandIdentity>, kind: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(canonicalize([identity, kind, body])!)
    .digest();
}

function realmRoute(realmId: string): number {
  const route = routeOf(realmId);
  denyUnless(route !== null);
  return route;
}

type LoadedOperation = Readonly<{
  record: DurableInitiatorRecord;
  kind: MembershipOperationKind;
  facts: MembershipOperationFacts;
}>;

/** The operation row is its own immutable source. Its creation receipt must commit
 * the whole record, so a copied row, source or transaction never reads back.
 */
async function loadOperation(client: AccessClient, operation: DurableOperationAnchor): Promise<LoadedOperation | null> {
  const kind = (Object.keys(MEMBERSHIP_OPERATION_COMMANDS) as MembershipOperationKind[]).find(
    (candidate) => MEMBERSHIP_OPERATION_COMMANDS[candidate] === operation.kind,
  );
  if (!kind || operation.sourceId !== operation.id || routeOf(operation.id) !== operation.route) return null;
  const row = await readOperationRow.run(client, { route: operation.route, operation_id: operation.id });
  if (
    !row ||
    row.member_account_id === null ||
    row.initiator_account_id === null ||
    row.actor_client_id === null ||
    row.actor_scopes === null ||
    row.actor_authn_epoch === null ||
    row.original_minimum_authn_epoch === null ||
    row.kind !== kind ||
    row.creation_command_kind !== operation.kind ||
    routeOf(row.realm_id) !== operation.route
  )
    return null;
  const receipt = await readOperationReceipt.run(client, {
    partition_no: partitionOf(operation.route),
    initiator_account_id: row.initiator_account_id,
    creation_command_kind: row.creation_command_kind,
    creation_idempotency_key: row.creation_idempotency_key,
  });
  if (
    !receipt ||
    receipt.receipt_transaction_id !== row.recorded_transaction_id ||
    receipt.receipt_request_digest !== row.creation_request_digest ||
    receipt.receipt_commitment === null
  )
    return null;
  const authnEpoch = Number(row.actor_authn_epoch);
  const scopes = row.actor_scopes;
  if (!Number.isSafeInteger(authnEpoch) || authnEpoch <= 0 || !scopes.every((scope): scope is string => scope !== null))
    return null;
  const facts: MembershipOperationFacts = {
    realmId: row.realm_id,
    spaceId: row.space_id,
    memberAccountId: row.member_account_id,
    reservationId: row.reservation_id,
    banId: row.ban_id,
  };
  const record: DurableInitiatorRecord = {
    operation: { route: row.route, id: row.operation_id, kind: row.creation_command_kind, sourceId: row.operation_id },
    initiatorAccountId: row.initiator_account_id,
    actor: {
      kind: 'account',
      accountId: row.initiator_account_id,
      clientId: row.actor_client_id,
      scopes,
      requestedBy: row.actor_requested_by,
      authnEpoch,
    },
    recordedTransactionId: row.recorded_transaction_id,
    sourceDigest: row.source_digest,
    originalAccount: {
      minimumAuthnEpoch: row.original_minimum_authn_epoch,
      operatorAccountId: row.original_operator_account_id,
    },
    originalDelegation:
      row.actor_requested_by === null
        ? null
        : {
            transactionId: row.original_delegation_transaction_id!,
            issuedValid: row.original_delegation_issued_valid!,
          },
    creation: {
      commandKind: row.creation_command_kind,
      idempotencyKey: row.creation_idempotency_key,
      requestDigest: row.creation_request_digest,
      target: { route: row.creation_target_route, id: row.creation_target_id },
    },
  };
  if (
    membershipSourceDigest(record.operation, record.creation.target, facts) !== record.sourceDigest ||
    durableInitiatorCommitment(record) !== receipt.receipt_commitment
  )
    return null;
  return { record, kind, facts };
}

/** Reads the committed operation and its creation receipt on the caller's connection. */
export const readMembershipInitiator: DurableInitiatorReader = async (client, operation) =>
  (await loadOperation(client, operation))?.record ?? null;

/** A sealed step's operation. The initiator names the receipt; it supplies no authority. */
type SealedOperation = Readonly<{
  anchor: DurableOperationAnchor;
  kind: MembershipOperationKind;
  facts: MembershipOperationFacts;
  initiator: Readonly<{ accountId: string; clientId: string; requestedBy: string | null }>;
}>;

/** Accounts owns the workflow. This adapter publishes and proves the Realm side. */
export function createRealmMembership(config: RealmMembershipDependencies) {
  const { pool, access } = config;
  const operations = new WeakMap<LifecycleRequest, SealedOperation>();

  async function authorize(reference: string, input: MembershipWorkInput): Promise<LifecycleRequest> {
    denyUnless(input.kind === 'membership' && input.principal.kind === 'realm');
    if (input.role === 'owner') throw new RealmMembershipRoleError();
    denyUnless(input.role === 'member' || input.role === null);
    const route = realmRoute(input.principal.id);
    denyUnless(routeOf(input.memberAccountId) !== null);
    denyUnless(input.reservationId === undefined || routeOf(input.reservationId) === routeOf(input.memberAccountId));
    const keys = config.referenceKeys;
    const payload = keys ? unseal(keys, REALM_MEMBERSHIP_SEAL_SCOPE, reference) : undefined;
    if (payload !== undefined) return authorizeSealed(payload, input);
    const context = { pool, deadline: deadlineFor(30_000) };
    const actor = await access.authenticate(reference, context);
    const accountRoute = routeOf(actor.accountId);
    denyUnless(accountRoute !== null);
    const account = await withConnection(pool, (client) => readAccount(client, accountRoute, actor.accountId));
    denyUnless(account);
    const request = { actor, account, deadline: context.deadline };
    denyUnless(input.role !== null || actor.accountId === input.memberAccountId);
    const action = actor.accountId === input.memberAccountId ? 'realm:join' : 'realm:manage';
    const check = await accessCheck(access, actor, action, { route, id: input.principal.id }, { ...request, pool });
    denyUnless(
      await withConnection(pool, async (client) => {
        const time = await mintReadTime(client, config.clock);
        if (
          input.role === 'member' &&
          (await currentBan.run(client, {
            route,
            realm_id: input.principal.id,
            account_id: input.memberAccountId,
            at: authoritativeTimeValue(time),
          }))
        )
          throw new GrantDeniedError();
        return check(client, time);
      }),
    );
    return request;
  }

  async function readTerminal(client: AccessClient, input: MembershipReservation) {
    if (input.principal.kind !== 'realm') return null;
    const route = routeOf(input.principal.id);
    if (route === null || routeOf(input.accountId) === null || routeOf(input.reservationId) === null) return null;
    const row = await readOne(
      readTerminalRow.run(client, {
        route,
        realm_id: input.principal.id,
        account_id: input.accountId,
        reservation_id: input.reservationId,
      }),
    );
    const transactionId = text(row, 'transactionId');
    if (!transactionId) return null;
    return {
      accountId: input.accountId,
      principal: { kind: 'realm' as const, id: input.principal.id },
      reservationId: input.reservationId,
      transactionId,
    };
  }

  async function readChange(client: AccessClient, input: MembershipBootstrapStep) {
    if (input.principal.kind !== 'realm') return null;
    const route = routeOf(input.principal.id);
    if (
      route === null ||
      routeOf(input.accountId) === null ||
      routeOf(input.sourceTransactionId) === null ||
      input.key.length === 0
    )
      return null;
    const row = await readOne(
      readChangeRow.run(client, {
        route,
        realm_id: input.principal.id,
        account_id: input.accountId,
        transaction_id: input.sourceTransactionId,
      }),
    );
    const reservationId = text(row, 'reservationId');
    if (!reservationId) return null;
    return {
      accountId: input.accountId,
      principal: { kind: 'realm' as const, id: input.principal.id },
      key: input.key,
      sourceTransactionId: input.sourceTransactionId,
      reservationId,
    };
  }

  const roleReader: RealmRoleReader = async (client, input) => {
    const route = routeOf(input.realmId);
    if (route === null || routeOf(input.accountId) === null) return null;
    let value: unknown;
    try {
      value = await readRoles.run(client, {
        route,
        realm_id: input.realmId,
        account_id: input.accountId,
        at: input.at,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Expected exactly one row, got 0')) return null;
      throw error;
    }
    const proofs: MembershipRoleProof[] = [];
    for (const row of asRows(value)) {
      const role = row.role === 'owner' || row.role === 'member' ? row.role : null;
      const member = flag(row, 'member');
      const valid = text(row, 'valid');
      if (!role || member === null || !valid) return null;
      proofs.push({ role, member, valid });
    }
    proofs.sort((left, right) => (left.role === right.role ? 0 : left.role === 'owner' ? -1 : 1));
    if (proofs.length !== 2 || proofs[0]?.role !== 'owner' || proofs[1]?.role !== 'member') return null;
    return proofs;
  };

  roleReader.batch = async (client, input) => {
    const pairs = input.pairs.map(({ realmId, accountId }) => ({
      route: routeOf(realmId),
      realm_id: realmId,
      account_id: accountId,
    }));
    if (pairs.some((pair) => pair.route === null || routeOf(pair.account_id) === null)) return null;
    if (!pairs.length) return [];
    const rows = await readRoleBatch.run(client, { at: input.at, pairs });
    const proofs: (MembershipRoleProof & { realmId: string; accountId: string })[] = [];
    for (const row of asRows(rows)) {
      const role = row.role === 'owner' || row.role === 'member' ? row.role : null;
      const member = flag(row, 'member');
      const valid = text(row, 'valid');
      const realmId = text(row, 'realmId');
      const accountId = text(row, 'accountId');
      if (!role || member === null || !valid || !realmId || !accountId) return null;
      proofs.push({ realmId, accountId, role, member, valid });
    }
    if (proofs.length !== pairs.length * 2) return null;
    return proofs;
  };

  /** A sealed reference names a committed operation. Nothing in it is an actor: the
   * returned request is only a carrier, and publish restores the initiator itself.
   */
  async function authorizeSealed(payload: unknown, input: MembershipWorkInput): Promise<LifecycleRequest> {
    const seal = membershipSeal(payload);
    if (!seal || input.kind !== 'membership' || input.principal.kind !== 'realm') throw new GrantDeniedError();
    const removal = seal.kind === 'removal';
    if (
      seal.realmId !== input.principal.id ||
      seal.memberAccountId !== input.memberAccountId ||
      seal.role !== input.role ||
      seal.reservationId !== input.reservationId ||
      (seal.kind === 'join') !== (input.role === 'member') ||
      removal !== (seal.removal !== undefined) ||
      (seal.kind === 'join' && seal.reservationId !== undefined) ||
      (seal.kind !== 'join' && seal.reservationId === undefined)
    )
      throw new GrantDeniedError();
    const realmRouteId = routeOf(seal.realmId);
    if (realmRouteId === null || routeOf(seal.spaceId) === null) throw new GrantDeniedError();
    const anchor: DurableOperationAnchor = {
      route: realmRouteId,
      id: seal.operationId,
      kind: MEMBERSHIP_OPERATION_COMMANDS[seal.kind],
      sourceId: seal.operationId,
    };
    const loaded = await withConnection(pool, (client) => loadOperation(client, anchor));
    if (
      !loaded ||
      loaded.kind !== seal.kind ||
      loaded.facts.realmId !== seal.realmId ||
      loaded.facts.spaceId !== seal.spaceId ||
      loaded.facts.memberAccountId !== seal.memberAccountId ||
      loaded.facts.reservationId !== (seal.reservationId ?? null) ||
      loaded.facts.banId !== (seal.removal ?? null)
    )
      throw new GrantDeniedError();
    const initiator = loaded.record.initiatorAccountId;
    const at = (config.clock ?? (() => new Date()))().toISOString();
    const realm = await withConnection(pool, (client) =>
      readOne(readRealmHead.run(client, { route: realmRouteId, id: seal.realmId, at })),
    );
    const visibility = text(realm, 'visibility');
    if (text(realm, 'space_id') !== seal.spaceId || (visibility !== 'public' && visibility !== 'protected'))
      throw new GrantDeniedError();
    if (seal.kind === 'join' && initiator === seal.memberAccountId && visibility !== 'public')
      throw new GrantDeniedError();
    if (seal.kind === 'leave' && initiator !== seal.memberAccountId) throw new GrantDeniedError();
    const request: LifecycleRequest = {
      // The committed snapshot, frozen for the carrier's type only. Access never authenticated it.
      actor: Object.freeze({ ...loaded.record.actor, scopes: Object.freeze([...loaded.record.actor.scopes]) }),
      deadline: deadlineFor(AUTHORIZE_DEADLINE_MS),
    };
    operations.set(request, {
      anchor,
      kind: seal.kind,
      facts: loaded.facts,
      initiator: {
        accountId: loaded.record.initiatorAccountId,
        clientId: loaded.record.actor.clientId,
        requestedBy: loaded.record.actor.requestedBy,
      },
    });
    return request;
  }

  /** Every attempt restores the initiator from the committed operation at its own T, then
   * authorizes that actor for the action on the Realm. A revoked, suspended, fenced or
   * consent-reduced initiator fails here, before the Realm record is touched.
   */
  function restoredAuthorization(
    operation: SealedOperation,
    action: string,
    target: Readonly<{ route: number; id: string }>,
    deadline: number,
  ): AccessCommandAuthorization {
    type Prepared = { current: AccessCommandAuthorization; proof: unknown };
    const denied = () => new GrantDeniedError();
    let active: AccessCommandAuthorization | undefined;
    const authorization: CommandAuthorization = {
      action,
      resource: target,
      denied,
      async prepare(attempt) {
        active = undefined;
        if (!config.restorer) throw new DurableInitiatorUnavailableError();
        const actor = await config.restorer.restoreInitiator(
          {
            operation: operation.anchor,
            action,
            anchor: {
              resource: target,
              async validate(client, time) {
                return (
                  text(
                    await readOne(
                      realmActive.run(client, { route: target.route, id: target.id, at: authoritativeTimeValue(time) }),
                    ),
                    'realmId',
                  ) === target.id
                );
              },
            },
            context: { pool, deadline },
          },
          attempt.time,
        );
        const current = await accessCommandAuthorization(access, actor, action, target, { pool, deadline }, denied);
        return { current, proof: await current.prepare!(attempt) } satisfies Prepared;
      },
      async authorize(tx, attempt, evidence) {
        const prepared = evidence as Prepared | undefined;
        if (!prepared) throw denied();
        active = prepared.current;
        return prepared.current.authorize(tx, attempt, prepared.proof);
      },
    };
    return { ...authorization, check: async (client, time) => (active ? active.check(client, time) : false) };
  }

  async function publish(
    request: LifecycleRequest,
    input: MembershipInput,
    reservation: MembershipReservation,
    key: string,
  ) {
    if (input.role === 'owner') throw new RealmMembershipRoleError();
    if (input.role !== 'member' && input.role !== null) throw new GrantDeniedError();
    const role = input.role;
    const realmId = input.principal.id;
    const route = realmRoute(realmId);
    denyUnless(input.kind === 'membership' && input.principal.kind === 'realm');
    denyUnless(reservation.accountId === input.memberAccountId);
    denyUnless(reservation.principal.kind === 'realm' && reservation.principal.id === realmId);
    denyUnless(input.reservationId === undefined || input.reservationId === reservation.reservationId);
    denyUnless(routeOf(input.memberAccountId) !== null);
    denyUnless(routeOf(reservation.reservationId) === routeOf(input.memberAccountId));
    denyUnless(Number.isFinite(request.deadline) && Date.now() < request.deadline);
    const target = { route, id: realmId };
    const operation = operations.get(request);
    let identity: PrincipalCommandIdentity;
    let authorization: AccessCommandAuthorization;
    if (operation) {
      denyUnless(
        operation.facts.realmId === realmId &&
          operation.facts.memberAccountId === input.memberAccountId &&
          (operation.kind === 'join'
            ? role === 'member'
            : role === null && operation.facts.reservationId === reservation.reservationId),
      );
      const action = membershipOperationAction(operation.kind, operation.initiator.accountId, input.memberAccountId);
      identity = Object.freeze({
        principal: Object.freeze({ kind: 'account' as const, id: operation.initiator.accountId }),
        basis: Object.freeze({ clientId: operation.initiator.clientId, requestedBy: operation.initiator.requestedBy }),
      });
      authorization = restoredAuthorization(operation, action, target, request.deadline);
    } else {
      // The authenticator's own actor, never a copy: Access knows no other object.
      const actor = request.actor;
      denyUnless(role !== null || actor.accountId === input.memberAccountId);
      const action = membershipOperationAction('join', actor.accountId, input.memberAccountId);
      identity = principalCommandIdentity(actor);
      authorization = await accessCommandAuthorization(
        access,
        actor,
        action,
        target,
        { ...request, pool },
        () => new GrantDeniedError(),
      );
    }
    const body = {
      realmId,
      memberAccountId: input.memberAccountId,
      reservationId: reservation.reservationId,
      role,
    };
    return runCommand(
      pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: request.deadline,
        clock: config.clock,
        receipt: { kind: MEMBERSHIP_KIND, key, digest: digest(identity, MEMBERSHIP_KIND, body) },
        authorization,
      },
      async (tx, command) => {
        denyUnless(await authorization.check(tx));
        const at = authoritativeTimeValue(command.time);
        const active = await readOne(realmActive.run(tx, { route, id: realmId, at }));
        denyUnless(text(active, 'realmId') === realmId);
        if (
          role === 'member' &&
          (await currentBan.run(tx, { route, realm_id: realmId, account_id: input.memberAccountId, at }))
        )
          throw new GrantDeniedError();
        const written = await writeMembership(tx, {
          route,
          realmId,
          accountId: input.memberAccountId,
          reservationId: reservation.reservationId,
          role,
          at,
          transactionId: command.transactionId,
        });
        denyUnless(written);
        if (role === 'member') await ensureRealmMemberGrant(tx, { realmId });
        denyUnless(await authorization.check(tx));
        const value = {
          realmId,
          accountId: input.memberAccountId,
          reservationId: reservation.reservationId,
          role,
          at,
          transactionId: command.transactionId,
        };
        return {
          value,
          events: [{ type: 'com.rezics.community.realm.membership.v1', subject: realmId, data: value }],
        };
      },
    );
  }

  async function terminalize(reservation: MembershipReservation, key: string) {
    denyUnless(reservation.principal.kind === 'realm');
    const realmId = reservation.principal.id;
    const route = realmRoute(realmId);
    denyUnless(routeOf(reservation.accountId) !== null);
    denyUnless(routeOf(reservation.reservationId) === routeOf(reservation.accountId));
    const actor = {
      kind: 'account' as const,
      accountId: reservation.accountId,
      clientId: CLIENT_ID,
      scopes: [] as string[],
      requestedBy: null,
      authnEpoch: 1,
    };
    const body = { realmId, accountId: reservation.accountId, reservationId: reservation.reservationId };
    const identity = principalCommandIdentity(actor);
    return runCommand(
      pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: Date.now() + 30_000,
        clock: config.clock,
        receipt: { kind: TERMINAL_KIND, key, digest: digest(identity, TERMINAL_KIND, body) },
      },
      async (tx, command) => {
        const at = authoritativeTimeValue(command.time);
        const written = await readOne(
          writeTerminal.run(tx, {
            route,
            realm_id: realmId,
            account_id: reservation.accountId,
            reservation_id: reservation.reservationId,
            at,
            transaction_id: command.transactionId,
          }),
        );
        denyUnless(text(written, 'reservationId') === reservation.reservationId);
        const value = {
          realmId,
          accountId: reservation.accountId,
          reservationId: reservation.reservationId,
          transactionId: command.transactionId,
          at,
        };
        return {
          value,
          events: [{ type: 'com.rezics.community.realm.membership.terminalized.v1', subject: realmId, data: value }],
        };
      },
    );
  }

  return {
    authority: { readTerminal, readChange },
    authorize,
    publish,
    terminalize,
    roleReader,
  } satisfies RealmMembership;
}

/** The request's facts and the committed operation that holds its initiator. No actor field exists. */
type MembershipSeal = {
  operationId: string;
  kind: MembershipOperationKind;
  realmId: string;
  spaceId: string;
  memberAccountId: string;
  role: 'member' | null;
  reservationId: string | undefined;
  removal: string | undefined;
};

function membershipSeal(value: unknown): MembershipSeal | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    'operationId',
    'kind',
    'realmId',
    'spaceId',
    'memberAccountId',
    'role',
    'reservationId',
    'removal',
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) return null;
  const { operationId, kind, realmId, spaceId, memberAccountId, reservationId, removal } = row;
  if (
    typeof operationId !== 'string' ||
    routeOf(operationId) === null ||
    (kind !== 'join' && kind !== 'leave' && kind !== 'removal') ||
    typeof realmId !== 'string' ||
    routeOf(realmId) === null ||
    typeof spaceId !== 'string' ||
    routeOf(spaceId) === null ||
    typeof memberAccountId !== 'string' ||
    routeOf(memberAccountId) === null ||
    (row.role !== 'member' && row.role !== null)
  )
    return null;
  if (reservationId !== undefined && (typeof reservationId !== 'string' || routeOf(reservationId) === null))
    return null;
  if (removal !== undefined && (typeof removal !== 'string' || routeOf(removal) === null)) return null;
  return {
    operationId,
    kind,
    realmId,
    spaceId,
    memberAccountId,
    role: row.role,
    reservationId,
    removal,
  };
}

/** One point read of the account's open Realm interval. No member scan. */
export async function readRealmMembershipInterval(
  pool: Pool,
  realmId: string,
  accountId: string,
  at: string,
): Promise<{ since: string; reservationId: string } | null> {
  const route = routeOf(realmId);
  if (route === null || routeOf(accountId) === null || !Number.isFinite(Date.parse(at))) return null;
  const row = await withConnection(pool, (client) =>
    readOne(readCurrent.run(client, { route, realm_id: realmId, account_id: accountId, at })),
  );
  const reservationId = text(row, 'reservationId');
  const since = row?.since;
  if (!reservationId || (typeof since !== 'string' && !(since instanceof Date))) return null;
  const parsed = since instanceof Date ? since : new Date(since);
  if (!Number.isFinite(parsed.getTime())) return null;
  return { since: parsed.toISOString(), reservationId };
}

async function writeMembership(
  tx: CommandTransaction,
  input: {
    route: number;
    realmId: string;
    accountId: string;
    reservationId: string;
    role: 'member' | null;
    at: string;
    transactionId: string;
  },
) {
  const parameters = {
    route: input.route,
    realm_id: input.realmId,
    account_id: input.accountId,
    reservation_id: input.reservationId,
    at: input.at,
    transaction_id: input.transactionId,
  };
  const written = await readOne(
    input.role === null ? closeMembership.run(tx, parameters) : openMembership.run(tx, parameters),
  );
  return text(written, 'reservationId') === input.reservationId;
}
