import type { Pool } from 'pg';
import { mintReadTime, authoritativeTimeValue } from '../command/command.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { accessCheck, type Access, type AccessRealmRoleReader, type Actor } from './check.ts';
import { AccessUnavailableError, throwAccessUnavailable } from './unavailable.ts';
import { routeOf } from '../route/route.ts';
import { realmReadEligibility } from '../community/access-capabilities.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import publicRealmsRead from './account-public-realms-read.sql';
import pageRead from './account-realms-page.sql';

const ROUTE = 'GET /v1/accounts/:accountId/realms';
const START_AFTER = '00000000-0000-0000-0000-000000000000';
const UNCERTAIN_READ_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

function uncertainReadIO(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return (
    (typeof code === 'string' && (code.startsWith('08') || UNCERTAIN_READ_CODES.has(code))) ||
    (error instanceof Error &&
      /connection (?:acquisition )?timeout|timeout exceeded when trying to connect|connection (?:terminated|reset)|socket hang up|write after end/i.test(
        error.message,
      ))
  );
}

function boundedReadOptions(deadline: number) {
  return {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError: (error: unknown) => {
      try {
        throwAccessUnavailable(error, deadline);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: uncertainReadIO,
    isUncertainSettledQueryError: uncertainReadIO,
    isUncertainWorkError: uncertainReadIO,
  };
}

export type AccountRealmsPage = {
  realms: { id: string; role: 'owner' | 'member' }[];
  next: string | null;
};

export type AccountRealmsDependencies = {
  pool: Pool;
  tokens: KeyRing;
  access: Access;
  realmRoleReader: AccessRealmRoleReader;
};

function cursorBinding(accountId: string, actor: Actor, limit: number): ListCursorBinding {
  return {
    route: ROUTE,
    viewer: actor.kind === 'account' ? actor.accountId : null,
    query: { accountId, limit },
  };
}

function confirmedRole(proofs: Awaited<ReturnType<AccessRealmRoleReader>>): 'owner' | 'member' | null {
  if (!proofs || proofs.length !== 2) return null;
  const byRole = new Map<string, (typeof proofs)[number]>();
  for (const proof of proofs) {
    if (
      (proof.role !== 'owner' && proof.role !== 'member') ||
      typeof proof.member !== 'boolean' ||
      typeof proof.valid !== 'string' ||
      !proof.valid
    )
      return null;
    byRole.set(proof.role, proof);
  }
  if (byRole.size !== 2 || !byRole.has('owner') || !byRole.has('member')) return null;
  if (byRole.get('owner')!.member) return 'owner';
  return byRole.get('member')!.member ? 'member' : null;
}

/** A bounded public page over the account's inverse, with independent live Realm checks. */
export async function readAccountRealms(
  dependencies: AccountRealmsDependencies,
  actor: Actor,
  accountId: string,
  at: Date,
  deadline: number,
  input: { limit?: number; cursor?: string },
): Promise<AccountRealmsPage> {
  const empty: AccountRealmsPage = { realms: [], next: null };
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) throw new ProblemError('not_found');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');

  const readOptions = boundedReadOptions(deadline);
  const view = await withBoundedReadConnection(dependencies.pool, deadline, (client) =>
    publicRealmsRead.run(client, { route: accountRoute, account_id: accountId }),
    readOptions,
  );
  if (!view?.enabled) return empty;

  const binding = cursorBinding(accountId, actor, limit);
  let after = START_AFTER;
  if (input.cursor !== undefined) {
    const decoded = await decodeListCursor(dependencies.tokens, binding, input.cursor, at);
    if (
      !decoded.ok ||
      decoded.epoch !== 1 ||
      decoded.after.length !== 1 ||
      typeof decoded.after[0] !== 'string' ||
      routeOf(decoded.after[0]) === null
    )
      throw new ProblemError('invalid_cursor');
    after = decoded.after[0];
  }

  const atTime = await withBoundedReadConnection(
    dependencies.pool,
    deadline,
    (client) => mintReadTime(client, () => at),
    readOptions,
  );
  const authoritativeAt = authoritativeTimeValue(atTime);
  const rows = await withBoundedReadConnection(
    dependencies.pool,
    deadline,
    (client) =>
      pageRead.run(client, {
        route: accountRoute,
        account_id: accountId,
        after,
        limit: limit + 1,
      }),
    readOptions,
  );
  const realms: AccountRealmsPage['realms'] = [];
  let scanned = 0;
  let lastScanned: string | undefined;

  for (const row of rows) {
    if (realms.length >= limit) break;
    const realmRoute = routeOf(row.id);
    lastScanned = row.id;
    scanned += 1;
    if (realmRoute === null) continue;

    const role = confirmedRole(
      await withBoundedReadConnection(
        dependencies.pool,
        deadline,
        (client) => dependencies.realmRoleReader(client, { realmId: row.id, accountId, at: authoritativeAt }),
        readOptions,
      ),
    );
    if (role === null) continue;

    const resource = {
      route: realmRoute,
      id: row.id,
      eligibility: realmReadEligibility({ route: realmRoute, id: row.id }),
    };
    const check = await accessCheck(dependencies.access, actor, 'realm:read', resource, {
      pool: dependencies.pool,
      deadline,
    });
    const allowed = await withBoundedReadConnection(
      dependencies.pool,
      deadline,
      (client) => check(client, atTime),
      readOptions,
    );
    if (allowed) realms.push({ id: row.id, role });
  }

  const hasMore = scanned < rows.length || rows.length > limit;
  const next =
    hasMore && lastScanned
      ? await encodeListCursor(dependencies.tokens, binding, { epoch: 1, after: [lastScanned] }, at)
      : null;
  return { realms, next };
}
