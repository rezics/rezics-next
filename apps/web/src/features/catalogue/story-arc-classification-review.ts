import type { Release } from '@rezics/definitions';
import type { SubjectRead } from '@rezics/client';
import type { CandidateTransport } from '../../subject/candidate-review';
import {
  classificationAdmitted,
  classificationBaselineKind,
  classificationConfirmable,
  classificationReuseReason,
  classificationReviewableDrafts,
  focusableClassificationHolder,
  retainOrphanedClassificationDiagnostic,
  sameSealedClassification,
  type ClassificationReuseReason,
  type RemovedHolderDiagnostic,
} from './character-classification-review';
import { applyReuse, cloneReferenceGroup, reuseTargetLimit, type ReuseSource } from './reference-reuse';
import { statementInput, type EditorRead, type StatementInput } from './statement-editor';
import {
  changedSetFingerprint,
  factHolder,
  factOutcome,
  includedChanges,
  projectChangedSet,
  sealFacts,
  sendFacts,
  type ChangedSetReview,
  type FactCommand,
  type FactDraft,
  type FactOutcomeKind,
  type FactResult,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';
import { storyArcFacts, storyArcType, type StoryArcRead } from './story-arc-profile';

type SelectedStatement = SubjectRead['subject']['statements'][string][number];

const correctionRank = new Set(['normal', 'preferred']);

/** Effective StoryArc classification slots; work membership never contributes a field. */
export function storyArcClassificationFields(release: Release): string[] {
  return [...new Set(release.types[storyArcType]?.properties ?? [])].filter((property) => {
    const definition = release.properties[property];
    return (
      definition?.datatype === 'wikibase-item' &&
      definition.relation?.group === 'classification' &&
      !!release.types[storyArcType]?.properties.includes(property)
    );
  });
}

/** Current classification reading is the disclosed arc. A work suggestion cannot supply this subject. */
export function storyArcClassificationCurrent(read: StoryArcRead): EditorRead {
  if (!read.ok) return read;
  const facts = storyArcFacts(read);
  if (!facts.ok) return facts;
  if (facts.public.subject.type !== storyArcType) return { ok: false, reason: 'invalid' };
  return facts;
}

export function storyArcClassificationSubject(
  read: StoryArcRead,
): { id: string; type: typeof storyArcType } | { ok: false; reason: 'invalid' } {
  const current = storyArcClassificationCurrent(read);
  if (!current.ok) return { ok: false, reason: 'invalid' };
  return { id: current.public.subject.id, type: storyArcType };
}

/** Successful reread of this arc updates the profile; a work identity or failed read cannot replace it. */
export function applyStoryArcClassificationObservation(
  current: Extract<StoryArcRead, { ok: true }>,
  next: EditorRead,
): Extract<StoryArcRead, { ok: true }> {
  if (!next.ok || !current.arc) return current;
  if (next.public.subject.id !== current.arc.subject.id) return current;
  if (next.public.subject.type !== storyArcType) return current;
  return { ...current, release: next.release, arc: next.public };
}

export function storyArcClassificationTransport(
  transport: FactsTransport,
  active: () => boolean,
  observe: (next: EditorRead) => void,
): FactsTransport {
  return {
    ...transport,
    read: async () => {
      if (!active()) throw new Error('Retired catalogue editor');
      let next: EditorRead;
      try {
        next = await transport.read();
      } catch {
        next = { ok: false, reason: 'unavailable' };
      }
      if (!active()) throw new Error('Retired catalogue editor');
      observe(next);
      return next;
    },
  };
}

/** Correction keeps preferred rank from the selected assertion; creation-only drafts stay normal. */
export function storyArcClassificationStatement(statement: SelectedStatement): StatementInput {
  const input = statementInput(statement);
  return statement.rank === 'preferred' && correctionRank.has(statement.rank) ? { ...input, rank: 'preferred' } : input;
}

export function storyArcClassificationDraft(
  read: FactsCurrent,
  property: string,
  source: string | null,
): FactDraft | null {
  if (read.public.subject.type !== storyArcType) return null;
  if (source === null && !classificationAdmitted(read, property)) return null;
  const selected = source ? read.public.subject.statements[property]?.find((item) => item.id === source) : undefined;
  if (source && !selected) return null;
  const baseline = selected ? storyArcClassificationStatement(selected) : null;
  return {
    holder: crypto.randomUUID(),
    property,
    source,
    baseline,
    included: true,
    statement: baseline
      ? structuredClone(baseline)
      : {
          property: { id: property },
          value: { type: 'value', content: '' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
  };
}

export function storyArcClassificationEvidenceParts(count: number, prefix: string): StatementInput['references'] {
  const groups: StatementInput['references'] = [];
  let remaining = count;
  while (remaining > 0) {
    const size = Math.min(16, remaining);
    groups.push({
      parts: Array.from({ length: size }, (_, index) => ({
        property: { id: 'schema:url' },
        value: { type: 'value', content: `${prefix}/${groups.length}/${index}` },
      })),
    });
    remaining -= size;
  }
  return groups;
}

export function storyArcClassificationPartCount(drafts: readonly FactDraft[]): number {
  return drafts.reduce((total, draft) => {
    const qualifiers = draft.statement.qualifiers?.length ?? 0;
    const parts = draft.statement.references.reduce((sum, group) => sum + group.parts.length, 0);
    return total + qualifiers + parts;
  }, 0);
}

export function storyArcClassificationChangedSet(drafts: FactDraft[]) {
  return projectChangedSet(classificationReviewableDrafts(drafts));
}

export function storyArcClassificationSnapshot(review: ChangedSetReview, drafts: FactDraft[]): ChangedSetReview {
  const fingerprint = changedSetFingerprint(drafts);
  if (!fingerprint) return { status: 'closed' };
  if (review.status === 'closed') return { status: 'current', fingerprint };
  if (review.status === 'stale') return review.fingerprint === fingerprint ? review : { status: 'stale', fingerprint };
  return review.fingerprint === fingerprint ? review : { status: 'stale', fingerprint };
}

export function storyArcClassificationCopyEligibility(
  target: FactDraft | undefined,
  group: { parts: StatementInput['references'][number]['parts'] },
  release: Release,
  sourceHolder: string | undefined,
  admitted: boolean,
): ClassificationReuseReason | null {
  return classificationReuseReason(target, group, release, sourceHolder, admitted);
}

export function storyArcClassificationCopyTargets(
  drafts: FactDraft[],
  source: ReuseSource,
  release: Release,
  admitted: ReadonlySet<string>,
): { holder: string; property: string; eligible: boolean; reason: ClassificationReuseReason | null }[] {
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  const group = origin?.statement.references[source.groupIndex] ?? source.snapshot;
  return drafts
    .filter((draft) => factHolder(draft) !== source.holder)
    .slice(0, reuseTargetLimit)
    .map((draft) => {
      const reason = storyArcClassificationCopyEligibility(
        draft,
        group,
        release,
        source.holder,
        admitted.has(draft.property),
      );
      return { holder: factHolder(draft), property: draft.property, eligible: reason == null, reason };
    });
}

export function copyStoryArcClassificationEvidence(
  drafts: FactDraft[],
  source: ReuseSource,
  selected: readonly string[],
  release: Release,
) {
  const origin = drafts.find((draft) => factHolder(draft) === source.holder);
  const snapshot = origin
    ? cloneReferenceGroup(origin.statement.references[source.groupIndex] ?? source.snapshot)
    : source.snapshot;
  return applyReuse(drafts, { ...source, snapshot }, selected.slice(0, reuseTargetLimit), release);
}

export function storyArcClassificationConfirmable(input: {
  drafts: FactDraft[];
  reviewCurrent: boolean;
  admitted: ReadonlySet<string>;
  readFailed: boolean;
}): boolean {
  return classificationConfirmable(input);
}

export async function sendStoryArcClassificationChanges(
  id: string,
  release: Release,
  drafts: FactDraft[],
  propose: FactsTransport['propose'],
  onResult: (property: string, result: FactResult) => void,
): Promise<FactDraft[]> {
  const sealed = sealFacts(id, release, drafts);
  await sendFacts(sealed, propose, onResult);
  return sealed;
}

/** Unknown delivery retries the original sealed body and key. A succeeded sibling is never resent. */
export function storyArcClassificationRetry(draft: FactDraft): FactCommand | undefined {
  if (!draft.command) return undefined;
  if (draft.result?.ok) return undefined;
  return draft.command;
}

export function storyArcClassificationSameUnknown(left: FactDraft, right: FactDraft): boolean {
  return sameSealedClassification(left, right);
}

/** Known acknowledgement retries only the returned candidate identity. */
export function storyArcClassificationCandidateIdentity(result: FactResult): string | null {
  return result.ok ? result.candidate : null;
}

export function storyArcClassificationProposedVisit(drafts: FactDraft[]): {
  holder: string;
  property: string;
  candidate: string;
}[] {
  return drafts.flatMap((draft) =>
    draft.result?.ok
      ? [{ holder: factHolder(draft), property: draft.property, candidate: draft.result.candidate }]
      : [],
  );
}

export function storyArcClassificationOutcome(draft: FactDraft, read: FactsCurrent): FactOutcomeKind | null {
  return factOutcome(draft, read);
}

export function storyArcClassificationBaseline(
  draft: FactDraft,
  read: FactsCurrent | { ok: false },
): ReturnType<typeof classificationBaselineKind> {
  return classificationBaselineKind(draft, read, draft.property);
}

export function storyArcClassificationFocusable(
  holder: string,
  drafts: readonly FactDraft[],
  orphans: readonly RemovedHolderDiagnostic[],
): string | null {
  return focusableClassificationHolder(holder, drafts, orphans);
}

export function storyArcClassificationRemovedDiagnostics(
  draft: FactDraft,
  previous: RemovedHolderDiagnostic[],
): RemovedHolderDiagnostic[] {
  return retainOrphanedClassificationDiagnostic(draft, previous);
}

export function storyArcClassificationAdmitted(read: FactsCurrent, property: string): boolean {
  return read.public.subject.type === storyArcType && classificationAdmitted(read, property);
}

export function storyArcClassificationWithdrawn(read: FactsCurrent, property: string, draft: FactDraft): boolean {
  return draft.property === property && !storyArcClassificationAdmitted(read, property);
}

export function measureStoryArcClassificationWork(input: {
  drafts: FactDraft[];
  release: Release;
  source?: ReuseSource;
  targets?: readonly string[];
}): { population: number; visited: number; copied: number; writes: number } {
  const projected = storyArcClassificationChangedSet(input.drafts);
  let visited = 0;
  for (const item of projected) {
    visited += 1;
    const draft = input.drafts.find((row) => factHolder(row) === item.holder);
    if (!draft) continue;
    visited += draft.statement.qualifiers?.length ?? 0;
    for (const group of draft.statement.references) visited += group.parts.length;
  }
  let copied = 0;
  let drafts = input.drafts;
  if (input.source && input.targets?.length) {
    const result = copyStoryArcClassificationEvidence(drafts, input.source, input.targets, input.release);
    copied = result.applied.length;
    drafts = result.drafts;
  }
  return {
    population: storyArcClassificationPartCount(input.drafts),
    visited,
    copied,
    writes: includedChanges(drafts).length,
  };
}

export function bindStoryArcClassificationReview(
  review: (property: string, session?: string) => CandidateTransport,
  reread: () => Promise<void>,
  live: () => boolean,
  onSelected: (property: string) => void,
): (property: string, session?: string) => CandidateTransport {
  return (property, session) => {
    const transport = review(property, session);
    return {
      ...transport,
      confirm: async (command, work) => {
        const result = await transport.confirm(command, work);
        if (result.ok && result.kind === 'selected' && live()) {
          await reread();
          if (live()) onSelected(property);
        }
        return result;
      },
    };
  };
}

export { correctionRank, reuseTargetLimit };
