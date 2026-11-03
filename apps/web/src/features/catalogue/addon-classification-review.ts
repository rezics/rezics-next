import type { Release } from '@rezics/definitions';
import type { SubjectRead } from '@rezics/client';
import {
  bindClassificationReview,
  classificationAdmitted,
  classificationConfirmable,
  classificationReuseReason,
  classificationReviewableDrafts,
  focusableClassificationHolder,
  retainOrphanedClassificationDiagnostic,
  sameSealedClassification,
  selectedClassificationTarget,
  type ClassificationReuseReason,
  type RemovedHolderDiagnostic,
} from './character-classification-review';
import { classificationFields } from './character-profile-classification';
import { addonBase, addonFacts, addonType, type AddonRead } from './addon-profile';
import {
  applyReuse,
  cloneReferenceGroup,
  completeReferenceGroup,
  reuseTargetLimit,
  type ReuseSource,
} from './reference-reuse';
import type { SnakInput, StatementInput } from './statement-editor';
import {
  factHolder,
  factLocked,
  factOutcome,
  includedChanges,
  projectChangedSet,
  type ChangedFactView,
  type FactDraft,
  type FactOutcomeKind,
  type FactsCurrent,
} from './subject-facts';

export { bindClassificationReview as bindAddonClassificationReview };
export { sameSealedClassification as sameSealedAddonClassification };

export const addonClassificationGrowthSizes = [32, 64, 128] as const;
export type AddonClassificationGrowthSize = (typeof addonClassificationGrowthSizes)[number];

export type AddonClassificationCopyPlan = {
  eligible: string[];
  ineligible: { holder: string; property: string; reason: ClassificationReuseReason }[];
};

export type AddonClassificationGrowth = {
  size: AddonClassificationGrowthSize;
  holders: number;
  parts: number;
  projected: number;
  copiedHolders: number;
  copiedParts: number;
  writes: number;
  rows: FactDraft[];
  projection: ChangedFactView[];
};

const citationUrl = 'schema:url';

export function addonClassificationCurrent(
  read: Extract<AddonRead, { ok: true }>,
): FactsCurrent | { ok: false; reason: 'invalid' } {
  return addonFacts(read);
}

export function addonClassificationProperties(read: FactsCurrent): string[] {
  return classificationFields(read.release, read.public.subject.type);
}

export function addonClassificationAdmitted(read: FactsCurrent, property: string): boolean {
  return read.public.subject.type === addonType && classificationAdmitted(read, property);
}

export function addonClassificationStructuredParts(statement: StatementInput): number {
  return (
    (statement.qualifiers?.length ?? 0) +
    statement.references.reduce((count, group) => count + group.parts.length, 0)
  );
}

export function addonClassificationConfirmable(input: {
  drafts: FactDraft[];
  reviewCurrent: boolean;
  read: FactsCurrent;
  readFailed: boolean;
}): boolean {
  return classificationConfirmable({
    drafts: input.drafts,
    reviewCurrent: input.reviewCurrent,
    admitted: new Set(addonClassificationProperties(input.read).filter((property) =>
      addonClassificationAdmitted(input.read, property),
    )),
    readFailed: input.readFailed,
  });
}

/** Classification drafts never stage the add-on base relation or the suggested work identity. */
export function addonClassificationOmitsBaseRelation(draft: Pick<FactDraft, 'property' | 'statement'>): boolean {
  const target =
    draft.statement.value.type === 'value' && typeof draft.statement.value.content === 'string'
      ? draft.statement.value.content
      : '';
  return draft.property !== addonBase && target !== '';
}

export function addonClassificationLeavesBaseMembership(
  before: readonly SubjectRead['subject']['statements'][string],
  after: readonly SubjectRead['subject']['statements'][string],
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

export function addonClassificationIgnoresSuggestedWork(
  draft: FactDraft,
  workId: string | undefined,
): boolean {
  if (!workId) return true;
  const uses = (part: { value: { type: string; content?: unknown } }) =>
    part.value.type === 'value' && part.value.content === workId;
  return (
    !uses(draft.statement) &&
    !draft.statement.qualifiers?.some(uses) &&
    !draft.statement.references.some((group) => group.parts.some(uses))
  );
}

export function addonClassificationCopyPlan(
  drafts: FactDraft[],
  source: ReuseSource,
  read: FactsCurrent,
): AddonClassificationCopyPlan {
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  const group = origin?.statement.references[source.groupIndex] ?? source.snapshot;
  const eligible: string[] = [];
  const ineligible: AddonClassificationCopyPlan['ineligible'] = [];
  for (const draft of drafts) {
    const holder = factHolder(draft);
    const reason = classificationReuseReason(
      draft,
      group,
      read.release,
      source.holder,
      addonClassificationAdmitted(read, draft.property),
    );
    if (!reason) {
      if (eligible.length < reuseTargetLimit) eligible.push(holder);
      else ineligible.push({ holder, property: draft.property, reason: 'limit' });
    } else if (reason !== 'self') ineligible.push({ holder, property: draft.property, reason });
  }
  return { eligible, ineligible };
}

export function applyAddonClassificationCopy(
  drafts: FactDraft[],
  source: ReuseSource,
  selected: readonly string[],
  read: FactsCurrent,
): ReturnType<typeof applyReuse> {
  const plan = addonClassificationCopyPlan(drafts, source, read);
  const chosen = selected.filter((holder) => plan.eligible.includes(holder)).slice(0, reuseTargetLimit);
  return applyReuse(drafts, source, chosen, read.release);
}

export function addonClassificationCopyKeepsValues(before: FactDraft, after: FactDraft): boolean {
  return (
    JSON.stringify(before.statement.value) === JSON.stringify(after.statement.value) &&
    JSON.stringify(before.statement.qualifiers ?? []) === JSON.stringify(after.statement.qualifiers ?? []) &&
    before.statement.rank === after.statement.rank &&
    before.property === after.property &&
    before.source === after.source
  );
}

export function addonClassificationSelectedTarget(
  read: FactsCurrent,
  property: string,
  locale: string,
  statementId: string,
) {
  const statement = (read.public.subject.statements[property] ?? []).find((item) => item.id === statementId);
  return statement ? selectedClassificationTarget(statement, read.public.related, locale) : null;
}

export function addonClassificationResendAllowed(draft: FactDraft): boolean {
  if (draft.result?.ok) return false;
  if (!draft.command) return !draft.result;
  return !draft.result || draft.result.reason === 'uncertain' || draft.result.reason === 'unavailable';
}

export function addonClassificationCandidateRead(draft: FactDraft): string | undefined {
  return draft.result?.ok ? draft.result.candidate : undefined;
}

export function addonClassificationOutcome(draft: FactDraft, read: FactsCurrent): FactOutcomeKind | null {
  return factOutcome(draft, read);
}

export function addonClassificationReviewItems(drafts: FactDraft[]): ChangedFactView[] {
  return projectChangedSet(classificationReviewableDrafts(drafts));
}

export function addonClassificationFocus(
  holder: string,
  drafts: readonly FactDraft[],
  orphans: readonly RemovedHolderDiagnostic[],
): string | null {
  return focusableClassificationHolder(holder, drafts, orphans);
}

export function retainAddonClassificationOrphan(
  draft: FactDraft,
  previous: RemovedHolderDiagnostic[],
): RemovedHolderDiagnostic[] {
  return retainOrphanedClassificationDiagnostic(draft, previous);
}

export function withdrawnAddonClassificationBlocksIntent(read: FactsCurrent, property: string, sealed: boolean): boolean {
  if (addonClassificationAdmitted(read, property)) return false;
  return !sealed;
}

function citationPart(content: string): SnakInput {
  return { property: { id: citationUrl }, value: { type: 'value', content } };
}

export function populateAddonClassificationParts(draft: FactDraft, parts: number): FactDraft {
  const groups: { parts: SnakInput[] }[] = [];
  let remaining = Math.max(0, parts);
  while (remaining > 0 && groups.length < 16) {
    const size = Math.min(16, remaining);
    groups.push({
      parts: Array.from({ length: size }, (_, index) =>
        citationPart(`https://archive.example/addon/${groups.length}/${index}`),
      ),
    });
    remaining -= size;
  }
  return {
    ...draft,
    statement: { ...draft.statement, references: groups },
    command: undefined,
    result: undefined,
  };
}

export function addonClassificationGrowthWork(
  read: FactsCurrent,
  size: AddonClassificationGrowthSize,
  seed: (property: string) => FactDraft,
): AddonClassificationGrowth {
  const fields = addonClassificationProperties(read).slice(0, 2);
  const source = populateAddonClassificationParts(seed(fields[0]!), size);
  const destination = seed(fields[1] ?? fields[0]!);
  const drafts = fields[1] ? [source, destination] : [source];
  const group = source.statement.references[0];
  const copy =
    group && completeReferenceGroup(group) && fields[1]
      ? applyAddonClassificationCopy(
          drafts,
          {
            holder: factHolder(source),
            property: source.property,
            groupIndex: 0,
            snapshot: cloneReferenceGroup(group),
          },
          [factHolder(destination)],
          read,
        )
      : { drafts, applied: [], refused: [] };
  const projection = addonClassificationReviewItems(copy.drafts);
  const parts = copy.drafts.reduce((count, draft) => count + addonClassificationStructuredParts(draft.statement), 0);
  return {
    size,
    holders: copy.drafts.length,
    parts,
    projected: projection.length,
    copiedHolders: copy.applied.length,
    copiedParts: copy.applied.length ? (group?.parts.length ?? 0) : 0,
    writes: includedChanges(copy.drafts).length,
    rows: copy.drafts,
    projection,
  };
}

export function addonClassificationLocked(draft: FactDraft): boolean {
  return factLocked(draft);
}

export function addonClassificationReleaseFor(read: FactsCurrent): Release {
  return read.release;
}
