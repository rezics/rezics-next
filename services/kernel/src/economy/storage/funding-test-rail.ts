import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FundingIntent, FundingObservation } from '../settlement/funding.ts';
import type { createFundingStore, FundingDispatchAcknowledgment } from './funding-store.ts';

type Attempt = Readonly<{ attemptId: string; intent: FundingIntent }>;
type Scenario = 'confirmed' | 'accepted_unknown' | 'refused';
type Query = Pick<PoolClient, 'query'>;
type TestLane = Readonly<{ bookId: string; lane: string }>;

function envelope({ attemptId, intent }: Attempt) {
  return { attemptId, provider: intent.provider, assetId: intent.assetId, units: intent.units };
}

function observationFor(namespace: string, attempt: Attempt, outcome: Scenario): FundingObservation {
  const key = createHash('sha256')
    .update(JSON.stringify([namespace, attempt.attemptId]))
    .digest('hex');
  return outcome === 'refused'
    ? { ...envelope(attempt), kind: 'refused', evidenceId: `refusal-${key}` }
    : { ...envelope(attempt), kind: 'confirmed', movementId: `movement-${key}` };
}

function matchesProvider(intent: FundingIntent, namespace: string): boolean {
  return intent.provider.mode === 'test' && intent.provider.namespace === namespace;
}

function attemptFingerprint({ attemptId, intent }: Attempt): string {
  return JSON.stringify([
    attemptId,
    intent.bookId,
    intent.intentId,
    intent.walletId,
    intent.assetId,
    intent.units,
    intent.direction,
    intent.provider.namespace,
    intent.provider.mode,
    intent.provider.destinationRef,
  ]);
}

/** A process-local, deterministic stand-in for a provider. It accepts test bindings only and performs no I/O. */
export function createDeterministicFundingRail(namespace: string, scenario: (intent: FundingIntent) => Scenario) {
  const stored = new Map<string, { fingerprint: string; observation: FundingObservation }>();
  const admits = (intent: FundingIntent) => matchesProvider(intent, namespace);
  function lookup(attempt: Attempt) {
    if (!admits(attempt.intent)) throw new Error('A deterministic Economy rail requires its own test provider binding');
    const prior = stored.get(attempt.attemptId);
    if (prior && prior.fingerprint !== attemptFingerprint(attempt))
      throw new Error('Deterministic Economy rail attempt operands changed');
    return prior;
  }
  return {
    admits,
    submit(attempt: Attempt): FundingDispatchAcknowledgment {
      const prior = lookup(attempt);
      if (prior) return { kind: 'observed', observation: prior.observation };
      const outcome = scenario(attempt.intent);
      const observation = observationFor(namespace, attempt, outcome);
      stored.set(attempt.attemptId, { fingerprint: attemptFingerprint(attempt), observation });
      return outcome === 'accepted_unknown' ? { kind: 'unknown' } : { kind: 'observed', observation };
    },
    reconcile(attempt: Attempt): FundingDispatchAcknowledgment {
      const prior = lookup(attempt);
      return { kind: 'observed', observation: prior?.observation ?? { ...envelope(attempt), kind: 'pending' } };
    },
  };
}

/** The development rail always confirms. A fresh owner reproduces the same evidence for a lost claim. */
export function createConfirmedFundingTestRail(namespace: string): ReturnType<typeof createDeterministicFundingRail> {
  const admits = (intent: FundingIntent) => matchesProvider(intent, namespace);
  function confirm(attempt: Attempt): FundingDispatchAcknowledgment {
    if (!admits(attempt.intent)) throw new Error('A deterministic Economy rail requires its own test provider binding');
    return { kind: 'observed', observation: observationFor(namespace, attempt, 'confirmed') };
  }
  return { admits, submit: confirm, reconcile: confirm };
}

/** Only an already prepared, exact test intake enters this lane. The caller owns the intent lock. */
export async function enrollTestFundingLane(tx: Query, { bookId, lane }: TestLane, intentId: string) {
  const { rows } = await tx.query<{ bound: boolean }>(
    `WITH enrolled AS (
       UPDATE economy.funding_dispatch SET test_lane = $3
       WHERE book_id = $1 AND intent_id = $2 AND closed_at IS NULL AND test_lane IS NULL
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM enrolled) OR EXISTS (
       SELECT 1 FROM economy.funding_dispatch
       WHERE book_id = $1 AND intent_id = $2 AND closed_at IS NULL AND test_lane = $3
     ) AS bound`,
    [bookId, intentId, lane],
  );
  return rows[0]?.bound === true;
}

export async function dueTestFundingLane(tx: Query, { bookId, lane }: TestLane) {
  const { rows } = await tx.query<{ intentId: string }>(
    `SELECT intent_id AS "intentId" FROM economy.funding_dispatch
     WHERE book_id = $1 AND test_lane = $2 AND closed_at IS NULL AND due_at <= statement_timestamp()
     ORDER BY due_at, intent_id LIMIT 16`,
    [bookId, lane],
  );
  return rows.map(({ intentId }) => intentId);
}

export async function runDeterministicFundingDispatch(
  store: ReturnType<typeof createFundingStore>,
  rail: ReturnType<typeof createDeterministicFundingRail>,
  intentId: string,
  claimId: string,
) {
  const read = await store.read(intentId);
  if (read.kind !== 'ok') return read;
  // Test-only eligibility precedes the claim so the runner cannot change a live dispatch row.
  if (!read.value || !rail.admits(read.value.intent)) return { kind: 'test_rail_ineligible' as const };
  const claim = await store.claim(intentId, claimId);
  if (claim.kind !== 'ok' || claim.value.kind !== 'claimed') return claim;
  const { attempt, action } = claim.value;
  const response = action === 'submit' ? rail.submit(attempt) : rail.reconcile(attempt);
  return store.acknowledge(intentId, claimId, response);
}
