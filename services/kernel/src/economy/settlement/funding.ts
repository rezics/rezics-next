import { isEconomyBookId } from '../contract.ts';
import { balancedPair, chargebackPosting, readMinorUnits, type PostingAccount, type PostingGroup } from './posting.ts';

export type ProviderBinding = Readonly<{
  /** Identifies a provider and its custody account. */
  namespace: string;
  mode: 'test' | 'live';
  destinationRef: string;
}>;

export type FundingIntent = Readonly<{
  bookId: string;
  intentId: string;
  walletId: string;
  assetId: string;
  units: string;
  direction: 'deposit' | 'withdrawal';
  provider: ProviderBinding;
}>;

export type FundingState = Readonly<{
  intent: FundingIntent;
  phase: 'awaiting_hold' | 'ready' | 'submitted' | 'unknown' | 'refused' | 'confirmed' | 'reversed';
  confirmedMovementId: string | null;
  reversedUnits: string;
}>;

type FundingAttempt = Readonly<{ attemptId: string; intent: FundingIntent }>;

type WithdrawalReservation = Readonly<{
  bookId: string;
  holdId: string;
  walletId: string;
  assetId: string;
  units: string;
}>;

type WithdrawalHoldReceipt = WithdrawalReservation & Readonly<{ protected: boolean }>;

export type FundingObservation = Readonly<{
  attemptId: string;
  provider: ProviderBinding;
  assetId: string;
  units: string;
}> &
  (
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'refused'; evidenceId: string }>
    | Readonly<{ kind: 'confirmed'; movementId: string }>
    | Readonly<{ kind: 'returned' | 'chargeback'; movementId: string; originalMovementId: string }>
  );

type RecordedObservation = Exclude<FundingObservation, { kind: 'pending' }>;

export type EvidenceKey = Readonly<{
  namespace: string;
  mode: ProviderBinding['mode'];
  source: 'movement' | 'refusal';
  id: string;
}>;

export type EvidenceReceipt = Readonly<{ key: EvidenceKey; fingerprint: string }>;

type FinancialEffect =
  | Readonly<{ kind: 'release_hold'; reservation: WithdrawalReservation }>
  | Readonly<{
      kind: 'post';
      group: PostingGroup;
      capture?: WithdrawalReservation;
      chargebackShortfall?: string;
    }>;

export type FundingDecision =
  | Readonly<{ kind: 'applied'; state: FundingState; receipt?: EvidenceReceipt; effect?: FinancialEffect }>
  | Readonly<{ kind: 'replayed' | 'unchanged' | 'conflict' | 'unrelated' | 'invalid' | 'not_ready' }>;

function validReference(reference: string): boolean {
  return typeof reference === 'string' && /^[!-~]{1,255}$/.test(reference);
}

function sameBinding(a: ProviderBinding, b: ProviderBinding): boolean {
  return a.namespace === b.namespace && a.mode === b.mode && a.destinationRef === b.destinationRef;
}

function sameIntent(a: FundingIntent, b: FundingIntent): boolean {
  return (
    a.bookId === b.bookId &&
    a.intentId === b.intentId &&
    a.walletId === b.walletId &&
    a.assetId === b.assetId &&
    a.units === b.units &&
    a.direction === b.direction &&
    sameBinding(a.provider, b.provider)
  );
}

function attemptId(intent: FundingIntent): string {
  return `funding/${intent.bookId}/${intent.intentId}`;
}

function withdrawalReservation(intent: FundingIntent): WithdrawalReservation {
  return {
    bookId: intent.bookId,
    holdId: attemptId(intent),
    walletId: intent.walletId,
    assetId: intent.assetId,
    units: intent.units,
  };
}

export function beginFunding(
  intent: FundingIntent,
  existing?: FundingState,
):
  | Readonly<{ kind: 'created'; state: FundingState; reserve?: WithdrawalReservation }>
  | Readonly<{ kind: 'replayed'; state: FundingState }>
  | Readonly<{ kind: 'invalid' | 'conflict' }> {
  const units = readMinorUnits(intent.units);
  if (
    units === null ||
    units === 0n ||
    !isEconomyBookId(intent.bookId) ||
    !isEconomyBookId(intent.intentId) ||
    !validReference(intent.walletId) ||
    !validReference(intent.assetId) ||
    !validReference(intent.provider.namespace) ||
    !validReference(intent.provider.destinationRef) ||
    !['test', 'live'].includes(intent.provider.mode) ||
    !['deposit', 'withdrawal'].includes(intent.direction)
  )
    return { kind: 'invalid' };
  if (existing) {
    return sameIntent(existing.intent, intent) ? { kind: 'replayed', state: existing } : { kind: 'conflict' };
  }
  const immutableIntent = Object.freeze({ ...intent, provider: Object.freeze({ ...intent.provider }) });
  const withdrawal = immutableIntent.direction === 'withdrawal';
  const state: FundingState = {
    intent: immutableIntent,
    phase: withdrawal ? 'awaiting_hold' : 'ready',
    confirmedMovementId: null,
    reversedUnits: '0',
  };
  return withdrawal
    ? { kind: 'created', state, reserve: withdrawalReservation(immutableIntent) }
    : { kind: 'created', state };
}

export function acknowledgeWithdrawalHold(state: FundingState, receipt: WithdrawalHoldReceipt): FundingDecision {
  const expected = withdrawalReservation(state.intent);
  if (
    state.intent.direction !== 'withdrawal' ||
    !receipt.protected ||
    receipt.bookId !== expected.bookId ||
    receipt.holdId !== expected.holdId ||
    receipt.walletId !== expected.walletId ||
    receipt.assetId !== expected.assetId ||
    receipt.units !== expected.units
  )
    return { kind: 'conflict' };
  if (state.phase !== 'awaiting_hold') return { kind: 'replayed' };
  return { kind: 'applied', state: { ...state, phase: 'ready' } };
}

/** Persist the submit transition and its outbox action together before contacting the rail. */
export function prepareFundingDispatch(
  state: FundingState,
):
  | Readonly<{ kind: 'submit' | 'reconcile'; state: FundingState; attempt: FundingAttempt }>
  | Readonly<{ kind: 'not_ready' | 'complete' }> {
  const attempt = { attemptId: attemptId(state.intent), intent: state.intent };
  switch (state.phase) {
    case 'awaiting_hold':
      return { kind: 'not_ready' };
    case 'ready':
      return { kind: 'submit', state: { ...state, phase: 'submitted' }, attempt };
    case 'submitted':
    case 'unknown':
      return { kind: 'reconcile', state, attempt };
    case 'refused':
    case 'confirmed':
    case 'reversed':
      return { kind: 'complete' };
  }
}

export function markFundingDispatchUnknown(state: FundingState, submittedAttemptId: string): FundingDecision {
  if (submittedAttemptId !== attemptId(state.intent)) return { kind: 'unrelated' };
  if (state.phase === 'awaiting_hold' || state.phase === 'ready') return { kind: 'not_ready' };
  return state.phase === 'submitted'
    ? { kind: 'applied', state: { ...state, phase: 'unknown' } }
    : { kind: 'unchanged' };
}

export function fundingEvidenceKey(observation: RecordedObservation): EvidenceKey;
export function fundingEvidenceKey(observation: FundingObservation): EvidenceKey | null;
export function fundingEvidenceKey(observation: FundingObservation): EvidenceKey | null {
  if (observation.kind === 'pending') return null;
  return {
    namespace: observation.provider.namespace,
    mode: observation.provider.mode,
    source: observation.kind === 'refused' ? 'refusal' : 'movement',
    id: observation.kind === 'refused' ? observation.evidenceId : observation.movementId,
  };
}

function evidenceFingerprint(observation: RecordedObservation): string {
  const original =
    observation.kind === 'returned' || observation.kind === 'chargeback' ? observation.originalMovementId : null;
  return JSON.stringify([
    observation.kind,
    observation.attemptId,
    observation.provider.destinationRef,
    observation.assetId,
    observation.units,
    original,
  ]);
}

/** The store reads the global provider evidence key and commits state, receipt, and effects under one book lock. */
export function observeFunding(
  state: FundingState,
  observation: FundingObservation,
  context: Readonly<{ existingReceipt?: EvidenceReceipt; recoverableWalletUnits?: string }> = {},
): FundingDecision {
  const intent = state.intent;
  if (
    observation.attemptId !== attemptId(intent) ||
    !sameBinding(observation.provider, intent.provider) ||
    observation.assetId !== intent.assetId
  )
    return { kind: 'unrelated' };
  const units = readMinorUnits(observation.units);
  if (units === null || units === 0n) return { kind: 'invalid' };
  const hasAttempt = state.phase !== 'awaiting_hold' && state.phase !== 'ready';
  const unsettled = state.phase === 'submitted' || state.phase === 'unknown';
  if (observation.kind === 'pending') {
    if (observation.units !== intent.units) return { kind: 'invalid' };
    return markFundingDispatchUnknown(state, observation.attemptId);
  }

  const key = fundingEvidenceKey(observation);
  if (!validReference(key.id)) return { kind: 'invalid' };
  const receipt = { key, fingerprint: evidenceFingerprint(observation) };
  const existing = context.existingReceipt;
  if (existing) {
    const prior = existing.key;
    return prior.namespace === key.namespace &&
      prior.mode === key.mode &&
      prior.source === key.source &&
      prior.id === key.id &&
      existing.fingerprint === receipt.fingerprint
      ? { kind: 'replayed' }
      : { kind: 'conflict' };
  }
  if (!hasAttempt) return { kind: 'not_ready' };
  if (observation.kind === 'returned' || observation.kind === 'chargeback') {
    return reverseFunding(state, observation, receipt, units, context.recoverableWalletUnits);
  }
  if (!unsettled || observation.units !== intent.units) return { kind: 'conflict' };
  const withdrawal = intent.direction === 'withdrawal';
  if (observation.kind === 'refused') {
    return {
      kind: 'applied',
      state: { ...state, phase: 'refused' },
      receipt,
      ...(withdrawal ? { effect: { kind: 'release_hold', reservation: withdrawalReservation(intent) } } : {}),
    };
  }
  const wallet: PostingAccount = { role: 'wallet', id: intent.walletId };
  const clearing = providerClearing(intent.provider);
  return {
    kind: 'applied',
    state: { ...state, phase: 'confirmed', confirmedMovementId: observation.movementId },
    receipt,
    effect: {
      kind: 'post',
      group: balancedPair(intent.assetId, intent.units, withdrawal ? wallet : clearing, withdrawal ? clearing : wallet),
      ...(withdrawal ? { capture: withdrawalReservation(intent) } : {}),
    },
  };
}

function providerClearing(binding: ProviderBinding): PostingAccount {
  return { role: 'provider_clearing', id: `${binding.mode}/${binding.namespace}` };
}

function reverseFunding(
  state: FundingState,
  observation: Extract<FundingObservation, { kind: 'returned' | 'chargeback' }>,
  receipt: EvidenceReceipt,
  units: bigint,
  recoverableUnits: string | undefined,
): FundingDecision {
  const intent = state.intent;
  const withdrawal = intent.direction === 'withdrawal';
  if (observation.kind !== (withdrawal ? 'returned' : 'chargeback')) return { kind: 'conflict' };
  if (state.phase === 'submitted' || state.phase === 'unknown') return { kind: 'not_ready' };
  if (
    state.phase !== 'confirmed' ||
    !state.confirmedMovementId ||
    observation.originalMovementId !== state.confirmedMovementId ||
    observation.movementId === state.confirmedMovementId
  )
    return { kind: 'conflict' };
  const total = BigInt(state.reversedUnits) + units;
  const original = BigInt(intent.units);
  if (total > original) return { kind: 'conflict' };
  const next = {
    ...state,
    phase: total === original ? ('reversed' as const) : ('confirmed' as const),
    reversedUnits: String(total),
  };
  const clearing = providerClearing(intent.provider);
  if (withdrawal) {
    return {
      kind: 'applied',
      state: next,
      receipt,
      effect: {
        kind: 'post',
        group: balancedPair(intent.assetId, observation.units, clearing, { role: 'wallet', id: intent.walletId }),
      },
    };
  }
  const recoverable = recoverableUnits === undefined ? null : readMinorUnits(recoverableUnits);
  if (recoverable === null) return { kind: 'not_ready' };
  const { group, shortfall } = chargebackPosting({
    assetId: intent.assetId,
    walletId: intent.walletId,
    clearingId: clearing.id,
    units,
    recoverable,
  });
  return {
    kind: 'applied',
    state: next,
    receipt,
    effect: { kind: 'post', group, ...(shortfall === '0' ? {} : { chargebackShortfall: shortfall }) },
  };
}
