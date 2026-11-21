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
type Entry = AccountRow & Readonly<{ position: string; transactionId: string; posted: string; held: string }>;
type HoldKey = AccountRow & Readonly<{ holdId: string }>;
type Hold = HoldKey & Readonly<{ remaining: string; allocated: string; captured: string; released: string }>;
type Allocation = HoldKey &
  Readonly<{
    purpose: string;
    reference: string;
    amount: string;
    status: 'protected' | 'captured' | 'released';
  }>;
type Journal = AssetRow & Readonly<{ transactionId: string; kind: string }>;
type Pending = AccountRow & Readonly<{ units: string }>;
type PendingSource = Pending & Readonly<{ intentId: string; direction: string; phase: string }>;
type CreatorSource = Pending & Readonly<{ payoutId: string; status: string }>;
type Control = AccountRow & Readonly<{ role: string; reference: string }>;
type SourceAmount = AccountRow & { amount: bigint };
type PostingTotals = AccountRow & { revision: bigint; posted: bigint; held: bigint };
type JournalTotals = AssetRow & { transactionId: string; count: number; net: bigint };
type AllocationTotals = HoldKey & { protected: bigint; captured: bigint; released: bigint };

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

function collect(source: Map<string, SourceAmount>, row: AccountRow, amount: bigint): void {
  const key = keyed(row);
  const previous = source.get(key);
  if (previous) previous.amount += amount;
  else source.set(key, { assetId: row.assetId, accountId: row.accountId, amount });
}

function holdKey({ assetId, accountId, holdId }: HoldKey): string {
  return JSON.stringify([assetId, accountId, holdId]);
}

function journalKey({ assetId, transactionId }: AssetRow & Readonly<{ transactionId: string }>): string {
  return JSON.stringify([assetId, transactionId]);
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

async function verifySnapshotMarker(client: Query, pinned: Awaited<ReturnType<typeof readSnapshotMarker>>) {
  const end = await readSnapshotMarker(client);
  if (
    end.backend !== pinned.backend ||
    end.transactionStart !== pinned.transactionStart ||
    end.watermark !== pinned.watermark
  )
    throw new Error('Economy reconciliation snapshot changed before completion');
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
    if (assets.size === 0) {
      await verifySnapshotMarker(client, pinned);
      return { kind: 'absent' as const, bookId, snapshot, pages: meter.pages, findingCount, findings };
    }

    // One book-local entry stream is the independent source for both account and transaction counters.
    const postingTotals = new Map<string, PostingTotals>();
    const journalTotals = new Map<string, JournalTotals>();
    for await (const entry of pages<Entry, readonly [string, string, string]>(
      client,
      meter,
      ([assetId, accountId, position]) => [
        `SELECT e.asset_id AS "assetId", e.account_id AS "accountId", e.position::text,
                e.transaction_id AS "transactionId", e.posted_delta::text AS posted, e.held_delta::text AS held
           FROM economy.entry AS e
          WHERE e.book_id = $1 AND (e.asset_id, e.account_id, e.position) > ($2, $3::uuid, $4::bigint)
          ORDER BY e.asset_id, e.account_id, e.position LIMIT $5`,
        [bookId, assetId, accountId, position],
      ],
      (row) => [row.assetId, row.accountId, row.position],
      ['', zeroAccount, '0'],
    )) {
      const { assetId, accountId, transactionId } = entry;
      const key = keyed(entry);
      const position = postingTotals.get(key) ?? { assetId, accountId, revision: 0n, posted: 0n, held: 0n };
      const posted = BigInt(entry.posted);
      position.revision++;
      position.posted += posted;
      position.held += BigInt(entry.held);
      check('entry_position', assetId, [accountId, entry.position], position.revision, entry.position);
      postingTotals.set(key, position);
      const groupKey = journalKey(entry);
      const journal = journalTotals.get(groupKey) ?? { assetId, transactionId, count: 0, net: 0n };
      journal.count++;
      journal.net += posted;
      journalTotals.set(groupKey, journal);
    }

    const allocations = new Map<string, AllocationTotals>();
    for await (const row of pages<Allocation, readonly [string, string, string, string, string]>(
      client,
      meter,
      ([assetId, accountId, holdId, purpose, reference]) => [
        `SELECT asset_id AS "assetId", account_id AS "accountId", hold_id AS "holdId", purpose, reference, amount::text, status
           FROM economy.hold_allocation WHERE book_id = $1
            AND (asset_id, account_id, hold_id, purpose, reference) > ($2, $3::uuid, $4, $5, $6)
          ORDER BY asset_id, account_id, hold_id, purpose, reference LIMIT $7`,
        [bookId, assetId, accountId, holdId, purpose, reference],
      ],
      (row) => [row.assetId, row.accountId, row.holdId, row.purpose, row.reference],
      ['', zeroAccount, '', '', ''],
    )) {
      const key = holdKey(row);
      const { assetId, accountId, holdId } = row;
      const totals = allocations.get(key) ?? { assetId, accountId, holdId, protected: 0n, captured: 0n, released: 0n };
      totals[row.status] += BigInt(row.amount);
      allocations.set(key, totals);
    }

    const walletHolds = new Map<string, SourceAmount>();
    for await (const hold of pages<Hold, readonly [string, string, string]>(
      client,
      meter,
      ([assetId, accountId, holdId]) => [
        `SELECT asset_id AS "assetId", account_id AS "accountId", hold_id AS "holdId",
                remaining::text, allocated::text, captured::text, released::text
           FROM economy.hold WHERE book_id = $1 AND (asset_id, account_id, hold_id) > ($2, $3::uuid, $4)
          ORDER BY asset_id, account_id, hold_id LIMIT $5`,
        [bookId, assetId, accountId, holdId],
      ],
      (row) => [row.assetId, row.accountId, row.holdId],
      ['', zeroAccount, ''],
    )) {
      const { assetId, accountId, holdId } = hold;
      const key = holdKey(hold);
      const totals = allocations.get(key);
      allocations.delete(key);
      const location = [accountId, holdId];
      check('hold_allocated', assetId, location, totals?.protected ?? 0n, hold.allocated);
      if (totals && totals.captured > BigInt(hold.captured))
        check('hold_capture_lower_bound', assetId, location, totals.captured, hold.captured);
      if (totals && totals.released > BigInt(hold.released))
        check('hold_release_lower_bound', assetId, location, totals.released, hold.released);
      collect(walletHolds, hold, BigInt(hold.remaining));
    }
    for (const { assetId, accountId, holdId } of allocations.values())
      check('allocation_parent', assetId, [accountId, holdId], 'present', 'missing');

    const creatorReserves = new Map<string, SourceAmount>();
    for await (const payout of pages<CreatorSource, string>(
      client,
      meter,
      (after) => [
        `SELECT payout_id AS "payoutId", asset_id AS "assetId", creator_id AS "accountId", units::text, status
           FROM economy.creator_payout WHERE book_id = $1 AND payout_id > $2 ORDER BY payout_id LIMIT $3`,
        [bookId, after],
      ],
      (row) => row.payoutId,
      '',
    )) {
      if (payout.status === 'reserved') collect(creatorReserves, payout, BigInt(payout.units));
    }

    const roleAccounts = new Map<string, Control>();
    const payableHolds = new Map<string, SourceAmount>();
    for await (const control of pages<Control, readonly [string, string, string]>(
      client,
      meter,
      ([assetId, role, reference]) => [
        `SELECT asset_id AS "assetId", account_id AS "accountId", account_role AS role, reference
           FROM economy.funding_control_account WHERE book_id = $1 AND (asset_id, account_role, reference) > ($2, $3, $4)
          ORDER BY asset_id, account_role, reference LIMIT $5`,
        [bookId, assetId, role, reference],
      ],
      (row) => [row.assetId, row.role, row.reference],
      ['', '', ''],
    )) {
      roleAccounts.set(keyed(control), control);
      if (control.role === 'creator_payable') {
        const key = keyed({ assetId: control.assetId, accountId: control.reference });
        const reserved = creatorReserves.get(key);
        if (reserved) collect(payableHolds, control, reserved.amount);
        creatorReserves.delete(key);
      }
    }
    for (const { assetId, accountId } of creatorReserves.values())
      check('creator_payout_account', assetId, [accountId], 'creator_payable', 'missing');

    for await (const position of pages<Position, readonly [string, string]>(
      client,
      meter,
      ([assetId, accountId]) => [
        `SELECT asset_id AS "assetId", account_id AS "accountId", account_role AS role,
                posted::text, held::text, restricted::text, revision::text
           FROM economy.position WHERE book_id = $1 AND (asset_id, account_id) > ($2, $3::uuid)
          ORDER BY asset_id, account_id LIMIT $4`,
        [bookId, assetId, accountId],
      ],
      (row) => [row.assetId, row.accountId],
      ['', zeroAccount],
    )) {
      const { assetId, accountId, role } = position;
      const key = keyed(position);
      const entries = postingTotals.get(key);
      postingTotals.delete(key);
      const mapped = roleAccounts.get(key);
      if (mapped) check('role_position', assetId, [accountId], mapped.role, role);
      else if (role !== 'wallet' && role !== 'issuer') check('role_account', assetId, [accountId], role, 'missing');
      roleAccounts.delete(key);
      let outstanding = 0n;
      if (role === 'wallet') {
        outstanding = walletHolds.get(key)?.amount ?? 0n;
        walletHolds.delete(key);
      } else if (role === 'creator_payable') {
        outstanding = payableHolds.get(key)?.amount ?? 0n;
        payableHolds.delete(key);
      }
      const { revision = 0n, posted = 0n, held = 0n } = entries ?? {};
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
    for (const { assetId, accountId, role } of roleAccounts.values())
      check('role_position', assetId, [accountId], role, 'missing');
    for (const { assetId, accountId, amount } of payableHolds.values())
      check('creator_payable_position', assetId, [accountId], amount, 'missing');
    for (const { assetId, accountId } of walletHolds.values())
      check('wallet_hold_position', assetId, [accountId], 'wallet', 'missing');
    for (const { assetId, accountId } of postingTotals.values())
      check('entry_account_position', assetId, [accountId], 'present', 'missing');

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
      collect(expectedPending, intent, BigInt(intent.units));
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
      const key = journalKey(journal);
      const { net = 0n, count = 0 } = journalTotals.get(key) ?? {};
      journalTotals.delete(key);
      if (journal.kind !== 'allocate' && count === 0)
        check('journal_entries', assetId, [transactionId], 'present', 'missing');
      check('journal_posted_net', assetId, [transactionId], 0n, net);
      assets.get(assetId)!.journalNet += net;
    }
    for (const { assetId, transactionId } of journalTotals.values())
      check('entry_journal', assetId, [transactionId], 'present', 'missing');
    for (const [assetId, asset] of assets) check('asset_journal_net', assetId, [], 0n, asset.journalNet);
  } catch (error) {
    if (error !== outOfPages) throw error;
    complete = false;
  }
  await verifySnapshotMarker(client, pinned);
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
