import { subjectLabelInputIssue, type SubjectLabelInputIssue } from './subject-label-input.ts';
import { normalizeLibraryLabelName } from './subject-label-name';

export type RuleLabelPrefix = { ok: true; query: string } | { ok: false; issue: SubjectLabelInputIssue };

/** Keep the raw 1,000-unit action bound independent of the native normalized 100-scalar prefix. */
export function collectionRuleLabelPrefix(raw: string): RuleLabelPrefix {
  const issue = subjectLabelInputIssue(raw, true);
  return issue ? { ok: false, issue } : { ok: true, query: normalizeLibraryLabelName(raw) };
}

/** Shared action/read admission; only the lookup copy is normalized. */
export function validateRuleLabelPage(input: unknown): { q: string; cursor?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid label page');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== 'q' && key !== 'cursor') ||
    (value.q !== undefined && typeof value.q !== 'string') ||
    (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096))
  )
    throw new Error('Invalid label page');
  const prefix = collectionRuleLabelPrefix((value.q as string | undefined) ?? '');
  if (!prefix.ok) throw new Error('Invalid label page');
  return { q: prefix.query, ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) };
}
