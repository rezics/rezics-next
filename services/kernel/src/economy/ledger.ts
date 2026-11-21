import { createHash, randomUUID } from 'node:crypto';
import type {
  CreatorClearing,
  CreatorPayoutObservation,
  CreatorPayoutStatus,
  CreatorRail,
} from './storage/creator-contract.ts';
import type { PoolClient } from 'pg';
import {
  isEconomyBookId,
  WALLET_BALANCE_PAGE_LIMIT,
  type AssetProgram,
  type EconomyAsset,
  type EconomyFailure,
  type EconomyLedger,
  type EconomyReceipt,
  type EconomyResult,
  type ExpiredAssetProgram,
  type HoldAllocation,
  type HoldAllocationKey,
  type HoldAllocationPurpose,
  type SpotFillSettlement,
  type WalletBalance,
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
type CreatorKind =
  | 'creator_accrual'
  | 'creator_payout_reserve'
  | 'creator_payout'
  | 'creator_payout_refusal'
  | 'creator_payout_return';
type Kind =
  | WalletEntry['kind']
  | CreatorKind
  | 'allocate'
  | 'capture_allocation'
  | 'release_allocation'
  | 'release_amount';
type ControlRole = 'provider_clearing' | 'chargeback_receivable' | 'creator_payable' | 'creator_expense';
type AccountRole = 'wallet' | 'issuer' | ControlRole;
type Position = Readonly<{
  accountId: string;
  accountRole: AccountRole;
  posted: string;
  held: string;
  restricted: string;
  revision: string;
}>;
type BalanceRow = EconomyAsset & Pick<Position, 'accountRole' | 'posted' | 'held' | 'restricted'> & { pending: string };
type Delta = Readonly<{ position: Position; posted: bigint; held: bigint }>;
type Hold = Readonly<{ remaining: string; allocated: string; expiresAt: Date }>;
type HoldChange = Readonly<{ captured?: bigint; released?: bigint; allocated?: bigint }>;
type SpotCapture = Readonly<{ amount: bigint; feeAccountId: string; fee: bigint }>;
type AllocationRef = Pick<HoldAllocationKey, 'holdId' | 'purpose' | 'reference'>;
type AllocationRow = Omit<HoldAllocation, 'allocatedAt' | 'resolvedAt'> & {
  allocatedAt: Date;
  resolvedAt: Date | null;
};
type Context = Readonly<{ client: Query; bookId: string; asset: EconomyAsset; accountId: string }>;
type Namespace = 'wallet' | 'owner';
type Plan = Readonly<{
  deltas: readonly Delta[];
  at: Date;
  persistHold?: (transactionId: string) => Promise<unknown>;
}>;
type BusinessFailure = Readonly<{ kind: Exclude<EconomyFailure, 'unavailable'> }>;
type Outcome = 'ok' | BusinessFailure['kind'];

type FundingProvider = Readonly<{ namespace: string; mode: 'test' | 'live' }>;
type FundingProof = FundingProvider & Readonly<{ source: 'movement' | 'refusal'; id: string }>;
export type NativeFundingPosting = WalletKey &
  Readonly<{ proof: FundingProof; units: string }> &
  (
    | Readonly<{ kind: 'deposit' | 'withdrawal_return' }>
    | Readonly<{ kind: 'withdrawal' | 'withdrawal_refusal'; holdId: string }>
    | Readonly<{ kind: 'chargeback'; recoverableUnits: string }>
  );

interface NativeFundingLedger {
  lockRecoverableFundingWallet(
    input: WalletKey & Readonly<{ provider: FundingProvider }>,
  ): Promise<EconomyResult<string>>;
  postFunding(input: NativeFundingPosting): Promise<EconomyResult<EconomyReceipt>>;
}

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

function available(position: Pick<Position, 'posted' | 'held' | 'restricted'>): bigint {
  return BigInt(position.posted) - BigInt(position.held) - BigInt(position.restricted);
}

const walletBalanceColumns = `asset.asset_id AS id, asset.scale, asset.transferable,
  COALESCE(position.account_role, 'wallet') AS "accountRole",
  COALESCE(position.posted, 0)::text AS posted, COALESCE(position.held, 0)::text AS held,
  (CASE WHEN program.expires_at <= statement_timestamp()
    THEN COALESCE(position.posted - position.held, 0)
    ELSE COALESCE(position.restricted, 0) END)::text AS restricted,
  COALESCE(pending.units, 0)::text AS pending`;
const walletBalanceJoins = `LEFT JOIN economy.asset_program AS program
    ON program.book_id = asset.book_id AND program.asset_id = asset.asset_id
  LEFT JOIN economy.position AS position
    ON position.book_id = asset.book_id AND position.asset_id = asset.asset_id AND position.account_id = $3
  LEFT JOIN economy.pending_deposit AS pending
    ON pending.book_id = asset.book_id AND pending.asset_id = asset.asset_id AND pending.wallet_id = $3`;

function walletBalanceOf(row: BalanceRow): WalletBalance {
  const { id, scale, transferable, posted, held, restricted, pending } = row;
  return {
    asset: { id, scale, transferable },
    posted,
    held,
    restricted,
    pending,
    available: available(row).toString(),
  };
}

async function getAsset(client: Query, bookId: string, assetId: string): Promise<EconomyAsset | undefined> {
  const result = await client.query<EconomyAsset>(
    'SELECT asset_id AS id, scale, transferable FROM economy.asset WHERE book_id = $1 AND asset_id = $2',
    [bookId, assetId],
  );
  return result.rows[0];
}

async function getAssetProgram(client: Query, bookId: string, assetId: string): Promise<AssetProgram | undefined> {
  const { rows } = await client.query<Omit<AssetProgram, 'expiresAt'> & { expiresAt: Date | null }>(
    `SELECT asset.asset_id AS id, asset.scale, asset.transferable, program.program_id AS "programId",
            program.version::text, program.issuance_source AS "issuanceSource", program.supply_cap::text AS "supplyCap",
            program.redeemable, program.expires_at AS "expiresAt"
     FROM economy.asset_program AS program JOIN economy.asset AS asset USING (book_id, asset_id)
     WHERE program.book_id = $1 AND program.asset_id = $2`,
    [bookId, assetId],
  );
  const row = rows[0];
  return row && { ...row, expiresAt: row.expiresAt?.toISOString() ?? null };
}

function sameAssetProgram(a: AssetProgram, b: AssetProgram): boolean {
  return (
    a.id === b.id &&
    a.scale === b.scale &&
    a.transferable === b.transferable &&
    a.programId === b.programId &&
    a.version === b.version &&
    a.issuanceSource === b.issuanceSource &&
    a.supplyCap === b.supplyCap &&
    a.redeemable === b.redeemable &&
    a.expiresAt === b.expiresAt
  );
}

function programExpired(program: AssetProgram, at: Date): boolean {
  return program.expiresAt !== null && new Date(program.expiresAt) <= at;
}

type ProgramSource = Readonly<{ kind: 'mint' | 'redeem'; reference: string }>;

async function programSourceExists(context: Context, program: AssetProgram, source: ProgramSource): Promise<boolean> {
  const { client, bookId } = context;
  const key = [bookId, program.programId, source.kind, source.reference];
  // One scope across versions. Lock source before any issuer or wallet position.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'asset-program', $2::text, $3::text, $4::text)::text, 0))`,
    key,
  );
  const existing = await client.query(
    'SELECT 1 FROM economy.asset_program_source WHERE book_id = $1 AND program_id = $2 AND kind = $3 AND source_reference = $4',
    key,
  );
  return existing.rowCount === 1;
}

function recordProgramSource(context: Context, program: AssetProgram, source: ProgramSource, transactionId: string) {
  return context.client.query(
    `INSERT INTO economy.asset_program_source (book_id, asset_id, program_id, kind, source_reference, transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [context.bookId, context.asset.id, program.programId, source.kind, source.reference, transactionId],
  );
}

async function getTime(client: Query): Promise<Date> {
  const result = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at');
  return result.rows[0]!.at;
}

async function lockPositions(
  context: Context,
  keys: readonly string[],
  controls: ReadonlyMap<string, ControlRole> = new Map(),
): Promise<Map<string, Position>> {
  const { client, bookId, asset } = context;
  const roleOf = (id: string): AccountRole => controls.get(id) ?? (id === issuerAccount ? 'issuer' : 'wallet');
  await client.query(
    `INSERT INTO economy.position (book_id, asset_id, account_id, account_role)
     SELECT $1, $2, account_id, account_role
       FROM unnest($3::uuid[], $4::text[]) AS keys(account_id, account_role) ORDER BY account_id
     ON CONFLICT DO NOTHING`,
    [bookId, asset.id, keys, keys.map(roleOf)],
  );
  const result = await client.query<Position>(
    `SELECT account_id::text AS "accountId", account_role AS "accountRole", posted::text, held::text, restricted::text, revision::text
     FROM economy.position
     WHERE book_id = $1 AND asset_id = $2 AND account_id = ANY($3::uuid[])
     ORDER BY account_id FOR UPDATE`,
    [bookId, asset.id, keys],
  );
  if (result.rows.length !== keys.length) throw new Error('Economy account position is missing');
  if (result.rows.some(({ accountId, accountRole }) => accountRole !== roleOf(accountId)))
    throw new Error('Economy account position role does not match its posting');
  return new Map(result.rows.map((position) => [position.accountId, position]));
}

function positions(context: Context): Promise<readonly [Position]>;
function positions(context: Context, related: string): Promise<readonly [Position, Position]>;
async function positions(
  context: Context,
  related?: string,
): Promise<readonly [Position] | readonly [Position, Position]> {
  const { accountId } = context;
  const locked = await lockPositions(context, related === undefined ? [accountId] : [accountId, related]);
  const own = locked.get(accountId)!;
  return related === undefined ? [own] : [own, locked.get(related)!];
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
    const restricted = BigInt(change.position.restricted);
    if (
      change.position.accountRole === 'wallet' || change.position.accountRole === 'creator_payable'
        ? held < 0n || posted < held + restricted
        : held !== 0n || restricted !== 0n
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
    `SELECT remaining::text, allocated::text, expires_at AS "expiresAt" FROM economy.hold
     WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4${lock ? ' FOR UPDATE' : ''}`,
    [context.bookId, context.asset.id, context.accountId, id],
  );
  return result.rows[0];
}

function unallocated(hold: Hold): bigint {
  return BigInt(hold.remaining) - BigInt(hold.allocated);
}

function changeHold(context: Context, id: string, at: Date, change: HoldChange): Promise<unknown> {
  const { captured = 0n, released = 0n, allocated = 0n } = change;
  return context.client.query(
    `UPDATE economy.hold
     SET remaining = remaining - $5::bigint - $6::bigint,
         captured = captured + $5::bigint, released = released + $6::bigint,
         allocated = allocated + $7::bigint,
         closed_at = CASE WHEN remaining - $5::bigint - $6::bigint = 0 THEN $8::timestamptz ELSE NULL END
     WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4`,
    [
      context.bookId,
      context.asset.id,
      context.accountId,
      id,
      captured.toString(),
      released.toString(),
      allocated.toString(),
      at,
    ],
  );
}

function validAllocationPurpose(value: HoldAllocationPurpose): boolean {
  return value === 'spot_fill' || value === 'market_trade' || value === 'withdrawal';
}

function validAllocationRef({ holdId, purpose, reference }: AllocationRef): boolean {
  return validOperationKey(holdId) && validAllocationPurpose(purpose) && validOperationKey(reference);
}

function allocationOperands(bookId: string, key: HoldAllocationKey): string[] {
  return [bookId, key.assetId, key.accountId, key.holdId, key.purpose, key.reference];
}

async function getAllocation(
  client: Query,
  bookId: string,
  key: HoldAllocationKey,
): Promise<AllocationRow | undefined> {
  const result = await client.query<AllocationRow>(
    `SELECT purpose, reference, amount::text, status, recipient_id::text AS "recipientId",
            allocated_at AS "allocatedAt", resolved_at AS "resolvedAt"
     FROM economy.hold_allocation
     WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4 AND purpose = $5 AND reference = $6`,
    allocationOperands(bookId, key),
  );
  return result.rows[0];
}

/** Mutation callers hold the parent row before inspecting or writing any child allocation. */
async function finishAllocation(
  client: Query,
  bookId: string,
  key: HoldAllocationKey,
  recipientId: string | null,
  transactionId: string,
  at: Date,
): Promise<void> {
  const status = recipientId === null ? 'released' : 'captured';
  const result = await client.query(
    `UPDATE economy.hold_allocation
     SET status = $7, recipient_id = $8, terminal_transaction_id = $9, resolved_at = $10
     WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4 AND purpose = $5 AND reference = $6
       AND status = 'protected'`,
    [...allocationOperands(bookId, key), status, recipientId, transactionId, at],
  );
  if (result.rowCount !== 1) throw new Error('Protected Economy allocation changed while locked');
}

function validFundingProvider(value: FundingProvider): boolean {
  return validOperationKey(value.namespace) && (value.mode === 'test' || value.mode === 'live');
}

async function controlAccount(context: Context, role: ControlRole, reference: string): Promise<string> {
  const { client, bookId, asset } = context;
  const key = [bookId, asset.id, role, reference];
  await client.query(
    `INSERT INTO economy.funding_control_account (book_id, asset_id, account_role, reference, account_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (book_id, asset_id, account_role, reference) DO NOTHING`,
    [...key, randomUUID()],
  );
  const { rows } = await client.query<{ accountId: string }>(
    `SELECT account_id AS "accountId" FROM economy.funding_control_account
      WHERE book_id = $1 AND asset_id = $2 AND account_role = $3 AND reference = $4`,
    key,
  );
  if (!rows[0]) throw new Error('Economy funding control is missing');
  return rows[0].accountId;
}

async function lockFundingPositions(context: Context, provider: FundingProvider, includeReceivable: boolean) {
  const clearing = await controlAccount(context, 'provider_clearing', `${provider.mode}/${provider.namespace}`);
  const receivable = includeReceivable
    ? await controlAccount(context, 'chargeback_receivable', context.accountId)
    : null;
  const controls = new Map<string, ControlRole>([[clearing, 'provider_clearing']]);
  if (receivable !== null) controls.set(receivable, 'chargeback_receivable');
  if (controls.has(context.accountId) || (receivable !== null && receivable === clearing))
    throw new Error('Economy funding account identity overlaps');
  const locked = await lockPositions(context, [context.accountId, ...controls.keys()], controls);
  return {
    owner: locked.get(context.accountId)!,
    clearing: locked.get(clearing)!,
    receivable: receivable === null ? null : locked.get(receivable)!,
  };
}

async function bindFundingJournal(context: Context, proof: FundingProof, transactionId: string): Promise<void> {
  const { rowCount } = await context.client.query(
    `INSERT INTO economy.funding_posting (provider_namespace, provider_mode, source_kind, source_id, book_id, asset_id, transaction_id)
     SELECT e.provider_namespace, e.provider_mode, e.source_kind, e.source_id, e.book_id, i.asset_id, $8
       FROM economy.funding_evidence AS e
       JOIN economy.funding_intent AS i ON i.book_id = e.book_id AND i.intent_id = e.intent_id
      WHERE e.provider_namespace = $1 AND e.provider_mode = $2 AND e.source_kind = $3 AND e.source_id = $4
        AND e.book_id = $5 AND i.asset_id = $6 AND i.wallet_id = $7`,
    [
      proof.namespace,
      proof.mode,
      proof.source,
      proof.id,
      context.bookId,
      context.asset.id,
      context.accountId,
      transactionId,
    ],
  );
  if (rowCount !== 1) throw new Error('Economy funding journal has no matching provider evidence');
}

type CreatorEvidence = readonly [
  namespace: string,
  mode: 'owner' | 'test' | 'live',
  kind: 'accrual' | 'movement' | 'refusal',
  id: string,
];
type CreatorPayoutRow = Omit<CreatorPayoutStatus, 'provider'> & {
  namespace: string;
  mode: CreatorRail['mode'];
  destinationRef: string;
};

function validCreatorRail(provider: CreatorRail): boolean {
  return validFundingProvider(provider) && validOperationKey(provider.destinationRef);
}

function sameCreatorRail(a: CreatorRail, b: CreatorRail): boolean {
  return a.namespace === b.namespace && a.mode === b.mode && a.destinationRef === b.destinationRef;
}

async function readCreatorPayout(
  client: Query,
  bookId: string,
  payoutId: string,
  lock: boolean,
): Promise<CreatorPayoutStatus | null> {
  const { rows } = await client.query<CreatorPayoutRow>(
    `SELECT payout_id AS "payoutId", creator_id::text AS "creatorId", asset_id AS "assetId", units::text,
            provider_namespace AS namespace, provider_mode AS mode, destination_ref AS "destinationRef",
            status, paid_movement_id AS "paidMovementId", returned_units::text AS "returnedUnits"
       FROM economy.creator_payout WHERE book_id = $1 AND payout_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [bookId, payoutId],
  );
  const row = rows[0];
  if (!row) return null;
  const { namespace, mode, destinationRef, ...payout } = row;
  return { ...payout, provider: { namespace, mode, destinationRef } };
}

async function creatorPositions(
  context: Context,
  opposing?: Readonly<{ role: 'creator_expense' | 'provider_clearing'; reference: string }>,
) {
  const controls = new Map<string, ControlRole>();
  const counter = opposing ? await controlAccount(context, opposing.role, opposing.reference) : null;
  if (counter !== null) controls.set(counter, opposing!.role);
  const payable = await controlAccount(context, 'creator_payable', context.accountId);
  controls.set(payable, 'creator_payable');
  const positions = await lockPositions(context, [...controls.keys()], controls);
  return { payable: positions.get(payable)!, counter: counter === null ? null : positions.get(counter)! };
}

function movementOf(payout: CreatorPayoutStatus, observation: CreatorPayoutObservation, amount: bigint) {
  const units = BigInt(payout.units);
  if (observation.kind === 'returned') {
    if (
      payout.status !== 'paid' ||
      payout.paidMovementId !== observation.originalMovementId ||
      observation.movementId === observation.originalMovementId ||
      BigInt(payout.returnedUnits) + amount > units
    )
      return null;
    return {
      returned: BigInt(payout.returnedUnits) + amount,
      status: 'paid' as const,
      paidMovementId: payout.paidMovementId,
    };
  }
  if (payout.status !== 'reserved' || amount !== units) return null;
  return observation.kind === 'paid'
    ? { returned: 0n, status: 'paid' as const, paidMovementId: observation.movementId }
    : { returned: 0n, status: 'released' as const, paidMovementId: null };
}

export function createEconomyLedger(
  database: EconomyDatabase,
  bookId: string,
): EconomyLedger & NativeFundingLedger & { creatorClearing: CreatorClearing } {
  if (!isEconomyBookId(bookId)) throw new TypeError('Invalid Economy book ID');

  function command(
    input: Operation,
    kind: Kind,
    holdId: string | null,
    operands: readonly (string | boolean)[],
    prepare: (context: Context) => Promise<Plan | BusinessFailure>,
    connection?: Query,
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
    const namespace = kind === 'transfer' || kind === 'redeem' ? 'wallet' : 'owner';
    const digest = createHash('sha256')
      .update(JSON.stringify([1, kind, assetId, holdId, ...operands]))
      .digest();
    const run = async (client: Query): Promise<EconomyResult<EconomyReceipt>> => {
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
    };
    return connection === undefined ? database.transaction(run) : run(connection);
  }

  function dropHold(
    input: Command,
    kind: 'release' | 'expire' | 'release_amount',
    amount?: bigint,
  ): Promise<EconomyResult<EconomyReceipt>> {
    const { holdId } = input;
    return command(input, kind, holdId, amount === undefined ? [] : [amount.toString()], async (context) => {
      const hold = await getHold(context, holdId, true);
      if (hold === undefined) return failure('hold_missing');
      const open = unallocated(hold);
      if (open === 0n) return failure('hold_closed');
      const released = amount ?? open;
      if (released > open) return failure('insufficient_funds');
      const [owner] = await positions(context);
      const at = await getTime(context.client);
      if (kind === 'expire' && hold.expiresAt > at) return failure('invalid_operation');
      return {
        at,
        deltas: [delta(owner, 0n, -released)],
        persistHold: () => changeHold(context, holdId, at, { released }),
      };
    });
  }

  function resolveAllocation(
    input: HoldAllocationKey & Pick<Operation, 'operationId'>,
    recipient: string | null,
    spot?: Readonly<{ capture: SpotCapture; connection: Query }>,
  ): Promise<EconomyResult<EconomyReceipt>> {
    if (!validAllocationRef(input)) return Promise.resolve(failure('invalid_operation'));
    const { holdId, purpose, reference } = input;
    const kind = recipient === null ? 'release_allocation' : 'capture_allocation';
    const operands = recipient === null ? [purpose, reference] : [purpose, reference, recipient];
    const spotCapture = spot?.capture;
    if (spotCapture) operands.push(spotCapture.amount.toString(), spotCapture.feeAccountId, spotCapture.fee.toString());
    return command(
      input,
      kind,
      holdId,
      operands,
      async (context) => {
        const hold = await getHold(context, holdId, true);
        if (hold === undefined) return failure('hold_missing');
        const key = { accountId: context.accountId, assetId: context.asset.id, holdId, purpose, reference };
        const allocation = await getAllocation(context.client, bookId, key);
        if (allocation === undefined) return failure('allocation_missing');
        if (allocation.status !== 'protected') return failure('allocation_closed');

        const amount = BigInt(allocation.amount);
        if (spotCapture && amount !== spotCapture.amount) return failure('operation_conflict');
        if (spotCapture && !context.asset.transferable) return failure('asset_not_transferable');
        const fee = spotCapture?.fee ?? 0n;
        const feeAccountId = spotCapture?.feeAccountId;
        const keys = recipient === null ? [context.accountId] : [context.accountId, recipient];
        if (fee > 0n && feeAccountId !== undefined) keys.push(feeAccountId);
        const locked = await lockPositions(context, keys);
        const owner = locked.get(context.accountId)!;
        const captured = recipient === null ? 0n : amount;
        const released = amount - captured;
        const changes = [delta(owner, -captured, -amount)];
        if (recipient !== null && amount > fee) changes.push(delta(locked.get(recipient)!, amount - fee));
        if (fee > 0n && feeAccountId !== undefined) changes.push(delta(locked.get(feeAccountId)!, fee));
        const at = await getTime(context.client);
        return {
          at,
          deltas: changes,
          persistHold: async (transactionId) => {
            await changeHold(context, holdId, at, { captured, released, allocated: -amount });
            await finishAllocation(context.client, bookId, key, recipient, transactionId, at);
          },
        };
      },
      spot?.connection,
    );
  }

  function settleSpotFill(input: SpotFillSettlement): Promise<EconomyResult<EconomyReceipt>> {
    const { fillId, instrumentId, policyVersion, buyerHoldId, sellerHoldId, baseAssetId, quoteAssetId } = input;
    const buyerId = walletAccount(input.buyerId);
    const sellerId = walletAccount(input.sellerId);
    const feeAccountId = walletAccount(input.feeAccountId);
    const base = positiveInteger(input.baseUnits);
    const quote = positiveInteger(input.quoteUnits);
    const buyerFee = input.buyerFeeUnits === '0' ? 0n : positiveInteger(input.buyerFeeUnits);
    const sellerFee = input.sellerFeeUnits === '0' ? 0n : positiveInteger(input.sellerFeeUnits);
    if (
      buyerId === null ||
      sellerId === null ||
      feeAccountId === null ||
      new Set([buyerId, sellerId, feeAccountId]).size !== 3 ||
      ![instrumentId, baseAssetId, quoteAssetId].every(validIdentifier) ||
      baseAssetId === quoteAssetId ||
      ![fillId, buyerHoldId, sellerHoldId].every(validOperationKey) ||
      positiveInteger(policyVersion) === null
    )
      return Promise.resolve(failure('invalid_operation'));
    if (
      base === null ||
      quote === null ||
      buyerFee === null ||
      sellerFee === null ||
      sellerFee > quote ||
      quote + buyerFee > maxInteger
    )
      return Promise.resolve(failure('invalid_amount'));

    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          instrumentId,
          policyVersion,
          buyerId,
          sellerId,
          feeAccountId,
          buyerHoldId,
          sellerHoldId,
          baseAssetId,
          quoteAssetId,
          base.toString(),
          quote.toString(),
          buyerFee.toString(),
          sellerFee.toString(),
        ]),
      )
      .digest();
    const operation = createHash('sha256').update(fillId).digest('hex');
    const legs = [
      {
        assetId: baseAssetId,
        accountId: sellerId,
        holdId: sellerHoldId,
        recipient: buyerId,
        operationId: `spot/base/${operation}`,
        amount: base,
        fee: 0n,
      },
      {
        assetId: quoteAssetId,
        accountId: buyerId,
        holdId: buyerHoldId,
        recipient: sellerId,
        operationId: `spot/quote/${operation}`,
        amount: quote + buyerFee,
        fee: buyerFee + sellerFee,
      },
    ].sort((left, right) => (left.assetId < right.assetId ? -1 : 1));
    return database.transaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'spot_settlement', $2::text)::text, 0))`,
        [bookId, fillId],
      );
      const prior = await client.query<{ digest: Buffer }>(
        'SELECT digest FROM economy.spot_settlement WHERE book_id = $1 AND fill_id = $2',
        [bookId, fillId],
      );
      if (prior.rows[0])
        return digest.equals(prior.rows[0].digest) ? success({ operationId: fillId }) : failure('operation_conflict');
      await client.query('SAVEPOINT economy_spot_settlement');
      for (const leg of legs) {
        const result = await resolveAllocation({ ...leg, purpose: 'spot_fill', reference: fillId }, leg.recipient, {
          capture: { amount: leg.amount, feeAccountId, fee: leg.fee },
          connection: client,
        });
        if (result.kind !== 'ok') {
          await client.query('ROLLBACK TO SAVEPOINT economy_spot_settlement');
          return result;
        }
      }
      await client
        .query(
          `INSERT INTO economy.spot_settlement
         (book_id, fill_id, digest, base_asset_id, base_transaction_id, quote_asset_id, quote_transaction_id)
         SELECT $1, $2, $3, base.asset_id, base.transaction_id, quote.asset_id, quote.transaction_id
         FROM economy.journal AS base CROSS JOIN economy.journal AS quote
         WHERE base.book_id = $1 AND base.origin_id = $4 AND base.namespace = 'owner' AND base.operation_id = $5
           AND quote.book_id = $1 AND quote.origin_id = $6 AND quote.namespace = 'owner' AND quote.operation_id = $7`,
          [bookId, fillId, digest, sellerId, `spot/base/${operation}`, buyerId, `spot/quote/${operation}`],
        )
        .then((inserted) => {
          if (inserted.rowCount !== 1) throw new Error('Spot settlement is missing a captured ledger leg');
        });
      return success({ operationId: fillId });
    });
  }

  function postFunding(input: NativeFundingPosting): Promise<EconomyResult<EconomyReceipt>> {
    const { proof, kind } = input;
    const holdId = 'holdId' in input ? input.holdId : null;
    const recovered =
      kind === 'chargeback' ? (input.recoverableUnits === '0' ? 0n : positiveInteger(input.recoverableUnits)) : 0n;
    const amount = positiveInteger(input.units);
    if (amount === null || recovered === null || recovered > amount) return Promise.resolve(failure('invalid_amount'));
    if (
      !validFundingProvider(proof) ||
      !validOperationKey(proof.id) ||
      proof.source !== (kind === 'withdrawal_refusal' ? 'refusal' : 'movement')
    )
      return Promise.resolve(failure('invalid_operation'));
    const evidenceKey = JSON.stringify([proof.namespace, proof.mode, proof.source, proof.id]);
    const operationId = `funding/evidence/${createHash('sha256').update(evidenceKey).digest('hex')}`;
    return command(
      { ...input, operationId },
      kind,
      holdId,
      [evidenceKey, input.units, recovered.toString()],
      async (context) => {
        const key =
          holdId === null
            ? null
            : {
                accountId: context.accountId,
                assetId: context.asset.id,
                holdId,
                purpose: 'withdrawal' as const,
                reference: holdId,
              };
        if (key !== null) {
          if (!(await getHold(context, key.holdId, true))) return failure('hold_missing');
          const protectedAllocation = await getAllocation(context.client, bookId, key);
          if (!protectedAllocation) return failure('allocation_missing');
          if (protectedAllocation.status !== 'protected') return failure('allocation_closed');
          if (BigInt(protectedAllocation.amount) !== amount) return failure('operation_conflict');
        }
        if (await getAssetProgram(context.client, bookId, context.asset.id)) return failure('program_ineligible');
        const at = await getTime(context.client);
        let deltas: readonly Delta[];
        let recipient: string | null = null;
        if (kind === 'withdrawal_refusal') {
          const [owner] = await positions(context);
          deltas = [delta(owner, 0n, -amount)];
        } else {
          const { owner, clearing, receivable } = await lockFundingPositions(context, proof, kind === 'chargeback');
          if (kind === 'withdrawal') {
            recipient = clearing.accountId;
            deltas = [delta(owner, -amount, -amount), delta(clearing, amount)];
          } else if (kind === 'chargeback') {
            if (available(owner) < recovered) return failure('insufficient_funds');
            const changes = [delta(clearing, amount)];
            if (recovered > 0n) changes.push(delta(owner, -recovered));
            if (amount > recovered) changes.push(delta(receivable!, recovered - amount));
            deltas = changes;
          } else {
            deltas = [delta(owner, amount), delta(clearing, -amount)];
          }
        }
        return {
          at,
          deltas,
          persistHold: async (transactionId) => {
            if (key !== null) {
              const captured = kind === 'withdrawal' ? amount : 0n;
              await changeHold(context, key.holdId, at, { captured, released: amount - captured, allocated: -amount });
              await finishAllocation(context.client, bookId, key, recipient, transactionId, at);
            }
            await bindFundingJournal(context, proof, transactionId);
          },
        };
      },
    );
  }

  async function postCreatorSource(
    client: Query,
    input: Readonly<{
      creatorId: string;
      assetId: string;
      source: CreatorEvidence;
      kind: CreatorKind;
      payoutId: string | null;
      terms: readonly string[];
      ready?: boolean;
    }>,
    prepare: (context: Context) => Promise<Plan | BusinessFailure>,
  ): Promise<EconomyResult<EconomyReceipt>> {
    const { source, assetId, creatorId, kind, payoutId, terms } = input;
    const identity = JSON.stringify(source);
    const digest = createHash('sha256')
      .update(JSON.stringify([1, bookId, creatorId, assetId, kind, payoutId, ...terms]))
      .digest();
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('creator-evidence:' || $1::text, 0))`, [
      identity,
    ]);
    const prior = await client.query<{ digest: Buffer }>(
      `SELECT digest FROM economy.creator_posting
        WHERE source_namespace = $1 AND source_mode = $2 AND source_kind = $3 AND source_id = $4`,
      [...source],
    );
    const result = success({ operationId: source[3] });
    if (prior.rows[0]) return digest.equals(prior.rows[0].digest) ? result : failure('operation_conflict');
    if (input.ready === false) return failure('operation_conflict');
    const operationId = `creator/evidence/${createHash('sha256').update(identity).digest('hex')}`;
    const posted = await command(
      { assetId, accountId: creatorId, operationId },
      kind,
      null,
      [identity, digest.toString('hex')],
      async (context) => {
        const plan = await prepare(context);
        if ('kind' in plan) return plan;
        // Match wallet-funding lock order: positions before the common provider posting identity.
        if (source[1] !== 'owner') {
          const claim = await client.query(
            `INSERT INTO economy.provider_posting_key VALUES ($1, $2, $3, $4, 'creator_payout') ON CONFLICT DO NOTHING`,
            [...source],
          );
          if (claim.rowCount !== 1) return failure('operation_conflict');
        }
        return {
          ...plan,
          persistHold: async (transactionId) => {
            await plan.persistHold?.(transactionId);
            await client.query(
              `INSERT INTO economy.creator_posting (source_namespace, source_mode, source_kind, source_id,
                 book_id, asset_id, payout_id, digest, transaction_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [...source, bookId, assetId, payoutId, digest, transactionId],
            );
          },
        };
      },
      client,
    );
    return posted.kind === 'ok' ? result : posted;
  }

  const creatorClearing: CreatorClearing = {
    readPayable({ creatorId, assetId }) {
      const accountId = walletAccount(creatorId);
      if (accountId === null || !validIdentifier(assetId)) return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        const result = await client.query<{ posted: string; reserved: string; available: string }>(
          `SELECT COALESCE(position.posted, 0)::text AS posted, COALESCE(position.held, 0)::text AS reserved,
                  COALESCE(position.posted - position.held, 0)::text AS available
             FROM economy.asset AS asset
             LEFT JOIN economy.funding_control_account AS control ON control.book_id = asset.book_id
               AND control.asset_id = asset.asset_id AND control.account_role = 'creator_payable' AND control.reference = $3
             LEFT JOIN economy.position AS position ON position.book_id = control.book_id
               AND position.asset_id = control.asset_id AND position.account_id = control.account_id
               AND position.account_role = control.account_role
            WHERE asset.book_id = $1 AND asset.asset_id = $2`,
          [bookId, assetId, accountId],
        );
        return result.rows[0] ? success(result.rows[0]) : failure('asset_missing');
      });
    },

    readPayout(payoutId) {
      if (!validIdentifier(payoutId)) return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => success(await readCreatorPayout(client, bookId, payoutId, false)));
    },

    accrue(input) {
      const creatorId = walletAccount(input.creatorId);
      const amount = positiveInteger(input.units);
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (
        creatorId === null ||
        !validIdentifier(input.assetId) ||
        ![input.source.namespace, input.source.id, input.expenseReference].every(validOperationKey)
      )
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction((client) =>
        postCreatorSource(
          client,
          {
            creatorId,
            assetId: input.assetId,
            source: [input.source.namespace, 'owner', 'accrual', input.source.id],
            kind: 'creator_accrual',
            payoutId: null,
            terms: [input.units, input.expenseReference],
          },
          async (context) => {
            const { payable, counter } = await creatorPositions(context, {
              role: 'creator_expense',
              reference: input.expenseReference,
            });
            return { at: await getTime(client), deltas: [delta(counter!, -amount), delta(payable, amount)] };
          },
        ),
      );
    },

    reservePayout(input) {
      const creatorId = walletAccount(input.creatorId);
      const amount = positiveInteger(input.units);
      const { payoutId, assetId, provider } = input;
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (creatorId === null || !validIdentifier(assetId) || !validIdentifier(payoutId) || !validCreatorRail(provider))
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('creator-payout', $1::text, $2::text)::text, 0))`,
          [bookId, payoutId],
        );
        const prior = await readCreatorPayout(client, bookId, payoutId, true);
        const receipt = success({ operationId: payoutId });
        if (prior)
          return prior.creatorId === creatorId &&
            prior.assetId === assetId &&
            prior.units === input.units &&
            sameCreatorRail(prior.provider, provider)
            ? receipt
            : failure('operation_conflict');
        const posted = await command(
          { accountId: creatorId, assetId, operationId: `creator/reserve/${payoutId}` },
          'creator_payout_reserve',
          null,
          [payoutId, input.units, provider.namespace, provider.mode, provider.destinationRef],
          async (context) => {
            const { payable } = await creatorPositions(context);
            if (available(payable) < amount) return failure('insufficient_funds');
            return {
              at: await getTime(client),
              deltas: [delta(payable, 0n, amount)],
              persistHold: (transactionId) =>
                client.query(
                  `INSERT INTO economy.creator_payout (book_id, payout_id, creator_id, asset_id, units,
                   provider_namespace, provider_mode, destination_ref, status, reserve_transaction_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9)`,
                  [
                    bookId,
                    payoutId,
                    creatorId,
                    assetId,
                    input.units,
                    provider.namespace,
                    provider.mode,
                    provider.destinationRef,
                    transactionId,
                  ],
                ),
            };
          },
          client,
        );
        return posted.kind === 'ok' ? receipt : posted;
      });
    },

    observePayout(observation) {
      const amount = positiveInteger(observation.units);
      const { payoutId, provider, assetId, kind } = observation;
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (
        !validIdentifier(payoutId) ||
        !validIdentifier(assetId) ||
        !validCreatorRail(provider) ||
        !['paid', 'refused', 'returned'].includes(kind)
      )
        return Promise.resolve(failure('invalid_operation'));
      const sourceId = kind === 'refused' ? observation.evidenceId : observation.movementId;
      if (!validOperationKey(sourceId) || (kind === 'returned' && !validOperationKey(observation.originalMovementId)))
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (client) => {
        const payout = await readCreatorPayout(client, bookId, payoutId, true);
        if (!payout) return failure('invalid_operation');
        if (payout.assetId !== assetId || !sameCreatorRail(payout.provider, provider))
          return failure('operation_conflict');
        const next = movementOf(payout, observation, amount);
        const terms = [
          provider.destinationRef,
          observation.units,
          kind === 'returned' ? observation.originalMovementId : '',
        ];
        const journalKind =
          kind === 'paid' ? 'creator_payout' : kind === 'refused' ? 'creator_payout_refusal' : 'creator_payout_return';
        return postCreatorSource(
          client,
          {
            creatorId: payout.creatorId,
            assetId: payout.assetId,
            source: [provider.namespace, provider.mode, kind === 'refused' ? 'refusal' : 'movement', sourceId],
            kind: journalKind,
            payoutId,
            terms,
            ready: next !== null,
          },
          async (context) => {
            if (next === null) throw new Error('Economy creator payout transition changed while locked');
            const opposing =
              kind === 'refused'
                ? undefined
                : { role: 'provider_clearing' as const, reference: `${provider.mode}/${provider.namespace}` };
            const { payable, counter } = await creatorPositions(context, opposing);
            if (kind !== 'returned' && BigInt(payable.held) < amount)
              throw new Error('Economy creator payout is missing its reservation');
            const deltas =
              kind === 'paid'
                ? [delta(payable, -amount, -amount), delta(counter!, amount)]
                : kind === 'refused'
                  ? [delta(payable, 0n, -amount)]
                  : [delta(counter!, -amount), delta(payable, amount)];
            return {
              at: await getTime(client),
              deltas,
              persistHold: async () => {
                await client.query(
                  `UPDATE economy.creator_payout SET status = $3, paid_movement_id = $4, returned_units = $5
                  WHERE book_id = $1 AND payout_id = $2`,
                  [bookId, payoutId, next.status, next.paidMovementId, next.returned.toString()],
                );
              },
            };
          },
        );
      });
    },
  };

  function burnProgramUnits(
    input: Operation,
    purpose:
      | Readonly<{ kind: 'redeem'; units: bigint; reference: string }>
      | Readonly<{ kind: 'credit_expiry'; admittedAt: Date; connection: Query }>,
  ) {
    const redemption = purpose.kind === 'redeem' ? purpose : null;
    return command(
      input,
      purpose.kind,
      null,
      redemption ? [redemption.units.toString(), redemption.reference] : [],
      async (context) => {
        const program = await getAssetProgram(context.client, bookId, context.asset.id);
        if (!program) return failure('asset_missing');
        if (redemption && !program.redeemable) return failure('program_ineligible');
        if (redemption && (await programSourceExists(context, program, redemption)))
          return failure('operation_conflict');
        const [owner, issuer] = await positions(context, issuerAccount);
        const at = purpose.kind === 'credit_expiry' ? purpose.admittedAt : await getTime(context.client);
        if (redemption && programExpired(program, at)) return failure('program_expired');
        const spendable = available(owner);
        const units = redemption?.units ?? spendable;
        if (units === 0n || units > spendable) return failure('insufficient_funds');
        return {
          at,
          deltas: [delta(owner, -units), delta(issuer, units)],
          ...(redemption
            ? {
                persistHold: (transactionId: string) =>
                  recordProgramSource(context, program, redemption, transactionId),
              }
            : {}),
        };
      },
      purpose.kind === 'credit_expiry' ? purpose.connection : undefined,
    );
  }

  return {
    creatorClearing,
    postFunding,
    lockRecoverableFundingWallet(input) {
      const accountId = walletAccount(input.accountId);
      if (accountId === null || !validIdentifier(input.assetId) || !validFundingProvider(input.provider))
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (client) => {
        const asset = await getAsset(client, bookId, input.assetId);
        if (!asset) return failure('asset_missing');
        const { owner } = await lockFundingPositions({ client, bookId, asset, accountId }, input.provider, true);
        return success(available(owner).toString());
      });
    },
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

    provisionAssetProgram(input) {
      const { id, scale, transferable, programId, version, issuanceSource, supplyCap, redeemable } = input;
      const expiresAt = input.expiresAt === null ? null : expiryDate(input.expiresAt);
      if (
        ![id, programId, issuanceSource].every(validIdentifier) ||
        !Number.isInteger(scale) ||
        scale < 0 ||
        scale > 18 ||
        ![transferable, redeemable].every((value) => typeof value === 'boolean') ||
        positiveInteger(version) === null ||
        positiveInteger(supplyCap) === null ||
        (input.expiresAt !== null && (expiresAt === null || transferable))
      )
        return Promise.resolve(failure('invalid_operation'));
      const expected = { ...input, expiresAt: expiresAt?.toISOString() ?? null };
      return database.transaction(async (client) => {
        await client.query('SAVEPOINT economy_provision_program');
        const asset = await client.query(
          'INSERT INTO economy.asset (book_id, asset_id, scale, transferable) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [bookId, id, scale, transferable],
        );
        if (!asset.rowCount) {
          const existing = await getAssetProgram(client, bookId, id);
          return existing && sameAssetProgram(existing, expected) ? success(existing) : failure('operation_conflict');
        }
        const program = await client.query(
          `INSERT INTO economy.asset_program
           (book_id, asset_id, program_id, version, issuance_source, supply_cap, redeemable, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [bookId, id, programId, version, issuanceSource, supplyCap, redeemable, expiresAt],
        );
        if (!program.rowCount) {
          await client.query('ROLLBACK TO SAVEPOINT economy_provision_program');
          return failure('operation_conflict');
        }
        return success(expected);
      });
    },

    enrollAssetProgramRecipient(input) {
      const accountId = walletAccount(input.accountId);
      if (accountId === null || ![input.assetId, input.issuanceSource].every(validIdentifier))
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (client) => {
        const program = await getAssetProgram(client, bookId, input.assetId);
        if (!program) return failure('asset_missing');
        if (program.issuanceSource !== input.issuanceSource) return failure('program_ineligible');
        if (programExpired(program, await getTime(client))) return failure('program_expired');
        await client.query(
          `INSERT INTO economy.asset_program_recipient (book_id, asset_id, account_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [bookId, input.assetId, accountId],
        );
        return success(null);
      });
    },

    issueProgramUnits(input) {
      const units = positiveInteger(input.amount);
      if (units === null) return Promise.resolve(failure('invalid_amount'));
      if (!validIdentifier(input.issuanceSource) || !validOperationKey(input.sourceReference))
        return Promise.resolve(failure('invalid_operation'));
      const sourceId = createHash('sha256')
        .update(JSON.stringify([input.assetId, input.issuanceSource, input.sourceReference]))
        .digest('hex');
      return command(
        { ...input, operationId: `program-mint/${sourceId}` },
        'issue',
        null,
        [input.issuanceSource, input.sourceReference, input.amount],
        async (context) => {
          const { client, asset, accountId } = context;
          const program = await getAssetProgram(client, bookId, asset.id);
          if (!program) return failure('asset_missing');
          if (program.issuanceSource !== input.issuanceSource) return failure('program_ineligible');
          const enrolled = await client.query(
            'SELECT 1 FROM economy.asset_program_recipient WHERE book_id = $1 AND asset_id = $2 AND account_id = $3',
            [bookId, asset.id, accountId],
          );
          if (!enrolled.rowCount) return failure('program_ineligible');
          const source = { kind: 'mint', reference: input.sourceReference } as const;
          if (await programSourceExists(context, program, source)) return failure('operation_conflict');
          const [owner, issuer] = await positions(context, issuerAccount);
          const at = await getTime(client);
          if (programExpired(program, at)) return failure('program_expired');
          if (units - BigInt(issuer.posted) > BigInt(program.supplyCap)) return failure('program_supply_exceeded');
          return {
            at,
            deltas: [delta(issuer, -units), delta(owner, units)],
            persistHold: (transactionId) => recordProgramSource(context, program, source, transactionId),
          };
        },
      );
    },

    redeemProgramUnits(input) {
      const units = positiveInteger(input.amount);
      if (units === null) return Promise.resolve(failure('invalid_amount'));
      if (!validOperationKey(input.redemptionReference)) return Promise.resolve(failure('invalid_operation'));
      const key = createHash('sha256')
        .update(JSON.stringify([input.assetId, input.redemptionReference]))
        .digest('hex');
      return burnProgramUnits(
        { ...input, operationId: `program-redeem/${key}` },
        { kind: 'redeem', units, reference: input.redemptionReference },
      );
    },

    nextExpiredAssetProgram(after) {
      if (after !== undefined && !validIdentifier(after.assetId)) return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        const { rows } = await client.query<ExpiredAssetProgram>(
          `SELECT asset_id AS "assetId", expires_at::text AS "expiresAt"
           FROM economy.asset_program_expiry
           WHERE book_id = $1 AND retired_at IS NULL AND expires_at <= statement_timestamp()
             AND (expires_at, asset_id) > ($2::timestamptz, $3)
           ORDER BY expires_at, asset_id LIMIT 1`,
          [bookId, after?.expiresAt ?? '-infinity', after?.assetId ?? ''],
        );
        return success(rows[0] ?? null);
      });
    },

    retireExpiredAssetProgram(assetId) {
      if (!validIdentifier(assetId)) return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (client) => {
        const ready = await client.query(
          `SELECT 1 FROM economy.asset_program_expiry
           WHERE book_id = $1 AND asset_id = $2 AND retired_at IS NULL AND expires_at <= statement_timestamp()`,
          [bookId, assetId],
        );
        if (!ready.rowCount) return success(false);
        await client.query("SET LOCAL lock_timeout = '1s'");
        // Mint locks the issuer before checking expiry. Wait out any admitted mint, including the first.
        await client.query(
          `INSERT INTO economy.position (book_id, asset_id, account_id, account_role)
           VALUES ($1, $2, $3, 'issuer') ON CONFLICT DO NOTHING`,
          [bookId, assetId, issuerAccount],
        );
        await client.query(
          `SELECT 1 FROM economy.position WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 FOR UPDATE`,
          [bookId, assetId, issuerAccount],
        );
        const retired = await client.query(
          `UPDATE economy.asset_program_expiry SET retired_at = statement_timestamp()
           WHERE book_id = $1 AND asset_id = $2 AND retired_at IS NULL AND expires_at <= statement_timestamp()
             AND NOT EXISTS (
               SELECT 1 FROM economy.position WHERE book_id = $1 AND asset_id = $2
                 AND account_role = 'wallet' AND posted > 0
             )`,
          [bookId, assetId],
        );
        return success(retired.rowCount === 1);
      });
    },

    expireProgramCredits(input) {
      if (!walletAccount(input.accountId) || !validIdentifier(input.assetId))
        return Promise.resolve(failure('invalid_operation'));
      return database.transaction(async (connection) => {
        const program = await getAssetProgram(connection, bookId, input.assetId);
        if (!program) return failure('asset_missing');
        const admittedAt = await getTime(connection);
        // An early sweep has no terminal effect. Keep the same key available when native time reaches expiry.
        if (!programExpired(program, admittedAt)) return failure('invalid_operation');
        // Stop the native lock wait before the worker's connection deadline can leave other positions blocked.
        await connection.query("SET LOCAL lock_timeout = '1s'");
        return burnProgramUnits(
          { ...input, operationId: `program-expiry/${input.assetId}` },
          { kind: 'credit_expiry', admittedAt, connection },
        );
      });
    },

    listExpiredProgramCredits({ assetId, limit, after }) {
      const account = after === undefined ? issuerAccount : walletAccount(after);
      if (account === null || !validIdentifier(assetId) || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        const { rows } = await client.query<{ accountId: string }>(
          `SELECT position.account_id::text AS "accountId" FROM economy.asset_program AS program
           JOIN economy.position AS position USING (book_id, asset_id)
           WHERE program.book_id = $1 AND program.asset_id = $2 AND program.expires_at <= statement_timestamp()
             AND position.account_role = 'wallet' AND position.posted > 0 AND position.account_id > $3
           ORDER BY position.account_id LIMIT $4`,
          [bookId, assetId, account, limit + 1],
        );
        const accounts = rows.slice(0, limit).map((row) => row.accountId);
        return success({ accounts, next: rows.length > limit ? accounts[accounts.length - 1]! : null });
      });
    },

    listBalances(input) {
      const accountId = walletAccount(input.accountId);
      const { after = '', limit } = input;
      if (
        accountId === null ||
        (input.after !== undefined && !validIdentifier(input.after)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > WALLET_BALANCE_PAGE_LIMIT
      )
        return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        // Cap both sources before deduplicating and project the page from the same statement snapshot.
        const { rows } = await client.query<BalanceRow>(
          `WITH candidates AS (
             (SELECT asset_id FROM economy.position
              WHERE book_id = $1 AND account_id = $3 AND account_role = 'wallet' AND asset_id > $2
              ORDER BY asset_id LIMIT $4)
             UNION
             (SELECT asset_id FROM economy.pending_deposit
              WHERE book_id = $1 AND wallet_id = $3 AND units > 0 AND asset_id > $2
              ORDER BY asset_id LIMIT $4)
           ), page AS (
             SELECT asset_id FROM candidates ORDER BY asset_id LIMIT $4
           )
           SELECT ${walletBalanceColumns}
           FROM page JOIN economy.asset AS asset ON asset.book_id = $1 AND asset.asset_id = page.asset_id
           ${walletBalanceJoins}
           ORDER BY page.asset_id`,
          [bookId, after, accountId, limit + 1],
        );
        const shown = rows.slice(0, limit);
        if (shown.some((row) => row.accountRole !== 'wallet')) return failure('invalid_operation');
        return success({
          balances: shown.map(walletBalanceOf),
          next: rows.length > limit ? shown.at(-1)!.id : null,
        });
      });
    },

    readBalance(input) {
      const accountId = walletAccount(input.accountId);
      const { assetId } = input;
      if (accountId === null || !validIdentifier(assetId)) return Promise.resolve(failure('invalid_operation'));
      return database.read(async (client) => {
        const { rows } = await client.query<BalanceRow>(
          `SELECT ${walletBalanceColumns}
           FROM economy.asset AS asset
           ${walletBalanceJoins}
           WHERE asset.book_id = $1 AND asset.asset_id = $2`,
          [bookId, assetId, accountId],
        );
        const row = rows[0];
        if (row === undefined) return failure('asset_missing');
        if (row.accountRole !== 'wallet') return failure('invalid_operation');
        return success(walletBalanceOf(row));
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
                  CASE j.kind WHEN 'capture_allocation' THEN 'capture'
                              WHEN 'release_allocation' THEN 'release'
                              WHEN 'release_amount' THEN 'release' ELSE j.kind END AS kind,
                  e.posted_delta::text AS "postedDelta",
                  e.held_delta::text AS "heldDelta", j.recorded_at AS "recordedAt"
           FROM economy.entry AS e
           JOIN economy.journal AS j ON j.book_id = e.book_id AND j.asset_id = e.asset_id AND j.transaction_id = e.transaction_id
           WHERE e.book_id = $1 AND e.asset_id = $2 AND e.account_id = $3 AND e.position <= $4::bigint
             AND EXISTS (SELECT 1 FROM economy.position AS wallet
                         WHERE wallet.book_id = $1 AND wallet.asset_id = $2 AND wallet.account_id = $3
                           AND wallet.account_role = 'wallet')
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
        if (await getAssetProgram(context.client, bookId, context.asset.id)) return failure('program_ineligible');
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
        if (!context.asset.transferable && (await getAssetProgram(context.client, bookId, context.asset.id)))
          return failure('asset_not_transferable');
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
        const held = unallocated(hold);
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
          persistHold: () => changeHold(context, holdId, at, { captured: amount, released }),
        };
      });
    },

    release: (input) => dropHold(input, 'release'),
    expire: (input) => dropHold(input, 'expire'),

    releaseAmount(input) {
      const amount = positiveInteger(input.amount);
      return amount === null ? Promise.resolve(failure('invalid_amount')) : dropHold(input, 'release_amount', amount);
    },

    allocate(input) {
      const amount = positiveInteger(input.amount);
      if (amount === null) return Promise.resolve(failure('invalid_amount'));
      if (!validAllocationRef(input)) return Promise.resolve(failure('invalid_operation'));
      const { holdId, purpose, reference } = input;
      return command(input, 'allocate', holdId, [purpose, reference, amount.toString()], async (context) => {
        const hold = await getHold(context, holdId, true);
        if (hold === undefined) return failure('hold_missing');
        const key = { accountId: context.accountId, assetId: context.asset.id, holdId, purpose, reference };
        if ((await getAllocation(context.client, bookId, key)) !== undefined) return failure('operation_conflict');
        const at = await getTime(context.client);
        const open = unallocated(hold);
        if (hold.expiresAt <= at || open === 0n) return failure('hold_closed');
        if (amount > open) return failure('insufficient_funds');
        return {
          at,
          // The wallet is already held; assigning some of that amount changes only the hold and its allocation journal.
          deltas: [],
          persistHold: async (transactionId) => {
            await changeHold(context, holdId, at, { allocated: amount });
            await context.client.query(
              `INSERT INTO economy.hold_allocation (book_id, asset_id, account_id, hold_id, purpose, reference, amount,
                                                    status, allocation_transaction_id, allocated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'protected', $8, $9)`,
              [...allocationOperands(bookId, key), amount.toString(), transactionId, at],
            );
          },
        };
      });
    },

    readAllocation(input) {
      const accountId = walletAccount(input.accountId);
      if (accountId === null || !validIdentifier(input.assetId) || !validAllocationRef(input))
        return Promise.resolve(failure('invalid_operation'));
      const key = { ...input, accountId };
      return database.read(async (client) => {
        const row = await getAllocation(client, bookId, key);
        return row === undefined
          ? failure('allocation_missing')
          : success({
              ...row,
              allocatedAt: row.allocatedAt.toISOString(),
              resolvedAt: row.resolvedAt?.toISOString() ?? null,
            });
      });
    },

    captureAllocation(input) {
      const recipient = walletAccount(input.recipientId);
      if (recipient === null || recipient === walletAccount(input.accountId))
        return Promise.resolve(failure('invalid_operation'));
      return resolveAllocation(input, recipient);
    },

    releaseAllocation: (input) => resolveAllocation(input, null),
    settleSpotFill,
  };
}
