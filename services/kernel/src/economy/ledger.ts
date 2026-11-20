import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  isEconomyBookId,
  type EconomyAsset,
  type EconomyFailure,
  type EconomyLedger,
  type EconomyReceipt,
  type EconomyResult,
  type WalletEntry,
} from './contract.ts';

const issuerAccount = '00000000-0000-0000-0000-000000000000';
const maxInteger = 9223372036854775807n;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const operationKey = /^[\x20-\x7e]{1,255}$/;

type Query = Pick<PoolClient, 'query'>;
export interface EconomyDatabase {
  transaction<T>(work: (client: Query) => Promise<EconomyResult<T>>): Promise<EconomyResult<T>>;
  read<T>(work: (client: Query) => Promise<EconomyResult<T>>): Promise<EconomyResult<T>>;
}
type WalletKey = Parameters<EconomyLedger['readBalance']>[0];
type Command = Parameters<EconomyLedger['release']>[0];
type Operation = Omit<Command, 'holdId'>;
type Kind = WalletEntry['kind'];
type Position = Readonly<{ accountId: string; posted: string; held: string; restricted: string; revision: string }>;
type Delta = Readonly<{ position: Position; posted: bigint; held: bigint }>;
type Hold = Readonly<{ remaining: string; expiresAt: Date }>;
type Context = Readonly<{ client: Query; bookId: string; asset: EconomyAsset; accountId: string }>;
type Namespace = 'wallet' | 'owner';
type Plan = Readonly<{
  deltas: readonly Delta[];
  at: Date;
  persistHold?: (transactionId: string) => Promise<unknown>;
}>;
type BusinessFailure = Readonly<{ kind: Exclude<EconomyFailure, 'unavailable'> }>;
type Outcome = 'ok' | BusinessFailure['kind'];

function success<T>(value: T): EconomyResult<T> {
  return { kind: 'ok', value };
}

function failure<K extends EconomyFailure>(kind: K): Readonly<{ kind: K }> {
  return { kind };
}

function walletAccount(value: string): string | null {
  return typeof value === 'string' && uuid.test(value) && value !== issuerAccount ? value.toLowerCase() : null;
}

function validIdentifier(value: string): boolean {
  return typeof value === 'string' && identifier.test(value);
}

function validOperationKey(value: string): boolean {
  return typeof value === 'string' && operationKey.test(value);
}

function positiveInteger(value: string): bigint | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  const units = BigInt(value);
  return units <= maxInteger ? units : null;
}

function expiryDate(value: string): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  const [seconds, fraction = ''] = value.slice(0, -1).split('.');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${seconds}.${fraction.padEnd(3, '0')}Z`
    ? parsed
    : null;
}

function available(position: Position): bigint {
  return BigInt(position.posted) - BigInt(position.held) - BigInt(position.restricted);
}

async function getAsset(client: Query, bookId: string, assetId: string): Promise<EconomyAsset | undefined> {
  const result = await client.query<EconomyAsset>(
    'SELECT asset_id AS id, scale, transferable FROM economy.asset WHERE book_id = $1 AND asset_id = $2',
    [bookId, assetId],
  );
  return result.rows[0];
}

async function getTime(client: Query): Promise<Date> {
  const result = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at');
  return result.rows[0]!.at;
}

function positions(context: Context): Promise<readonly [Position]>;
function positions(context: Context, related: string): Promise<readonly [Position, Position]>;
async function positions(
  context: Context,
  related?: string,
): Promise<readonly [Position] | readonly [Position, Position]> {
  const { client, bookId, asset, accountId } = context;
  const keys = related === undefined ? [accountId] : [accountId, related];
  await client.query(
    `INSERT INTO economy.position (book_id, asset_id, account_id)
     SELECT $1, $2, account_id FROM unnest($3::uuid[]) AS keys(account_id) ORDER BY account_id
     ON CONFLICT DO NOTHING`,
    [bookId, asset.id, keys],
  );
  const result = await client.query<Position>(
    `SELECT account_id::text AS "accountId", posted::text, held::text, restricted::text, revision::text
     FROM economy.position
     WHERE book_id = $1 AND asset_id = $2 AND account_id = ANY($3::uuid[])
     ORDER BY account_id FOR UPDATE`,
    [bookId, asset.id, keys],
  );
  const own = result.rows.find((position) => position.accountId === accountId);
  if (own === undefined || result.rows.length !== keys.length) throw new Error('Economy account position is missing');
  if (related === undefined) return [own];
  return [own, result.rows.find((position) => position.accountId === related)!];
}

function delta(position: Position, posted: bigint, held = 0n): Delta {
  return { position, posted, held };
}

function validPlan({ deltas }: Plan): boolean {
  if (deltas.reduce((balance, change) => balance + change.posted, 0n) !== 0n)
    throw new Error('Economy posting group does not balance');
  for (const change of deltas) {
    const posted = BigInt(change.position.posted) + change.posted;
    const held = BigInt(change.position.held) + change.held;
    if (
      posted < -maxInteger ||
      posted > maxInteger ||
      held > maxInteger ||
      BigInt(change.position.revision) === maxInteger
    )
      return false;
    if (
      change.position.accountId !== issuerAccount &&
      (held < 0n || posted < held + BigInt(change.position.restricted))
    )
      throw new Error('Economy posting group violates position invariants');
  }
  return true;
}

async function record(
  context: Context,
  namespace: Namespace,
  key: string,
  kind: Kind,
  holdId: string | null,
  plan: Plan,
): Promise<void> {
  const { client, bookId, asset, accountId } = context;
  const transactionId = randomUUID();
  await client.query(
    `INSERT INTO economy.journal (book_id, asset_id, origin_id, namespace, operation_id, transaction_id, kind, hold_id, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [bookId, asset.id, accountId, namespace, key, transactionId, kind, holdId, plan.at],
  );
  for (const { position, posted, held } of plan.deltas) {
    await client.query(
      `WITH bumped AS (
         UPDATE economy.position
         SET posted = posted + $4::bigint, held = held + $5::bigint, revision = revision + 1
         WHERE book_id = $1 AND asset_id = $2 AND account_id = $3
         RETURNING revision
       )
       INSERT INTO economy.entry (book_id, asset_id, account_id, position, transaction_id, posted_delta, held_delta)
       SELECT $1, $2, $3, revision, $6, $4, $5 FROM bumped`,
      [bookId, asset.id, position.accountId, posted.toString(), held.toString(), transactionId],
    );
  }
  await plan.persistHold?.(transactionId);
}

async function getHold(context: Context, id: string, lock: boolean): Promise<Hold | undefined> {
  const result = await context.client.query<Hold>(
    `SELECT remaining::text, expires_at AS "expiresAt" FROM economy.hold
     WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4${lock ? ' FOR UPDATE' : ''}`,
    [context.bookId, context.asset.id, context.accountId, id],
  );
  return result.rows[0];
}

function changeHold(
  context: Context,
  id: string,
  at: Date,
  remaining: bigint,
  captured: bigint,
  released: bigint,
): Promise<unknown> {
  return context.client.query(
    `UPDATE economy.hold
     SET remaining = $5, captured = captured + $6::bigint, released = released + $7::bigint,
         closed_at = CASE WHEN $5::bigint = 0 THEN $8::timestamptz ELSE NULL END
     WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4`,
    [
      context.bookId,
      context.asset.id,
      context.accountId,
      id,
      remaining.toString(),
      captured.toString(),
      released.toString(),
      at,
    ],
  );
}

export function createEconomyLedger(database: EconomyDatabase, bookId: string): EconomyLedger {
  if (!isEconomyBookId(bookId)) throw new TypeError('Invalid Economy book ID');

  function command(
    input: Operation,
    kind: Kind,
    holdId: string | null,
    operands: readonly (string | boolean)[],
    prepare: (context: Context) => Promise<Plan | BusinessFailure>,
  ): Promise<EconomyResult<EconomyReceipt>> {
    const accountId = walletAccount(input.accountId);
    if (
      accountId === null ||
      !validIdentifier(input.assetId) ||
      !validOperationKey(input.operationId) ||
      (holdId !== null && !validOperationKey(holdId))
    )
      return Promise.resolve(failure('invalid_operation'));
    const { assetId, operationId } = input;
    // User-chosen transfer keys cannot claim an issuance or reserve chosen by a trusted owner.
    const namespace = kind === 'transfer' ? 'wallet' : 'owner';
    const digest = createHash('sha256')
      .update(JSON.stringify([1, kind, assetId, holdId, ...operands]))
      .digest();
    return database.transaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, $2::text, $3::text, $4::text)::text, 0))`,
        [bookId, accountId, namespace, operationId],
      );
      const existing = await client.query<{ digest: Buffer; outcome: Outcome }>(
        `SELECT digest, outcome FROM economy.command_receipt
         WHERE book_id = $1 AND origin_id = $2 AND namespace = $3 AND operation_id = $4`,
        [bookId, accountId, namespace, operationId],
      );
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (!digest.equals(prior.digest)) return failure('operation_conflict');
        return prior.outcome === 'ok' ? success({ operationId }) : failure(prior.outcome);
      }
      const saveOutcome = (outcome: Outcome) =>
        client.query(
          `INSERT INTO economy.command_receipt (book_id, origin_id, namespace, operation_id, digest, outcome)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [bookId, accountId, namespace, operationId, digest, outcome],
        );
      const asset = await getAsset(client, bookId, assetId);
      if (asset === undefined) {
        await saveOutcome('asset_missing');
        return failure('asset_missing');
      }
      const context = { client, bookId, asset, accountId };
      // Position creation can be provisional. Keep the operation lock while undoing a rejected attempt.
      await client.query('SAVEPOINT economy_business');
      const plan = await prepare(context);
      if ('kind' in plan || !validPlan(plan)) {
        const rejected = 'kind' in plan ? plan : failure('invalid_amount');
        await client.query('ROLLBACK TO SAVEPOINT economy_business');
        await saveOutcome(rejected.kind);
        return rejected;
      }
      await saveOutcome('ok');
      await record(context, namespace, operationId, kind, holdId, plan);
      return success({ operationId });
    });
  }

  function dropHold(input: Command, kind: 'release' | 'expire'): Promise<EconomyResult<EconomyReceipt>> {
    const { holdId } = input;
    return command(input, kind, holdId, [], async (context) => {
      const hold = await getHold(context, holdId, true);
      if (hold === undefined) return failure('hold_missing');
      const released = BigInt(hold.remaining);
      if (released === 0n) return failure('hold_closed');
      const [owner] = await positions(context);
      const at = await getTime(context.client);
      if (kind === 'expire' && hold.expiresAt > at) return failure('invalid_operation');
      return {
        at,
        deltas: [delta(owner, 0n, -released)],
        persistHold: () => changeHold(context, holdId, at, 0n, 0n, released),
      };
    });
  }

  return {
    provisionAsset(input) {
      const { id, scale, transferable } = input;
      if (
        !validIdentifier(id) ||
        !Number.isInteger(scale) ||
        scale < 0 ||
        scale > 18 ||
        typeof transferable !== 'boolean'
      )
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (client) => {
        await client.query(
          'INSERT INTO economy.asset (book_id, asset_id, scale, transferable) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [bookId, id, scale, transferable],
        );
        const asset = await getAsset(client, bookId, id);
        if (asset === undefined) throw new Error('Provisioned Economy asset is missing');
        return asset.scale === scale && asset.transferable === transferable
          ? success(asset)
          : failure('operation_conflict');
      });
    },

    readBalance(input) {
      const accountId = walletAccount(input.accountId);
      const { assetId } = input;
      if (accountId === null || !validIdentifier(assetId)) return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        const result = await client.query<EconomyAsset & Position>(
          `SELECT asset.asset_id AS id, asset.scale, asset.transferable, $3::uuid::text AS "accountId",
                  COALESCE(position.posted, 0)::text AS posted, COALESCE(position.held, 0)::text AS held,
                  COALESCE(position.restricted, 0)::text AS restricted, COALESCE(position.revision, 0)::text AS revision
           FROM economy.asset AS asset
           LEFT JOIN economy.position AS position
             ON position.book_id = asset.book_id AND position.asset_id = asset.asset_id AND position.account_id = $3
           WHERE asset.book_id = $1 AND asset.asset_id = $2`,
          [bookId, assetId, accountId],
        );
        const row = result.rows[0];
        if (row === undefined) return failure('asset_missing');
        const { id, scale, transferable, posted, held, restricted } = row;
        return success({
          asset: { id, scale, transferable },
          posted,
          held,
          restricted,
          available: available(row).toString(),
        });
      });
    },

    readStatement(input: WalletKey & { before?: string; limit: number }) {
      const accountId = walletAccount(input.accountId);
      const { before = null, limit, assetId } = input;
      if (
        accountId === null ||
        !validIdentifier(assetId) ||
        (before !== null && positiveInteger(before) === null) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        if ((await getAsset(client, bookId, assetId)) === undefined) return failure('asset_missing');
        const cutoff = before === null ? maxInteger : BigInt(before) - 1n;
        const result = await client.query<Omit<WalletEntry, 'recordedAt'> & { recordedAt: Date }>(
          `SELECT e.position::text,
                  CASE WHEN j.namespace = 'wallet' AND j.origin_id = e.account_id THEN j.operation_id
                       ELSE j.transaction_id::text END AS "operationId",
                  j.kind, e.posted_delta::text AS "postedDelta",
                  e.held_delta::text AS "heldDelta", j.recorded_at AS "recordedAt"
           FROM economy.entry AS e
           JOIN economy.journal AS j ON j.book_id = e.book_id AND j.asset_id = e.asset_id AND j.transaction_id = e.transaction_id
           WHERE e.book_id = $1 AND e.asset_id = $2 AND e.account_id = $3
             AND e.position <= $4::bigint
           ORDER BY e.position DESC LIMIT $5`,
          [bookId, assetId, accountId, cutoff.toString(), limit + 1],
        );
        const entries = result.rows
          .slice(0, limit)
          .map((row) => ({ ...row, recordedAt: row.recordedAt.toISOString() }));
        return success({ entries, next: result.rows.length > limit ? entries[entries.length - 1]!.position : null });
      });
    },

    issue(input) {
      const amount = positiveInteger(input.amount);
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      return command(input, 'issue', null, [input.amount], async (context) => {
        const [owner, issuer] = await positions(context, issuerAccount);
        return { at: await getTime(context.client), deltas: [delta(issuer, -amount), delta(owner, amount)] };
      });
    },

    transfer(input) {
      const amount = positiveInteger(input.amount);
      const recipient = walletAccount(input.recipientId);
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (recipient === null || recipient === walletAccount(input.accountId))
        return Promise.resolve(failure('invalid_operation'));
      return command(input, 'transfer', null, [recipient, input.amount], async (context) => {
        if (!context.asset.transferable) return failure('asset_not_transferable');
        const [sender, receiver] = await positions(context, recipient);
        if (available(sender) < amount) return failure('insufficient_funds');
        return { at: await getTime(context.client), deltas: [delta(sender, -amount), delta(receiver, amount)] };
      });
    },

    reserve(input) {
      const amount = positiveInteger(input.amount);
      const expiry = expiryDate(input.expiresAt);
      const { holdId } = input;
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (expiry === null) return Promise.resolve(failure('invalid_operation'));
      return command(input, 'reserve', holdId, [amount.toString(), expiry.toISOString()], async (context) => {
        const [owner] = await positions(context);
        if ((await getHold(context, holdId, false)) !== undefined) return failure('operation_conflict');
        const at = await getTime(context.client);
        if (expiry <= at) return failure('invalid_operation');
        if (available(owner) < amount) return failure('insufficient_funds');
        return {
          at,
          deltas: [delta(owner, 0n, amount)],
          persistHold: (transactionId) =>
            context.client.query(
              `INSERT INTO economy.hold (book_id, asset_id, account_id, hold_id, reserve_transaction_id, original, remaining, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
              [bookId, context.asset.id, context.accountId, holdId, transactionId, amount.toString(), expiry],
            ),
        };
      });
    },

    capture(input) {
      const amount = positiveInteger(input.amount);
      const recipient = walletAccount(input.recipientId);
      const { holdId, final } = input;
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (recipient === null || recipient === walletAccount(input.accountId) || typeof final !== 'boolean')
        return Promise.resolve(failure('invalid_operation'));
      return command(input, 'capture', holdId, [recipient, amount.toString(), final], async (context) => {
        const hold = await getHold(context, holdId, true);
        if (hold === undefined) return failure('hold_missing');
        const held = BigInt(hold.remaining);
        if (held === 0n) return failure('hold_closed');
        const [owner, receiver] = await positions(context, recipient);
        const at = await getTime(context.client);
        if (hold.expiresAt <= at) return failure('hold_closed');
        if (amount > held) return failure('insufficient_funds');
        const outstanding = held - amount;
        const released = final ? outstanding : 0n;
        return {
          at,
          deltas: [delta(owner, -amount, -amount - released), delta(receiver, amount)],
          persistHold: () => changeHold(context, holdId, at, outstanding - released, amount, released),
        };
      });
    },

    release: (input) => dropHold(input, 'release'),
    expire: (input) => dropHold(input, 'expire'),
  };
}
