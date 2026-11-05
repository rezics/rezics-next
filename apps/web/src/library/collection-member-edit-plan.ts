import type { CollectionMember, CollectionVisibility } from './reads';

export type CollectionMemberEditOperation =
  | { kind: 'move'; memberId: string; after: string | null }
  | { kind: 'note'; memberId: string; note: string | null }
  | { kind: 'remove'; memberId: string };

/** Bounded per-member writes derived from the loaded page only; the native API still owns each CAS and receipt. */
export function buildCollectionMemberEditPlan(
  initial: readonly CollectionMember[],
  desired: readonly CollectionMember[],
  firstPage: boolean,
): CollectionMemberEditOperation[] {
  if (initial.length > 100 || desired.length > 100) throw new RangeError('Collection edit selection exceeds one page');
  const initialIds = new Set(initial.map((member) => member.id));
  const desiredIds = new Set(desired.map((member) => member.id));
  if (
    initialIds.size !== initial.length ||
    desiredIds.size !== desired.length ||
    desired.some((member) => !initialIds.has(member.id))
  )
    throw new RangeError('Collection edits must name distinct loaded occurrences');
  if (!firstPage && desired.length && desired[0]?.id !== initial.find((member) => desiredIds.has(member.id))?.id)
    throw new RangeError('A later page cannot move a member before its loaded boundary');

  const operations: CollectionMemberEditOperation[] = [];
  for (const member of initial) {
    if (!desiredIds.has(member.id)) operations.push({ kind: 'remove', memberId: member.id });
  }

  const initialById = new Map(initial.map((member) => [member.id, member]));
  for (const member of desired) {
    const original = initialById.get(member.id);
    if (original && original.note !== member.note) {
      operations.push({ kind: 'note', memberId: member.id, note: member.note });
    }
  }

  const working = initial.filter((member) => desiredIds.has(member.id));
  const target = desired.filter((member) => initialById.has(member.id));
  for (let index = 0; index < target.length; index++) {
    if (working[index]?.id === target[index]!.id) continue;
    if (index === 0 && !firstPage) continue;
    const member = target[index]!;
    const after = index === 0 ? null : target[index - 1]!.id;
    operations.push({ kind: 'move', memberId: member.id, after });
    const from = working.findIndex((item) => item.id === member.id);
    if (from < 0) continue;
    working.splice(from, 1);
    working.splice(index, 0, member);
  }
  return operations;
}

/** Applies independently receipted native writes in order and stops at the first refusal. */
export async function applyCollectionMemberEditPlan(
  operations: readonly CollectionMemberEditOperation[],
  write: (operation: CollectionMemberEditOperation) => Promise<{ ok: true } | { ok: false; reason: string }>,
): Promise<{ completed: number; failed?: { operation: CollectionMemberEditOperation; reason: string } }> {
  if (operations.length > 299) throw new RangeError('Collection edit plan exceeds its per-page bound');
  let completed = 0;
  for (const operation of operations) {
    const result = await write(operation).catch(() => ({ ok: false as const, reason: 'unavailable' }));
    if (!result.ok) return { completed, failed: { operation, reason: result.reason } };
    completed += 1;
  }
  return { completed };
}

export type CollectionMetadataSnapshot = {
  title: string;
  description: string | null;
  visibility: CollectionVisibility | null;
  presentationKind: string | null;
  coverMediaId: string | null;
};

export type CollectionMetadataField = keyof CollectionMetadataSnapshot;

export type CollectionMetadataChange = {
  field: CollectionMetadataField;
  before: string | null;
  after: string | null;
};

/** Keeps the exact loaded occurrence identity and both sides of the reviewed change. */
export type ReviewedCollectionMemberOperation = {
  id: string;
  operation: CollectionMemberEditOperation;
  beforePosition: number;
  afterPosition: number | null;
  beforeAnchorId: string | null;
  afterAnchorId: string | null;
  beforeNote: string | null;
  afterNote: string | null;
};

export type CollectionSavePlanStep =
  | { id: 'remove-batch'; kind: 'remove-batch'; operations: readonly ReviewedCollectionMemberOperation[] }
  | { id: 'metadata'; kind: 'metadata'; changes: readonly CollectionMetadataChange[] }
  | {
      id: 'transfer';
      kind: 'transfer';
      sourceTitle: string;
      destinationTitle: string;
      memberIds: readonly string[];
      after: string | null;
    }
  | { id: string; kind: 'member'; operation: ReviewedCollectionMemberOperation };

export type CollectionTransferReviewSnapshot = {
  sourceTitle: string;
  destinationTitle: string;
  memberIds: readonly string[];
  after: string | null;
};

export type CollectionSaveReviewPlan = {
  collectionId: string;
  revision: number;
  firstPage: boolean;
  before: CollectionMetadataSnapshot;
  after: CollectionMetadataSnapshot;
  metadataChanges: readonly CollectionMetadataChange[];
  operations: readonly ReviewedCollectionMemberOperation[];
  steps: readonly CollectionSavePlanStep[];
  usesBatchRemoval: boolean;
  metadataCommandRequired: boolean;
};

export type CollectionSaveReviewPlanInput = {
  collectionId: string;
  revision: number;
  firstPage: boolean;
  initial: readonly CollectionMember[];
  desired: readonly CollectionMember[];
  before: CollectionMetadataSnapshot;
  after: CollectionMetadataSnapshot;
  batchRemovalIds?: ReadonlySet<string>;
  transfer?: CollectionTransferReviewSnapshot | null;
};

const metadataFields: readonly CollectionMetadataField[] = [
  'title',
  'description',
  'visibility',
  'presentationKind',
  'coverMediaId',
];

function metadataChanges(
  before: CollectionMetadataSnapshot,
  after: CollectionMetadataSnapshot,
): CollectionMetadataChange[] {
  return metadataFields.flatMap((field) => {
    const previous = before[field];
    const next = after[field];
    return previous === next ? [] : [{ field, before: previous, after: next }];
  });
}

function reviewOperation(
  operation: CollectionMemberEditOperation,
  initial: readonly CollectionMember[],
  desired: readonly CollectionMember[],
): ReviewedCollectionMemberOperation {
  const beforeIndex = initial.findIndex((member) => member.id === operation.memberId);
  const afterIndex = desired.findIndex((member) => member.id === operation.memberId);
  if (beforeIndex < 0) throw new RangeError('Collection operation must name a loaded occurrence');
  const beforeMember = initial[beforeIndex]!;
  const afterMember = afterIndex < 0 ? undefined : desired[afterIndex];
  const beforeAnchorId = beforeIndex > 0 ? initial[beforeIndex - 1]!.id : null;
  const afterAnchorId =
    operation.kind === 'move' ? operation.after : afterIndex > 0 ? desired[afterIndex - 1]!.id : null;
  return {
    id: `${operation.kind}:${operation.memberId}`,
    operation,
    beforePosition: beforeIndex + 1,
    afterPosition: afterIndex < 0 ? null : afterIndex + 1,
    beforeAnchorId,
    afterAnchorId,
    beforeNote: beforeMember.note,
    afterNote: operation.kind === 'note' ? operation.note : (afterMember?.note ?? null),
  };
}

/**
 * Creates the visible review and the executor's ordered command list from the same bounded member plan.
 * Batch removal preserves its native first-CAS behavior; single removals follow the existing metadata step.
 */
export function buildCollectionSaveReviewPlan(input: CollectionSaveReviewPlanInput): CollectionSaveReviewPlan {
  const rawOperations = buildCollectionMemberEditPlan(input.initial, input.desired, input.firstPage);
  const operations = rawOperations.map((operation) => reviewOperation(operation, input.initial, input.desired));
  const removals = operations.filter((entry) => entry.operation.kind === 'remove');
  const usesBatchRemoval =
    removals.length > 1 || removals.some((entry) => input.batchRemovalIds?.has(entry.operation.memberId));
  const metadataChangesList = metadataChanges(input.before, input.after);
  const hasNonRemoval = operations.some((entry) => entry.operation.kind !== 'remove');
  const metadataCommandRequired =
    metadataChangesList.length > 0 || hasNonRemoval || (!usesBatchRemoval && removals.length > 0);
  const steps: CollectionSavePlanStep[] = [];

  if (usesBatchRemoval) steps.push({ id: 'remove-batch', kind: 'remove-batch', operations: removals });
  if (metadataCommandRequired) steps.push({ id: 'metadata', kind: 'metadata', changes: metadataChangesList });
  if (input.transfer) steps.push({ id: 'transfer', kind: 'transfer', ...input.transfer });

  for (const entry of operations) {
    if (entry.operation.kind === 'remove' && usesBatchRemoval) continue;
    steps.push({ id: entry.id, kind: 'member', operation: entry });
  }

  return {
    collectionId: input.collectionId,
    revision: input.revision,
    firstPage: input.firstPage,
    before: { ...input.before },
    after: { ...input.after },
    metadataChanges: metadataChangesList,
    operations,
    steps,
    usesBatchRemoval,
    metadataCommandRequired,
  };
}

export type CollectionSaveOutcomeStatus = 'not-sent' | 'pending' | 'confirmed' | 'unknown' | 'refused' | 'conflict';

export type CollectionSaveStepOutcome = {
  stepId: string;
  status: CollectionSaveOutcomeStatus;
  reason?: string;
  targetId?: string;
  revision?: number;
  destinationRevision?: number;
  undo?: readonly { collectionId: string; memberId: string; deletionId: string; revision: number }[];
};

export function initialCollectionSaveOutcomes(plan: CollectionSaveReviewPlan): CollectionSaveStepOutcome[] {
  return plan.steps.map((step) => ({ stepId: step.id, status: 'not-sent' }));
}

/** A native unavailable result is ambiguous; every other refusal is definitive. */
export function collectionSaveOutcomeStatus(reason: string): 'unknown' | 'conflict' | 'refused' {
  if (reason === 'unavailable') return 'unknown';
  if (reason === 'conflict') return 'conflict';
  return 'refused';
}

/** Returns only the next original command. Confirmed operations are never put back in the send queue. */
export function nextCollectionSaveStepIndex(outcomes: readonly CollectionSaveStepOutcome[]): number | null {
  for (let index = 0; index < outcomes.length; index++) {
    const status = outcomes[index]!.status;
    if (status === 'confirmed') continue;
    if (status === 'unknown' || (status === 'not-sent' && !outcomes[index]!.reason)) return index;
    return null;
  }
  return null;
}

export function collectionSaveIsComplete(outcomes: readonly CollectionSaveStepOutcome[]): boolean {
  return outcomes.every((outcome) => outcome.status === 'confirmed');
}

export function collectionSaveHasUnknown(outcomes: readonly CollectionSaveStepOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.status === 'unknown' || outcome.status === 'pending');
}

/** Advances the one captured page plan; confirmed steps are skipped and a refusal stops its unsent remainder. */
export async function runCollectionSaveSteps(
  steps: readonly CollectionSavePlanStep[],
  outcomes: CollectionSaveStepOutcome[],
  execute: (step: CollectionSavePlanStep, index: number) => Promise<CollectionSaveStepOutcome | null>,
  onChange: (outcomes: readonly CollectionSaveStepOutcome[]) => void,
): Promise<{ complete: boolean; stoppedAt: number | null }> {
  if (steps.length > 301 || outcomes.length !== steps.length)
    throw new RangeError('Collection save review exceeds its loaded-page bound');
  for (let index = 0; index < steps.length; index++) {
    if (outcomes[index]!.stepId !== steps[index]!.id)
      throw new RangeError('Collection save outcomes must match the captured plan');
  }

  let index = nextCollectionSaveStepIndex(outcomes);
  while (index !== null) {
    const step = steps[index];
    if (!step) throw new RangeError('Collection save outcome has no captured operation');
    outcomes[index] = { stepId: step.id, status: 'pending' };
    onChange(outcomes.map((outcome) => ({ ...outcome })));
    let settled: CollectionSaveStepOutcome | null;
    try {
      settled = await execute(step, index);
    } catch {
      settled = { stepId: step.id, status: 'unknown', reason: 'unavailable' };
    }
    if (settled === null) return { complete: false, stoppedAt: index };
    if (settled.stepId !== step.id) throw new RangeError('Native result belongs to a different captured operation');
    outcomes[index] = settled;
    onChange(outcomes.map((outcome) => ({ ...outcome })));
    if (settled.status !== 'confirmed') return { complete: false, stoppedAt: index };
    index = nextCollectionSaveStepIndex(outcomes);
  }
  return { complete: collectionSaveIsComplete(outcomes), stoppedAt: null };
}

export function remainingCollectionMemberOperations(
  plan: CollectionSaveReviewPlan,
  outcomes: readonly CollectionSaveStepOutcome[],
): ReviewedCollectionMemberOperation[] {
  const statusByStep = new Map(outcomes.map((outcome) => [outcome.stepId, outcome.status]));
  return plan.steps.flatMap((step) => {
    if (statusByStep.get(step.id) === 'confirmed') return [];
    return step.kind === 'member' ? [step.operation] : step.kind === 'remove-batch' ? [...step.operations] : [];
  });
}

export type CollectionDraftRebaseResult =
  | { ok: true; members: CollectionMember[] }
  | { ok: false; operation: ReviewedCollectionMemberOperation; reason: 'member-missing' | 'anchor-missing' };

/**
 * Applies only refused and not-sent member intent to an explicitly accepted current page.
 * Anchor IDs are native occurrence references; no page rank or global position is inferred.
 */
export function rebaseRemainingCollectionDraft(
  basis: readonly CollectionMember[],
  operations: readonly ReviewedCollectionMemberOperation[],
  firstPage: boolean,
): CollectionDraftRebaseResult {
  if (basis.length > 100) throw new RangeError('Collection edit selection exceeds one page');
  const members = [...basis];
  for (const entry of operations) {
    const operation = entry.operation;
    const memberIndex = members.findIndex((member) => member.id === operation.memberId);
    if (memberIndex < 0) return { ok: false, operation: entry, reason: 'member-missing' };
    if (operation.kind === 'remove') {
      members.splice(memberIndex, 1);
      continue;
    }
    if (operation.kind === 'note') {
      members[memberIndex] = { ...members[memberIndex]!, note: operation.note };
      continue;
    }
    if (operation.after === null) {
      if (!firstPage) return { ok: false, operation: entry, reason: 'anchor-missing' };
      const [member] = members.splice(memberIndex, 1);
      members.unshift(member!);
      continue;
    }
    const anchorIndex = members.findIndex((member) => member.id === operation.after);
    if (anchorIndex < 0 || operation.after === operation.memberId)
      return { ok: false, operation: entry, reason: 'anchor-missing' };
    const [member] = members.splice(memberIndex, 1);
    const stableAnchorIndex = members.findIndex((candidate) => candidate.id === operation.after);
    if (stableAnchorIndex < 0) return { ok: false, operation: entry, reason: 'anchor-missing' };
    members.splice(stableAnchorIndex + 1, 0, member!);
  }
  return { ok: true, members };
}
