import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { MembershipWorkInput } from '@rezics/auth/membership-workflows';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { LifecycleRequest } from '../access/lifecycle.ts';
import type { MembershipBootstrapStep, MembershipReservation } from '../access/membership-inverse.ts';
import type { RealmMembershipCommands } from '../access/membership-work.ts';
import type { MembershipRoleProof, RealmRoleReader } from '../access/permission.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { accessCheck, accessCommandAuthorization, type Access, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import realmActive from './membership-realm.sql';
import openMembership from './membership-open.sql';
import closeMembership from './membership-close.sql';
import writeTerminal from './membership-terminal.sql';
import readTerminalRow from './membership-read-terminal.sql';
import readChangeRow from './membership-read-change.sql';
import readRoles from './membership-role.sql';

type MembershipInput = Extract<MembershipWorkInput, { kind: 'membership' }>;
type Row = Record<string, unknown>;
const MEMBERSHIP_KIND = 'community.realm.membership';
const TERMINAL_KIND = 'community.realm.membership.terminal';
const CLIENT_ID = 'realm-membership';

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

/** Accounts owns the workflow. This adapter publishes and proves the Realm side. */
export function createRealmMembership(config: RealmMembershipDependencies) {
  const { pool, access } = config;

  async function authorize(reference: string, input: MembershipWorkInput): Promise<LifecycleRequest> {
    denyUnless(input.kind === 'membership' && input.principal.kind === 'realm');
    if (input.role === 'owner') throw new RealmMembershipRoleError();
    denyUnless(input.role === 'member' || input.role === null);
    const route = realmRoute(input.principal.id);
    denyUnless(routeOf(input.memberAccountId) !== null);
    denyUnless(input.reservationId === undefined || routeOf(input.reservationId) === routeOf(input.memberAccountId));
    const context = { pool, deadline: Date.now() + 30_000 };
    const actor = await access.authenticate(reference, context);
    const accountRoute = routeOf(actor.accountId);
    denyUnless(accountRoute !== null);
    const account = await withConnection(pool, (client) => readAccount(client, accountRoute, actor.accountId));
    denyUnless(account);
    const request = { actor, account, deadline: context.deadline };
    const action = actor.accountId === input.memberAccountId ? 'realm:join' : 'realm:manage';
    const check = await accessCheck(access, actor, action, { route, id: input.principal.id }, { ...request, pool });
    denyUnless(await withConnection(pool, (client) => check(client)));
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

  async function publish(
    request: LifecycleRequest,
    input: MembershipInput,
    reservation: MembershipReservation,
    key: string,
  ) {
    if (input.role === 'owner') throw new RealmMembershipRoleError();
    if (input.role !== 'member' && input.role !== null) throw new GrantDeniedError();
    const role = input.role;
    const actor = {
      kind: 'account' as const,
      accountId: request.actor.accountId,
      clientId: request.actor.clientId,
      scopes: [...request.actor.scopes],
      requestedBy: request.actor.requestedBy,
      authnEpoch: request.actor.authnEpoch,
    };
    const realmId = input.principal.id;
    const route = realmRoute(realmId);
    denyUnless(input.kind === 'membership' && input.principal.kind === 'realm');
    denyUnless(reservation.accountId === input.memberAccountId);
    denyUnless(reservation.principal.kind === 'realm' && reservation.principal.id === realmId);
    denyUnless(input.reservationId === undefined || input.reservationId === reservation.reservationId);
    denyUnless(routeOf(input.memberAccountId) !== null);
    denyUnless(routeOf(reservation.reservationId) === routeOf(input.memberAccountId));
    denyUnless(Number.isFinite(request.deadline) && Date.now() < request.deadline);
    const action = actor.accountId === input.memberAccountId ? 'realm:join' : 'realm:manage';
    const commandContext = { ...request, actor, pool };
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      action,
      { route, id: realmId },
      commandContext,
      () => new GrantDeniedError(),
    );
    const body = {
      realmId,
      memberAccountId: input.memberAccountId,
      reservationId: reservation.reservationId,
      role,
    };
    const identity = principalCommandIdentity(actor);
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
