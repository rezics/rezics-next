import type { PoolClient } from 'pg';
import { isEconomyBookId } from '../contract.ts';
import type { EconomyDatabase } from '../ledger.ts';
import {
  acknowledgeWithdrawalHold,
  beginFunding,
  fundingEvidenceKey,
  markFundingDispatchUnknown,
  observeFunding,
  prepareFundingDispatch,
  type EvidenceKey,
  type EvidenceReceipt,
  type FundingDecision,
  type FundingIntent,
  type FundingObservation,
  type FundingState,
} from '../settlement/funding.ts';

type Transaction = Pick<PoolClient, 'query'>;
type Reservation = Parameters<typeof acknowledgeWithdrawalHold>[1];
type Effect = NonNullable<Extract<FundingDecision, { kind: 'applied' }>['effect']>;

/** These writes and the locked wallet read use the store's transaction. The binder performs no provider I/O. */
export interface FundingLedgerBinder {
  reserve(tx: Transaction, reservation: Omit<Reservation, 'protected'>): Promise<Reservation>;
  recoverableWalletUnits(tx: Transaction, intent: FundingIntent): Promise<string>;
  apply(
    tx: Transaction,
    posting: Readonly<{ intent: FundingIntent; receipt: EvidenceReceipt; effect: Effect }>,
  ): Promise<void>;
}

type DispatchAction = 'submit' | 'reconcile';
type Attempt = Readonly<{ attemptId: string; intent: FundingIntent }>;
type DispatchClaim = Readonly<{
  kind: 'claimed';
  action: DispatchAction;
  attempt: Attempt;
  claimId: string;
  leaseUntil: string;
}>;
export type FundingDispatchAcknowledgment =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{
      kind: 'observed';
      observation: FundingObservation;
    }>;

type IntentRow = Pick<FundingIntent, 'bookId' | 'intentId' | 'walletId' | 'assetId' | 'units' | 'direction'> &
  Pick<FundingState, 'phase' | 'confirmedMovementId' | 'reversedUnits'> & {
    namespace: string;
    mode: FundingIntent['provider']['mode'];
    destinationRef: string;
  };
type Dispatch = Readonly<{
  action: DispatchAction;
  attemptId: string;
  claimId: string | null;
  closed: boolean;
  due: boolean;
}>;
type ClaimRow = Readonly<{
  action: DispatchAction;
  leaseUntil: Date;
  live: boolean;
  acknowledgment: string | null;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyId = '00000000-0000-0000-0000-000000000000';
const leaseSeconds = 30;
const reconcileDelaySeconds = 1;
const maxDue = 32;
const ok = <T>(value: T) => ({ kind: 'ok' as const, value });
const missing = { kind: 'not_found' } as const;
const invalid = { kind: 'invalid' } as const;
const conflict = { kind: 'conflict' } as const;
const stale = { kind: 'stale' } as const;

type Rejected = typeof missing | typeof invalid;
type BeginOutcome = Rejected | typeof conflict | Readonly<{ kind: 'created' | 'replayed'; state: FundingState }>;
type PrepareOutcome =
  | Rejected
  | Readonly<{ kind: 'complete' | 'not_ready' }>
  | Readonly<{
      kind: 'queued';
      action: DispatchAction;
      attemptId: string;
    }>;
type ClaimOutcome = Rejected | typeof stale | Readonly<{ kind: 'idle' }> | DispatchClaim;
type AcknowledgmentOutcome = Rejected | typeof stale | FundingDecision | Readonly<{ kind: 'acknowledged' }>;

function boundReference(value: string): boolean {
  return typeof value === 'string' && /^[!-~]{1,255}$/.test(value);
}

async function readIntent(
  tx: Transaction,
  bookId: string,
  intentId: string,
  lock: boolean,
): Promise<FundingState | null> {
  const { rows } = await tx.query<IntentRow>(
    `SELECT book_id AS "bookId", intent_id AS "intentId", wallet_id AS "walletId", asset_id AS "assetId", units::text,
            direction, provider_namespace AS namespace, provider_mode AS mode, destination_ref AS "destinationRef",
            phase, confirmed_movement_id AS "confirmedMovementId", reversed_units::text AS "reversedUnits"
       FROM economy.funding_intent WHERE book_id = $1 AND intent_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [bookId, intentId],
  );
  const row = rows[0];
  if (!row) return null;
  const { phase, confirmedMovementId, reversedUnits, namespace, mode, destinationRef, ...intent } = row;
  return {
    intent: { ...intent, provider: { namespace, mode, destinationRef } },
    phase,
    confirmedMovementId,
    reversedUnits,
  };
}

async function updateState(tx: Transaction, state: FundingState): Promise<void> {
  await tx.query(
    `UPDATE economy.funding_intent SET phase = $3, confirmed_movement_id = $4, reversed_units = $5
      WHERE book_id = $1 AND intent_id = $2`,
    [state.intent.bookId, state.intent.intentId, state.phase, state.confirmedMovementId, state.reversedUnits],
  );
}

async function readDispatch(tx: Transaction, bookId: string, intentId: string): Promise<Dispatch | undefined> {
  const { rows } = await tx.query<Dispatch>(
    `SELECT action, attempt_id AS "attemptId", active_claim_id AS "claimId", closed_at IS NOT NULL AS closed, due_at <= statement_timestamp() AS due
       FROM economy.funding_dispatch WHERE book_id = $1 AND intent_id = $2`,
    [bookId, intentId],
  );
  return rows[0];
}

async function readClaim(
  tx: Transaction,
  bookId: string,
  intentId: string,
  claimId: string,
): Promise<ClaimRow | undefined> {
  const { rows } = await tx.query<ClaimRow>(
    `SELECT action, lease_until AS "leaseUntil", lease_until > statement_timestamp() AS live, acknowledgment
       FROM economy.funding_dispatch_claim WHERE book_id = $1 AND intent_id = $2 AND claim_id = $3`,
    [bookId, intentId, claimId],
  );
  return rows[0];
}

function receiptValues(key: EvidenceKey): readonly string[] {
  return [key.namespace, key.mode, key.source, key.id];
}

async function readEvidence(tx: Transaction, key: EvidenceKey): Promise<EvidenceReceipt | undefined> {
  const { rows } = await tx.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM economy.funding_evidence
      WHERE provider_namespace = $1 AND provider_mode = $2 AND source_kind = $3 AND source_id = $4`,
    [...receiptValues(key)],
  );
  return rows[0] ? { key, fingerprint: rows[0].fingerprint } : undefined;
}

async function persistObservation(
  tx: Transaction,
  binder: FundingLedgerBinder,
  state: FundingState,
  observation: FundingObservation,
): Promise<FundingDecision> {
  const key = fundingEvidenceKey(observation);
  if (key && (!boundReference(key.namespace) || !boundReference(key.id))) return invalid;
  const existingReceipt = key ? await readEvidence(tx, key) : undefined;
  // Determine eligibility before touching the wallet. A chargeback's recoverable amount comes from the
  // locked position after the provider evidence key has been reserved.
  let decision = observeFunding(
    state,
    observation,
    existingReceipt ? { existingReceipt } : { recoverableWalletUnits: '0' },
  );
  if (decision.kind !== 'applied') return decision;
  const receipt = decision.receipt;
  if (receipt) {
    const { rowCount } = await tx.query(
      `INSERT INTO economy.funding_evidence
         (provider_namespace, provider_mode, source_kind, source_id, book_id, intent_id, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [...receiptValues(receipt.key), state.intent.bookId, state.intent.intentId, receipt.fingerprint],
    );
    if (rowCount === 0) {
      const duplicate = await readEvidence(tx, receipt.key);
      if (!duplicate) throw new Error('Economy provider evidence winner is unavailable in this transaction');
      return observeFunding(state, observation, { existingReceipt: duplicate });
    }
    if (observation.kind === 'chargeback') {
      const recoverableWalletUnits = await binder.recoverableWalletUnits(tx, state.intent);
      decision = observeFunding(state, observation, { recoverableWalletUnits });
      if (decision.kind !== 'applied') throw new Error('Economy binder returned an invalid chargeback position');
    }
    if (decision.effect) await binder.apply(tx, { intent: state.intent, receipt, effect: decision.effect });
  }
  await updateState(tx, decision.state);
  if (['confirmed', 'refused', 'reversed'].includes(decision.state.phase)) {
    await tx.query(
      `UPDATE economy.funding_dispatch SET closed_at = statement_timestamp()
        WHERE book_id = $1 AND intent_id = $2 AND closed_at IS NULL`,
      [state.intent.bookId, state.intent.intentId],
    );
  }
  return decision;
}

function acknowledgmentFingerprint(ack: FundingDispatchAcknowledgment): string | null {
  if (ack.kind === 'unknown') return 'unknown';
  const observation = ack.observation;
  const key = fundingEvidenceKey(observation);
  const original =
    observation.kind === 'returned' || observation.kind === 'chargeback' ? observation.originalMovementId : null;
  const operands = [
    observation.kind,
    observation.attemptId,
    observation.provider.namespace,
    observation.provider.mode,
    observation.provider.destinationRef,
    observation.assetId,
    observation.units,
    key?.id ?? null,
    original,
  ];
  return operands.every((value) => value === null || boundReference(value)) ? JSON.stringify(operands) : null;
}

function claimed(claimId: string, row: Pick<ClaimRow, 'leaseUntil' | 'action'>, attempt: Attempt): DispatchClaim {
  return { kind: 'claimed', action: row.action, attempt, claimId, leaseUntil: row.leaseUntil.toISOString() };
}

/** Trusted book owner entry. The installed transaction starts at PostgreSQL READ COMMITTED with a bounded deadline. */
export function createFundingStore(database: EconomyDatabase, bookId: string, binder: FundingLedgerBinder) {
  if (!isEconomyBookId(bookId)) throw new Error('Invalid Economy funding book');
  return {
    begin(input: FundingIntent) {
      return database.transaction<BeginOutcome>(async (tx) => {
        if (input.bookId !== bookId || !uuid.test(input.walletId) || input.walletId === emptyId) return ok(invalid);
        const normalized = { ...input, walletId: input.walletId.toLowerCase() };
        const decision = beginFunding(normalized);
        if (decision.kind !== 'created') return ok(decision);
        const { intent } = decision.state;
        const { rowCount } = await tx.query(
          `INSERT INTO economy.funding_intent (book_id, intent_id, wallet_id, asset_id, units, direction,
             provider_namespace, provider_mode, destination_ref, phase, reversed_units)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0
            WHERE EXISTS (SELECT 1 FROM economy.asset WHERE book_id = $1 AND asset_id = $4)
              AND NOT EXISTS (SELECT 1 FROM economy.asset_program WHERE book_id = $1 AND asset_id = $4)
           ON CONFLICT DO NOTHING`,
          [
            bookId,
            intent.intentId,
            intent.walletId,
            intent.assetId,
            intent.units,
            intent.direction,
            intent.provider.namespace,
            intent.provider.mode,
            intent.provider.destinationRef,
            decision.state.phase,
          ],
        );
        if (rowCount === 0) {
          const existing = await readIntent(tx, bookId, intent.intentId, true);
          return ok(existing ? beginFunding(normalized, existing) : missing);
        }
        if (!decision.reserve) return ok({ kind: 'created' as const, state: decision.state });
        const receipt = await binder.reserve(tx, decision.reserve);
        const prepared = acknowledgeWithdrawalHold(decision.state, receipt);
        if (prepared.kind !== 'applied') throw new Error('Economy binder did not protect the exact withdrawal hold');
        await updateState(tx, prepared.state);
        return ok({ kind: 'created' as const, state: prepared.state });
      });
    },

    read(intentId: string) {
      if (!isEconomyBookId(intentId)) return Promise.resolve(ok(null));
      return database.read(async (tx) => ok(await readIntent(tx, bookId, intentId, false)));
    },

    prepare(intentId: string) {
      return database.transaction<PrepareOutcome>(async (tx) => {
        if (!isEconomyBookId(intentId)) return ok(invalid);
        const state = await readIntent(tx, bookId, intentId, true);
        if (!state) return ok(missing);
        const decision = prepareFundingDispatch(state);
        if (!('attempt' in decision)) return ok(decision);
        const queued = await readDispatch(tx, bookId, intentId);
        if (queued) return ok({ kind: 'queued' as const, action: queued.action, attemptId: queued.attemptId });
        if (decision.kind !== 'submit') throw new Error('Economy prepared funding lost its dispatch intent');
        await updateState(tx, decision.state);
        await tx.query(
          `INSERT INTO economy.funding_dispatch (book_id, intent_id, attempt_id, action) VALUES ($1, $2, $3, 'submit')`,
          [bookId, intentId, decision.attempt.attemptId],
        );
        return ok({ kind: 'queued' as const, action: 'submit' as const, attemptId: decision.attempt.attemptId });
      });
    },

    due() {
      return database.read(async (tx) => {
        const { rows } = await tx.query<{ intentId: string }>(
          `SELECT intent_id AS "intentId" FROM economy.funding_dispatch
            WHERE book_id = $1 AND closed_at IS NULL AND due_at <= statement_timestamp()
            ORDER BY due_at, intent_id LIMIT $2`,
          [bookId, maxDue],
        );
        return ok(rows.map((row) => row.intentId));
      });
    },

    claim(intentId: string, token: string) {
      return database.transaction<ClaimOutcome>(async (tx) => {
        if (!isEconomyBookId(intentId) || !uuid.test(token)) return ok(invalid);
        const claimId = token.toLowerCase();
        const state = await readIntent(tx, bookId, intentId, true);
        if (!state) return ok(missing);
        const dispatch = await readDispatch(tx, bookId, intentId);
        const plan = prepareFundingDispatch(state);
        if (!dispatch || dispatch.closed || !('attempt' in plan)) return ok({ kind: 'idle' as const });
        const attempt = { attemptId: dispatch.attemptId, intent: state.intent };
        const existing = await readClaim(tx, bookId, intentId, claimId);
        if (existing) {
          return ok(
            existing.live && existing.acknowledgment === null && dispatch.claimId === claimId
              ? claimed(claimId, existing, attempt)
              : stale,
          );
        }
        if (!dispatch.due) return ok({ kind: 'idle' as const });
        // Once a submit claim has escaped, recover its stable attempt by evidence lookup.
        const action = dispatch.claimId === null ? dispatch.action : 'reconcile';
        if (action === 'reconcile') {
          const unknown = markFundingDispatchUnknown(state, dispatch.attemptId);
          if (unknown.kind === 'applied') await updateState(tx, unknown.state);
        }
        const { rows } = await tx.query<Pick<ClaimRow, 'leaseUntil' | 'action'>>(
          `INSERT INTO economy.funding_dispatch_claim (book_id, intent_id, claim_id, action, lease_until)
           VALUES ($1, $2, $3, $4, statement_timestamp() + $5 * interval '1 second')
           RETURNING action, lease_until AS "leaseUntil"`,
          [bookId, intentId, claimId, action, leaseSeconds],
        );
        await tx.query(
          `UPDATE economy.funding_dispatch SET action = $3, active_claim_id = $4,
             due_at = (SELECT lease_until FROM economy.funding_dispatch_claim WHERE book_id = $1 AND intent_id = $2 AND claim_id = $4)
            WHERE book_id = $1 AND intent_id = $2`,
          [bookId, intentId, action, claimId],
        );
        return ok(claimed(claimId, rows[0]!, attempt));
      });
    },

    acknowledge(intentId: string, token: string, acknowledgment: FundingDispatchAcknowledgment) {
      return database.transaction<AcknowledgmentOutcome>(async (tx) => {
        if (!isEconomyBookId(intentId) || !uuid.test(token)) return ok(invalid);
        const fingerprint = acknowledgmentFingerprint(acknowledgment);
        if (fingerprint === null) return ok(invalid);
        const claimId = token.toLowerCase();
        const state = await readIntent(tx, bookId, intentId, true);
        if (!state) return ok(missing);
        const row = await readClaim(tx, bookId, intentId, claimId);
        if (!row) return ok(stale);
        const done = { kind: 'acknowledged' } as const;
        if (row.acknowledgment !== null) return ok(row.acknowledgment === fingerprint ? done : conflict);
        const dispatch = await readDispatch(tx, bookId, intentId);
        if (!row.live || dispatch?.claimId !== claimId) return ok(stale);
        if (acknowledgment.kind === 'observed') {
          const outcome = await persistObservation(tx, binder, state, acknowledgment.observation);
          if (outcome.kind !== 'applied' && outcome.kind !== 'replayed' && outcome.kind !== 'unchanged')
            return ok(outcome);
        } else {
          const plan = prepareFundingDispatch(state);
          if (plan.kind === 'submit' || plan.kind === 'reconcile') {
            const unknown = markFundingDispatchUnknown(state, dispatch.attemptId);
            if (unknown.kind === 'applied') await updateState(tx, unknown.state);
          }
        }
        await tx.query(
          `UPDATE economy.funding_dispatch_claim SET acknowledgment = $4
            WHERE book_id = $1 AND intent_id = $2 AND claim_id = $3`,
          [bookId, intentId, claimId, fingerprint],
        );
        await tx.query(
          `UPDATE economy.funding_dispatch SET action = 'reconcile', active_claim_id = NULL,
                 due_at = statement_timestamp() + $3 * interval '1 second'
            WHERE book_id = $1 AND intent_id = $2 AND closed_at IS NULL`,
          [bookId, intentId, reconcileDelaySeconds],
        );
        return ok(done);
      });
    },

    observe(intentId: string, observation: FundingObservation) {
      return database.transaction<FundingDecision | typeof missing>(async (tx) => {
        if (!isEconomyBookId(intentId)) return ok(invalid);
        const state = await readIntent(tx, bookId, intentId, true);
        return ok(state ? await persistObservation(tx, binder, state, observation) : missing);
      });
    },
  };
}
