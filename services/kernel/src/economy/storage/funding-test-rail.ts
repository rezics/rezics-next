import { createHash } from 'node:crypto';
import type { FundingIntent, FundingObservation } from '../settlement/funding.ts';
import type { createFundingStore, FundingDispatchAcknowledgment } from './funding-store.ts';

type Attempt = Readonly<{ attemptId: string; intent: FundingIntent }>;
type Scenario = 'confirmed' | 'accepted_unknown' | 'refused';

function envelope({ attemptId, intent }: Attempt) {
  return { attemptId, provider: intent.provider, assetId: intent.assetId, units: intent.units };
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
  const admits = (intent: FundingIntent) => intent.provider.mode === 'test' && intent.provider.namespace === namespace;
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
      const key = createHash('sha256')
        .update(JSON.stringify([namespace, attempt.attemptId]))
        .digest('hex');
      const observation =
        outcome === 'refused'
          ? { ...envelope(attempt), kind: 'refused' as const, evidenceId: `refusal-${key}` }
          : { ...envelope(attempt), kind: 'confirmed' as const, movementId: `movement-${key}` };
      stored.set(attempt.attemptId, { fingerprint: attemptFingerprint(attempt), observation });
      return outcome === 'accepted_unknown' ? { kind: 'unknown' } : { kind: 'observed', observation };
    },
    reconcile(attempt: Attempt): FundingDispatchAcknowledgment {
      const prior = lookup(attempt);
      return { kind: 'observed', observation: prior?.observation ?? { ...envelope(attempt), kind: 'pending' } };
    },
  };
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
