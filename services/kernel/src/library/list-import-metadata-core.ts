import type {
  EntryImportMetadataConfirmation,
  EntryImportMetadataField,
  EntryImportMetadataFieldOutcome,
  EntryImportMetadataOutcome,
  EntryImportMetadataSelection,
} from './list-import-entry-metadata.ts';

export type ListImportMetadataDecision<T> = { ok: true; value: T } | { ok: false; reason: 'conflict' };

export type ListImportMetadataFenceFacts = Readonly<{
  cancelled: boolean;
  expired: boolean;
  sourceReviewMatches: boolean;
  sourceDigestMatches: boolean;
  profileMatches: boolean;
  incarnationMatches: boolean;
}>;

export type ListImportMetadataReceiptObservation = 'present' | 'missing' | 'unknown';

export type ListImportMetadataExpiredRecoveryInput = Readonly<{
  reviewToken: string;
  selections: readonly EntryImportMetadataSelection[];
  selectionDigest: string;
  confirmation?: EntryImportMetadataConfirmation;
  annotationReceipt: ListImportMetadataReceiptObservation | null;
  provenanceReceipt: ListImportMetadataReceiptObservation | null;
}>;

const terminalPhase = new Set(['applied', 'stale', 'unsupported']);
const retainedField = new Set(['stale', 'unsupported', 'failed']);

export function listImportMetadataFenceFacts(input: {
  cancelled?: boolean;
  expired?: boolean;
  currentSourceReviewToken: string | null | undefined;
  boundSourceReviewToken: string;
  currentSourceDigest: string | null | undefined;
  boundSourceDigest: string;
  currentProfileDigest: string | null | undefined;
  boundProfileDigest: string;
  currentIncarnationId: string | null | undefined;
  boundIncarnationId: string | null;
}): ListImportMetadataFenceFacts {
  return {
    cancelled: input.cancelled === true,
    expired: input.expired === true,
    sourceReviewMatches: input.currentSourceReviewToken === input.boundSourceReviewToken,
    sourceDigestMatches: input.currentSourceDigest != null && input.currentSourceDigest === input.boundSourceDigest,
    profileMatches: input.currentProfileDigest != null && input.currentProfileDigest === input.boundProfileDigest,
    incarnationMatches: input.currentIncarnationId === input.boundIncarnationId,
  };
}

export function listImportMetadataFirstPhaseEligible(facts: ListImportMetadataFenceFacts): boolean {
  return (
    !facts.cancelled &&
    !facts.expired &&
    facts.sourceReviewMatches &&
    facts.sourceDigestMatches &&
    facts.profileMatches &&
    facts.incarnationMatches
  );
}

export function listImportMetadataPhaseStart(
  current: EntryImportMetadataConfirmation,
  next: EntryImportMetadataConfirmation,
): boolean {
  return (
    (next.annotationStarted && !current.annotationStarted) || (next.provenanceStarted && !current.provenanceStarted)
  );
}

export function listImportMetadataProposedConfirmation(input: {
  fields: EntryImportMetadataConfirmation['fields'];
  selectionDigest: string;
  annotationKey: string;
  provenanceKey: string;
  nativeAdmission?: EntryImportMetadataConfirmation['nativeAdmission'];
}): EntryImportMetadataConfirmation {
  return {
    ...(input.nativeAdmission === undefined ? {} : { nativeAdmission: input.nativeAdmission }),
    fields: input.fields,
    selectionDigest: input.selectionDigest,
    annotationKey: input.annotationKey,
    provenanceKey: input.provenanceKey,
    annotationStarted: false,
    provenanceStarted: false,
  };
}

export function selectListImportMetadataConfirmation(
  current: EntryImportMetadataConfirmation | undefined,
  proposed: EntryImportMetadataConfirmation,
): ListImportMetadataDecision<EntryImportMetadataConfirmation> {
  if (!current) return { ok: true, value: proposed };
  if (current.selectionDigest !== proposed.selectionDigest) return { ok: false, reason: 'conflict' };
  return { ok: true, value: current };
}

export function confirmListImportMetadata(
  current: EntryImportMetadataConfirmation | undefined,
  proposed: EntryImportMetadataConfirmation,
  facts: ListImportMetadataFenceFacts,
): ListImportMetadataDecision<EntryImportMetadataConfirmation> {
  if (!current && !listImportMetadataFirstPhaseEligible(facts)) return { ok: false, reason: 'conflict' };
  return selectListImportMetadataConfirmation(current, proposed);
}

export function persistListImportMetadata(
  current: EntryImportMetadataConfirmation | undefined,
  next: EntryImportMetadataConfirmation,
  facts: ListImportMetadataFenceFacts,
): ListImportMetadataDecision<EntryImportMetadataConfirmation> {
  if (!current) return { ok: false, reason: 'conflict' };
  if (listImportMetadataPhaseStart(current, next) && !listImportMetadataFirstPhaseEligible(facts))
    return { ok: false, reason: 'conflict' };
  return mergeListImportMetadataConfirmation(current, next);
}

export function listImportMetadataOrConflict<T>(decision: ListImportMetadataDecision<T>, conflict: () => never): T {
  if (!decision.ok) conflict();
  return decision.value;
}

export function recoverListImportMetadataExpiredOutcome(
  input: ListImportMetadataExpiredRecoveryInput,
): ListImportMetadataDecision<EntryImportMetadataOutcome> {
  const confirmation = input.confirmation;
  if (!confirmation)
    return {
      ok: true,
      value: {
        reviewToken: input.reviewToken,
        fields: input.selections.map(({ field }) => ({ field, status: 'stale' })),
      },
    };
  if (confirmation.selectionDigest !== input.selectionDigest) return { ok: false, reason: 'conflict' };
  const old = new Map(
    (confirmation.outcome?.fields ?? confirmation.fieldOutcomes ?? []).map((field) => [field.field, field.status]),
  );
  return {
    ok: true,
    value: {
      reviewToken: input.reviewToken,
      fields: input.selections.map(({ field }) =>
        recoverExpiredField(
          field,
          confirmation,
          old.get(field),
          annotationField(field) ? input.annotationReceipt : input.provenanceReceipt,
        ),
      ),
    },
  };
}

export function mergeListImportMetadataConfirmation(
  current: EntryImportMetadataConfirmation | undefined,
  next: EntryImportMetadataConfirmation,
): ListImportMetadataDecision<EntryImportMetadataConfirmation> {
  if (!current) return { ok: true, value: next };
  if (current.selectionDigest !== next.selectionDigest) return { ok: false, reason: 'conflict' };
  for (const key of ['annotationInput', 'provenanceInput'] as const) {
    if (current[key] && next[key] && !sameOperand(current[key], next[key])) return { ok: false, reason: 'conflict' };
  }
  if (
    current.sourceObservationDigest &&
    next.sourceObservationDigest &&
    current.sourceObservationDigest !== next.sourceObservationDigest
  )
    return { ok: false, reason: 'conflict' };
  const merged: EntryImportMetadataConfirmation = {
    ...current,
    annotationStarted: current.annotationStarted || next.annotationStarted,
    provenanceStarted: current.provenanceStarted || next.provenanceStarted,
  };
  if (
    current.annotationReceiptDigest &&
    next.annotationReceiptDigest &&
    current.annotationReceiptDigest !== next.annotationReceiptDigest
  )
    return { ok: false, reason: 'conflict' };
  if (
    current.provenanceReceiptDigest &&
    next.provenanceReceiptDigest &&
    current.provenanceReceiptDigest !== next.provenanceReceiptDigest
  )
    return { ok: false, reason: 'conflict' };
  const sourceExpired = current.sourceExpired === true || next.sourceExpired === true;
  const fieldOutcomes = new Map(current.fieldOutcomes?.map((field) => [field.field, field]) ?? []);
  for (const field of next.fieldOutcomes ?? []) {
    const prior = fieldOutcomes.get(field.field);
    if (!prior || prior.status === 'failed' || prior.status === 'unattempted' || field.status === 'applied')
      fieldOutcomes.set(field.field, field);
  }
  const progress = {
    ...(sourceExpired
      ? {}
      : {
          annotationInput: current.annotationInput ?? next.annotationInput,
          provenanceInput: current.provenanceInput ?? next.provenanceInput,
          sourceObservationDigest: current.sourceObservationDigest ?? next.sourceObservationDigest,
        }),
    annotationReceiptDigest: current.annotationReceiptDigest ?? next.annotationReceiptDigest,
    provenanceReceiptDigest: current.provenanceReceiptDigest ?? next.provenanceReceiptDigest,
    provenanceKind: current.provenanceKind ?? next.provenanceKind,
    annotationStatus: mergePhaseStatus(current.annotationStatus, next.annotationStatus),
    provenanceStatus: mergePhaseStatus(current.provenanceStatus, next.provenanceStatus),
    ...(fieldOutcomes.size ? { fieldOutcomes: [...fieldOutcomes.values()] } : {}),
    outcome: current.outcome ?? next.outcome,
  };
  for (const [key, value] of Object.entries(progress)) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  if (sourceExpired) {
    delete merged.annotationInput;
    delete merged.provenanceInput;
    delete merged.sourceObservationDigest;
    merged.sourceExpired = true;
  }
  return { ok: true, value: merged };
}

function sameOperand(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergePhaseStatus(
  current: EntryImportMetadataConfirmation['annotationStatus'],
  next: EntryImportMetadataConfirmation['annotationStatus'],
): EntryImportMetadataConfirmation['annotationStatus'] {
  if (current !== undefined && terminalPhase.has(current)) return current;
  if (current === 'unattempted' && (next === undefined || next === 'unattempted')) return next;
  return next ?? current;
}

function annotationField(field: EntryImportMetadataField): boolean {
  return field === 'note' || field === 'priority';
}

function recoverExpiredField(
  field: EntryImportMetadataField,
  confirmation: EntryImportMetadataConfirmation,
  prior: EntryImportMetadataFieldOutcome['status'] | undefined,
  receipt: ListImportMetadataReceiptObservation | null,
): EntryImportMetadataFieldOutcome {
  const started = annotationField(field) ? confirmation.annotationStarted : confirmation.provenanceStarted;
  const phaseStatus = annotationField(field) ? confirmation.annotationStatus : confirmation.provenanceStatus;
  if (started && receipt === 'present') return { field, status: 'applied' };
  if (prior && retainedField.has(prior)) return { field, status: prior };
  if (phaseStatus === 'stale' || phaseStatus === 'unsupported') return { field, status: phaseStatus };
  if (started && (receipt === 'unknown' || receipt === 'missing') && prior === 'applied')
    return { field, status: 'failed' };
  if (!started && prior) return { field, status: prior };
  if (!started && phaseStatus === 'applied') return { field, status: 'applied' };
  if (!started && phaseStatus === 'unattempted') return { field, status: 'unattempted' };
  return { field, status: 'unattempted' };
}
