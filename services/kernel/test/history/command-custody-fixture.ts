import { expect } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { createPreferenceCommands } from '../../src/access/preferences.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { principalCommandIdentity, runCommand, noEffect, type CommandTransaction } from '../../src/command/command.ts';
import { configureReceiptKeys, encodeReceiptKey, receiptKeysFor } from '../../src/command/receipt-key.ts';
import { declareCommandHistory, type CommandHistoryScopes } from '../../src/history/record.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { nativeFixture, scopes } from '../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';

export const kind = 'access.account.preferences';
export const digest = Buffer.alloc(32, 81);
export type Person = { accountId: string; bearer: string };
export async function custodyFixture() {
  for (const scope of ['account:read', 'account:update', 'account:delete'])
    if (!scopes.includes(scope)) scopes.push(scope);
  const db = await openGrowthDatabase();
  const auth = await nativeFixture(db.pool);
  // Keep the fixture's retained version, and exercise the actual native codec at version zero.
  configureReceiptKeys(db.pool, {
    current: 0,
    keys: new Map([[0, Buffer.alloc(32, 80)], ...receiptKeysFor(db.pool).keys]),
  });
  const preferences = createPreferenceCommands({ pool: db.pool, access: auth.access, clock: () => new Date() });
  async function context(person: Person, partition = partitionOf(routeOf(person.accountId)!)) {
    const context = { pool: db.pool, deadline: Date.now() + 30_000 };
    const actor = await auth.access.authenticate(person.bearer, context);
    const authorization = resourceAuthorization({
      access: auth.access,
      actor,
      action: 'account:update',
      anchor: { resource: { route: routeOf(person.accountId)!, id: person.accountId }, validate: async () => true },
      context: { ...context, partition },
    });
    return { ...context, actor, authorization, partition };
  }
  async function command(
    person: Person,
    key: string,
    declaration: CommandHistoryScopes,
    body: (tx: CommandTransaction) => Promise<unknown> = async () => undefined,
    partition = partitionOf(routeOf(person.accountId)!),
  ) {
    const ctx = await context(person, partition);
    return runCommand(
      db.pool,
      {
        ...principalCommandIdentity(ctx.actor),
        partition,
        deadline: ctx.deadline,
        authorization: ctx.authorization,
        receipt: { kind, key, digest },
      },
      async (tx) => {
        await declareCommandHistory(tx, kind, declaration);
        await body(tx);
        return noEffect({ shelf: { layouts: { 'urn:custody:private': 'table' } }, version: 0 });
      },
    );
  }
  async function stored(person: Person, key: string, partition = partitionOf(routeOf(person.accountId)!)) {
    const token = encodeReceiptKey(receiptKeysFor(db.pool), kind, { kind: 'account', id: person.accountId }, key);
    return readOnly(
      db.admin,
      async (client) =>
        (
          await client.query(
            `SELECT * FROM core.receipt
      WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
            [partition, person.accountId, kind, token],
          )
        ).rows[0],
    );
  }
  return {
    db,
    auth,
    preferences,
    context,
    command,
    stored,
    async close() {
      try {
        await auth.close();
      } finally {
        await db.close();
      }
    },
  };
}
export type CustodyFixture = Awaited<ReturnType<typeof custodyFixture>>;
export function scope(person: Pick<Person, 'accountId'>, visit?: () => void): CommandHistoryScopes {
  return {
    response: {
      artifactType: 'command-receipt/v1',
      accounts: [
        {
          get accountId() {
            visit?.();
            return person.accountId;
          },
          accountRoute: routeOf(person.accountId)!,
          roles: 32,
        },
      ],
    },
    events: [],
  };
}
export async function readOnly<T>(pool: Pool, read: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const value = await read(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
export async function waitForLock(pool: Pool, blocked: number, blocker: number) {
  // The database's lock dependency is the ordering proof, not elapsed time.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const result = await pool.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked', [blocked, blocker]);
    if (result.rows[0].blocked) return;
  }
  expect.unreachable('The competing native transaction never reached its guard lock');
}
