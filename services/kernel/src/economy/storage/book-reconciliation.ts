import type { PoolClient, QueryResultRow } from 'pg';
import { isEconomyBookId } from '../contract.ts';

type Query = Pick<PoolClient, 'query'>;

/** Book-owner port. The native composition passes withBoundedReadOnlyTransaction for the selected book's pool. */
export interface BookReconciliationDatabase {
  snapshot<T>(deadline: number, work: (client: Query) => Promise<T>): Promise<T>;
}

type AssetRow = Readonly<{ assetId: string }>;
type AccountRow = AssetRow & Readonly<{ accountId: string }>;
type Position = AccountRow &
  Readonly<{
    role: string;
    posted: string;
    held: string;
    restricted: string;
    revision: string;
  }>;
type Entry = Readonly<{ position: string; posted: string; held: string }>;
type Hold = Readonly<{ holdId: string; remaining: string; allocated: string; captured: string; released: string }>;
type Allocation = Readonly<{
  purpose: string;
  reference: string;
  amount: string;
  status: 'protected' | 'captured' | 'released';
}>;
type Journal = AssetRow & Readonly<{ transactionId: string; kind: string }>;
type Pending = AccountRow & Readonly<{ units: string }>;
type PendingSource = Pending & Readonly<{ intentId: string; direction: string; phase: string }>;
type CreatorSource = AssetRow &
  Readonly<{ payoutId: string; creatorId: string; accountId: string | null; units: string; status: string }>;
type Control = AccountRow & Readonly<{ role: string; reference: string; positionRole: string | null }>;
type SourceAmount = AccountRow & { amount: bigint };

type Counter = {
  positions: number;
  journalEntries: number;
  posted: bigint;
  journalPosted: bigint;
  held: bigint;
  journalHeld: bigint;
  outstanding: bigint;
  restricted: bigint;
};
type AssetTotals = { components: Map<string, Counter>; pending: bigint; intentPending: bigint; journalNet: bigint };

export type BookFinding = Readonly<{
  check: string;
  assetId: string;
  key: readonly string[];
  expected: string;
  observed: string;
}>;
type Snapshot = Readonly<{ watermark: string; openedAt: string }>;

type Meter = { pages: number; limit: number };
const outOfPages = Symbol('economy reconciliation page limit');
const pageSize = 64;
const defaultPages = 256;
const maxPages = 2048;
const maxFindings = 32;
const maxMillis = 10_000;
const zeroAccount = '00000000-0000-0000-0000-000000000000';

function blankCounter(): Counter {
  return {
    positions: 0,
    journalEntries: 0,
    posted: 0n,
    journalPosted: 0n,
    held: 0n,
    journalHeld: 0n,
    outstanding: 0n,
    restricted: 0n,
  };
}

async function* pages<T extends QueryResultRow, C>(
  client: Query,
  meter: Meter,
  read: (cursor: C) => [string, readonly (string | number)[]],
  cursorOf: (row: T) => C,
  cursor: C,
): AsyncGenerator<T> {
  for (;;) {
    if (meter.pages >= meter.limit) throw outOfPages;
    meter.pages++;
    const [sql, inputs] = read(cursor);
    const { rows } = await client.query<T>(sql, [...inputs, pageSize]);
    yield* rows;
    if (rows.length < pageSize) return;
    cursor = cursorOf(rows[rows.length - 1]!);
  }
}

function keyed(row: AccountRow): string {
  return JSON.stringify([row.assetId, row.accountId]);
}

function collect(source: Map<string, SourceAmount>, row: AccountRow, amount: string): void {
  const key = keyed(row);
  const previous = source.get(key);
  if (previous) previous.amount += BigInt(amount);
  else source.set(key, { assetId: row.assetId, accountId: row.accountId, amount: BigInt(amount) });
}

function reportAssets(assets: Map<string, AssetTotals>) {
  return [...assets.entries()].map(([assetId, totals]) => ({
    assetId,
    journalNet: String(totals.journalNet),
    pendingDeposits: { projected: String(totals.pending), reconstructed: String(totals.intentPending) },
    components: [...totals.components.entries()].map(([role, c]) => ({
      role,
      positions: c.positions,
      journalEntries: c.journalEntries,
      posted: { projected: String(c.posted), reconstructed: String(c.journalPosted) },
      held: { projected: String(c.held), reconstructed: String(c.journalHeld), outstanding: String(c.outstanding) },
      restricted: String(c.restricted),
    })),
  }));
}

async function readSnapshotMarker(client: Query) {
  const { rows } = await client.query<{
    watermark: string;
    openedAt: Date;
    transactionStart: string;
    backend: number;
    isolation: string;
    readOnly: string;
  }>(
    `SELECT md5(pg_current_snapshot()::text) AS watermark, transaction_timestamp() AS "openedAt",
            transaction_timestamp()::text AS "transactionStart", pg_backend_pid() AS backend,
            current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"`,
  );
  const marker = rows[0];
  if (!marker || marker.isolation !== 'repeatable read' || marker.readOnly !== 'on')
    throw new Error('Economy reconciliation requires one read-only repeatable-read transaction');
  return marker;
}

async function auditSnapshot(client: Query, bookId: string, limit: number) {
  const pinned = await readSnapshotMarker(client);
  const snapshot: Snapshot = { watermark: pinned.watermark, openedAt: pinned.openedAt.toISOString() };
  const meter = { pages: 0, limit };
  const assets = new Map<string, AssetTotals>();
  const findings: BookFinding[] = [];
  let findingCount = 0;
  function check(
    checkName: string,
    assetId: string,
    key: readonly string[],
    expected: string | bigint,
    observed: string | bigint,
  ) {
    if (String(expected) === String(observed)) return;
    findingCount++;
    if (findings.length < maxFindings)
      findings.push({ check: checkName, assetId, key, expected: String(expected), observed: String(observed) });
  }

  async function verifyWalletHolds({ assetId, accountId }: Position): Promise<bigint> {
    let held = 0n;
    for await (const hold of pages<Hold, string>(
      client,
      meter,
      (after) => [
        `SELECT hold_id AS "holdId", remaining::text, allocated::text, captured::text, released::text
         FROM economy.hold WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id > $4
         ORDER BY hold_id LIMIT $5`,
        [bookId, assetId, accountId, after],
      ],
      (row) => row.holdId,
      '',
    )) {
      const sums = { protected: 0n, captured: 0n, released: 0n };
      for await (const child of pages<Allocation, readonly [string, string]>(
        client,
        meter,
        ([purpose, reference]) => [
          `SELECT purpose, reference, amount::text, status FROM economy.hold_allocation
          WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4 AND (purpose, reference) > ($5, $6)
          ORDER BY purpose, reference LIMIT $7`,
          [bookId, assetId, accountId, hold.holdId, purpose, reference],
        ],
        (row) => [row.purpose, row.reference],
        ['', ''],
      ))
        sums[child.status] += BigInt(child.amount);
      const location = [accountId, hold.holdId];
      check('hold_allocated', assetId, location, sums.protected, hold.allocated);
      if (sums.captured > BigInt(hold.captured))
        check('hold_capture_lower_bound', assetId, location, sums.captured, hold.captured);
      if (sums.released > BigInt(hold.released))
        check('hold_release_lower_bound', assetId, location, sums.released, hold.released);
      held += BigInt(hold.remaining);
    }
    return held;
  }

  let complete = true;
  try {
    for await (const { assetId } of pages<AssetRow, string>(
      client,
      meter,
      (after) => [
        `SELECT asset_id AS "assetId" FROM economy.asset WHERE book_id = $1 AND asset_id > $2 ORDER BY asset_id LIMIT $3`,
        [bookId, after],
      ],
      (row) => row.assetId,
      '',
    ))
      assets.set(assetId, { components: new Map(), pending: 0n, intentPending: 0n, journalNet: 0n });

    const creatorReserves = new Map<string, SourceAmount>();
    for await (const payout of pages<CreatorSource, string>(
      client,
      meter,
      (after) => [
        `SELECT p.payout_id AS "payoutId", p.asset_id AS "assetId", p.creator_id AS "creatorId", p.units::text, p.status,
              c.account_id AS "accountId"
         FROM economy.creator_payout AS p
         LEFT JOIN economy.funding_control_account AS c ON c.book_id = p.book_id AND c.asset_id = p.asset_id
           AND c.account_role = 'creator_payable' AND c.reference = p.creator_id::text
        WHERE p.book_id = $1 AND p.payout_id > $2 ORDER BY p.payout_id LIMIT $3`,
        [bookId, after],
      ],
      (row) => row.payoutId,
      '',
    )) {
      if (payout.status !== 'reserved') continue;
      if (!payout.accountId)
        check(
          'creator_payout_account',
          payout.assetId,
          [payout.creatorId, payout.payoutId],
          'creator_payable',
          'missing',
        );
      else collect(creatorReserves, { assetId: payout.assetId, accountId: payout.accountId }, payout.units);
    }

    for await (const position of pages<Position, readonly [string, string]>(
      client,
      meter,
      ([assetId, accountId]) => [
        `SELECT asset_id AS "assetId", account_id AS "accountId", account_role AS role, posted::text, held::text, restricted::text, revision::text
         FROM economy.position WHERE book_id = $1 AND (asset_id, account_id) > ($2, $3::uuid)
         ORDER BY asset_id, account_id LIMIT $4`,
        [bookId, assetId, accountId],
      ],
      (row) => [row.assetId, row.accountId],
      ['', zeroAccount],
    )) {
      const { assetId, accountId, role } = position;
      let posted = 0n;
      let held = 0n;
      let revision = 0n;
      for await (const entry of pages<Entry, string>(
        client,
        meter,
        (after) => [
          `SELECT position::text, posted_delta::text AS posted, held_delta::text AS held
           FROM economy.entry AS entry WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND position > $4::bigint
           ORDER BY entry.position LIMIT $5`,
          [bookId, assetId, accountId, after],
        ],
        (row) => row.position,
        '0',
      )) {
        revision++;
        check('entry_position', assetId, [accountId, entry.position], revision, entry.position);
        posted += BigInt(entry.posted);
        held += BigInt(entry.held);
      }
      const key = keyed(position);
      const outstanding =
        role === 'wallet' ? await verifyWalletHolds(position) : (creatorReserves.get(key)?.amount ?? 0n);
      creatorReserves.delete(key);
      check('position_revision', assetId, [accountId], revision, position.revision);
      check('position_posted', assetId, [accountId], posted, position.posted);
      check('position_held_journal', assetId, [accountId], held, position.held);
      check('position_held_obligations', assetId, [accountId], outstanding, position.held);
      // The current book has no restriction posting. Retain the observed counter for owner review.
      const controls = assets.get(assetId)!.components;
      const c = controls.get(role) ?? blankCounter();
      c.positions++;
      c.journalEntries += Number(revision);
      c.posted += BigInt(position.posted);
      c.journalPosted += posted;
      c.held += BigInt(position.held);
      c.journalHeld += held;
      c.outstanding += outstanding;
      c.restricted += BigInt(position.restricted);
      controls.set(role, c);
    }
    for (const { assetId, accountId, amount } of creatorReserves.values())
      check('creator_payable_position', assetId, [accountId], amount, 'missing');

    for await (const control of pages<Control, readonly [string, string, string]>(
      client,
      meter,
      ([assetId, role, reference]) => [
        `SELECT c.asset_id AS "assetId", c.account_id AS "accountId", c.account_role AS role, c.reference,
              p.account_role AS "positionRole"
         FROM economy.funding_control_account AS c
         LEFT JOIN economy.position AS p USING (book_id, asset_id, account_id)
        WHERE c.book_id = $1 AND (c.asset_id, c.account_role, c.reference) > ($2, $3, $4)
        ORDER BY c.asset_id, c.account_role, c.reference LIMIT $5`,
        [bookId, assetId, role, reference],
      ],
      (row) => [row.assetId, row.role, row.reference],
      ['', '', ''],
    )) {
      check('role_position', control.assetId, [control.accountId], control.role, control.positionRole ?? 'missing');
    }

    const expectedPending = new Map<string, SourceAmount>();
    for await (const intent of pages<PendingSource, string>(
      client,
      meter,
      (after) => [
        `SELECT intent_id AS "intentId", wallet_id AS "accountId", asset_id AS "assetId", units::text, direction, phase
         FROM economy.funding_intent WHERE book_id = $1 AND intent_id > $2 ORDER BY intent_id LIMIT $3`,
        [bookId, after],
      ],
      (row) => row.intentId,
      '',
    )) {
      if (intent.direction !== 'deposit' || (intent.phase !== 'submitted' && intent.phase !== 'unknown')) continue;
      collect(expectedPending, intent, intent.units);
      assets.get(intent.assetId)!.intentPending += BigInt(intent.units);
    }
    for await (const row of pages<Pending, readonly [string, string]>(
      client,
      meter,
      ([assetId, accountId]) => [
        `SELECT asset_id AS "assetId", wallet_id AS "accountId", units::text FROM economy.pending_deposit
        WHERE book_id = $1 AND (asset_id, wallet_id) > ($2, $3::uuid) ORDER BY asset_id, wallet_id LIMIT $4`,
        [bookId, assetId, accountId],
      ],
      (item) => [item.assetId, item.accountId],
      ['', zeroAccount],
    )) {
      const key = keyed(row);
      check('pending_deposit', row.assetId, [row.accountId], expectedPending.get(key)?.amount ?? 0n, row.units);
      expectedPending.delete(key);
      assets.get(row.assetId)!.pending += BigInt(row.units);
    }
    for (const { assetId, accountId, amount } of expectedPending.values())
      check('pending_deposit', assetId, [accountId], amount, 'missing');

    for await (const journal of pages<Journal, readonly [string, string]>(
      client,
      meter,
      ([assetId, transactionId]) => [
        `SELECT asset_id AS "assetId", transaction_id AS "transactionId", kind FROM economy.journal
        WHERE book_id = $1 AND (asset_id, transaction_id) > ($2, $3::uuid) ORDER BY asset_id, transaction_id LIMIT $4`,
        [bookId, assetId, transactionId],
      ],
      (row) => [row.assetId, row.transactionId],
      ['', zeroAccount],
    )) {
      const { assetId, transactionId } = journal;
      let net = 0n;
      let count = 0;
      // Start below the nil UUID as issuance's signed control is a valid journal entry.
      for await (const leg of pages<{ accountId: string; posted: string }, string | null>(
        client,
        meter,
        (after) => [
          `SELECT account_id AS "accountId", posted_delta::text AS posted FROM economy.entry
          WHERE book_id = $1 AND asset_id = $2 AND transaction_id = $3 ${after === null ? 'AND account_id >= $4::uuid' : 'AND account_id > $4::uuid'}
          ORDER BY account_id LIMIT $5`,
          [bookId, assetId, transactionId, after ?? zeroAccount],
        ],
        (row) => row.accountId,
        null,
      )) {
        net += BigInt(leg.posted);
        count++;
      }
      if (journal.kind !== 'allocate' && count === 0)
        check('journal_entries', assetId, [transactionId], 'present', 'missing');
      check('journal_posted_net', assetId, [transactionId], 0n, net);
      assets.get(assetId)!.journalNet += net;
    }
    for (const [assetId, asset] of assets) check('asset_journal_net', assetId, [], 0n, asset.journalNet);
  } catch (error) {
    if (error !== outOfPages) throw error;
    complete = false;
  }
  const end = await readSnapshotMarker(client);
  if (
    end.backend !== pinned.backend ||
    end.transactionStart !== pinned.transactionStart ||
    end.watermark !== pinned.watermark
  )
    throw new Error('Economy reconciliation snapshot changed before completion');
  if (!complete) return { kind: 'incomplete' as const, bookId, snapshot, pages: meter.pages, findingCount, findings };
  return {
    kind: findingCount === 0 ? ('consistent' as const) : ('divergent' as const),
    bookId,
    snapshot,
    pages: meter.pages,
    findingCount,
    findings,
    assets: reportAssets(assets),
  };
}

/** A complete result covers one pinned book cut. A limited audit never publishes partial asset control totals. */
export function reconcileBook(
  database: BookReconciliationDatabase,
  input: Readonly<{ bookId: string; deadline: number; pageLimit?: number }>,
) {
  const pages = input.pageLimit ?? defaultPages;
  if (
    !isEconomyBookId(input.bookId) ||
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > maxPages ||
    !Number.isFinite(input.deadline)
  )
    throw new TypeError('Invalid Economy book reconciliation request');
  return database.snapshot(Math.min(input.deadline, Date.now() + maxMillis), (client) =>
    auditSnapshot(client, input.bookId, pages),
  );
}
