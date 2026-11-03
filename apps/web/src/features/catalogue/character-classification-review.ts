import type { Release } from '@rezics/definitions';
import { pageText } from '../pages/data';
import { previewReuse, type ReusePreview, type ReuseRefusal } from './reference-reuse';
import type { StatementInput } from './statement-editor';
import {
  factChanged,
  factHolder,
  factLocked,
  factOutcome,
  factWritable,
  includedChanges,
  type ChangedFactView,
  type FactDraft,
  type FactOutcomeKind,
  type FactsCurrent,
} from './subject-facts';

export type ClassificationReuseReason = ReuseRefusal | 'retired' | 'succeeded' | 'uncertain';
export type RemovedHolderDiagnostic = {
  holder: string;
  property: string;
  errors: { pointer: string; code: string }[];
};
export type SelectedClassificationTarget = {
  id: string;
  source: string;
  label: string;
  lang?: string;
  state: 'available' | 'unlabelled' | 'hidden';
};
export type ClassificationBaselineKind = 'current' | 'absent' | 'withdrawn' | 'unread';

export function hasAuthoredClassificationContent(statement: StatementInput): boolean {
  const populated = (part: { value: { type: string; content?: unknown } }) =>
    part.value.type !== 'value' || hasContent(part.value.content);
  return (
    populated(statement) ||
    statement.qualifiers?.some(populated) === true ||
    statement.references.some((reference) => reference.parts.some(populated))
  );
}

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim();
  if (value == null) return false;
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return true;
}

export function classificationNeedsDeparture(draft: FactDraft | undefined): boolean {
  return (
    !!draft &&
    !draft.result?.ok &&
    ((factChanged(draft) && (draft.baseline !== null || hasAuthoredClassificationContent(draft.statement))) ||
      (!!draft.command &&
        (!draft.result ||
          (!draft.result.ok && (draft.result.reason === 'uncertain' || draft.result.reason === 'unavailable')))))
  );
}

/** Selected identity comes from the current related map, never a search title or route value. */
export function selectedClassificationTarget(
  statement: { id: string; value: { type: string; content?: unknown } },
  related: FactsCurrent['public']['related'],
  locale: string,
): SelectedClassificationTarget {
  const id = statement.value.type === 'value' && typeof statement.value.content === 'string' ? statement.value.content : '';
  if (!id)
    return { id: '', source: statement.id, label: '', state: 'hidden' };
  if (!Object.hasOwn(related, id)) return { id, source: statement.id, label: '', state: 'hidden' };
  const label = pageText(related[id]?.labels, locale);
  return {
    id,
    source: statement.id,
    label: label.text,
    ...(label.lang ? { lang: label.lang } : {}),
    state: label.text ? 'available' : 'unlabelled',
  };
}

export function selectedClassificationTargets(read: FactsCurrent, property: string, locale: string): SelectedClassificationTarget[] {
  return (read.public.subject.statements[property] ?? []).map((statement) =>
    selectedClassificationTarget(statement, read.public.related, locale),
  );
}

export function retainedClassificationSiblings(read: FactsCurrent, draft: Pick<FactDraft, 'property' | 'source'>): string[] {
  return (read.public.subject.statements[draft.property] ?? [])
    .map((statement) => statement.id)
    .filter((id) => id !== draft.source);
}

export function classificationBaselineKind(
  item: Pick<ChangedFactView, 'source' | 'baseline'>,
  read: FactsCurrent | { ok: false },
  property: string,
): ClassificationBaselineKind {
  if (!('ok' in read) || !read.ok) return 'unread';
  if (!item.source || item.baseline === null) return 'absent';
  const selected = read.public.subject.statements[property] ?? [];
  return selected.some((statement) => statement.id === item.source) ? 'current' : 'withdrawn';
}

export function previewClassificationReuse(
  target: FactDraft | undefined,
  group: { parts: StatementInput['references'][number]['parts'] },
  release: Release,
  sourceHolder: string | undefined,
  admitted: boolean,
): ReusePreview {
  if (!target) return { ok: false, reason: 'missing' };
  if (!admitted) return { ok: false, reason: 'definition' };
  if (target.result?.ok) return { ok: false, reason: 'locked' };
  return previewReuse(target, group, release, sourceHolder);
}

export function classificationReuseReason(
  target: FactDraft | undefined,
  group: { parts: StatementInput['references'][number]['parts'] },
  release: Release,
  sourceHolder: string | undefined,
  admitted: boolean,
): ClassificationReuseReason | null {
  if (!target) return 'missing';
  if (sourceHolder && factHolder(target) === sourceHolder) return 'self';
  if (!admitted) return 'retired';
  if (target.result?.ok) return 'succeeded';
  if (factLocked(target) || !factWritable(target))
    return target.result && !target.result.ok && (target.result.reason === 'uncertain' || target.result.reason === 'unavailable')
      ? 'uncertain'
      : 'locked';
  const preview = previewReuse(target, group, release, sourceHolder);
  return preview.ok ? null : preview.reason;
}

export function classificationAdmitted(read: FactsCurrent, property: string): boolean {
  const definition = read.release.properties[property];
  return (
    !!definition &&
    definition.datatype === 'wikibase-item' &&
    definition.relation?.group === 'classification' &&
    !!read.release.types[read.public.subject.type]?.properties.includes(property)
  );
}

export function retainOrphanedClassificationDiagnostic(
  draft: FactDraft,
  previous: RemovedHolderDiagnostic[],
): RemovedHolderDiagnostic[] {
  const result = draft.result;
  if (!result || result.ok || result.reason !== 'invalid' || !result.errors?.length) return previous;
  const holder = factHolder(draft);
  return [
    ...previous.filter((item) => item.holder !== holder),
    { holder, property: draft.property, errors: result.errors.map((error) => ({ pointer: error.pointer, code: error.code })) },
  ];
}

export function focusableClassificationHolder(
  holder: string,
  drafts: readonly FactDraft[],
  orphans: readonly RemovedHolderDiagnostic[],
): string | null {
  if (orphans.some((item) => item.holder === holder) && !drafts.some((draft) => factHolder(draft) === holder))
    return null;
  return drafts.some((draft) => factHolder(draft) === holder) ? holder : null;
}

export function classificationConfirmable(input: {
  drafts: FactDraft[];
  reviewCurrent: boolean;
  admitted: ReadonlySet<string>;
  readFailed: boolean;
}): boolean {
  const changed = includedChanges(input.drafts);
  if (!changed.length) return false;
  const fresh = changed.filter((draft) => !draft.command);
  if (input.readFailed && fresh.length) return false;
  if (fresh.some((draft) => !input.admitted.has(draft.property))) return false;
  if (fresh.length && !input.reviewCurrent) return false;
  return true;
}

export function classificationReviewableDrafts(drafts: FactDraft[]): FactDraft[] {
  return includedChanges(drafts).filter((draft) => !factLocked(draft) || !!draft.command);
}

export function classificationRetainedOutcomes(drafts: FactDraft[], read: FactsCurrent): FactDraft[] {
  return drafts.filter((draft) => {
    const kind = factOutcome(draft, read);
    return kind === 'proposed' || kind === 'selected' || kind === 'uncertain';
  });
}

export function classificationOutcomeKind(draft: FactDraft, read: FactsCurrent): FactOutcomeKind | null {
  return factOutcome(draft, read);
}

export function sameSealedClassification(left: FactDraft, right: FactDraft): boolean {
  return left.command === right.command && left.command !== undefined;
}
