import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { MalRow } from './list-import-mal-parser.ts';

/** Adoption bounds do not change the upload or retained-document allowances. */
export const MAL_LABEL_LIMITS = {
  rows: 20,
  values: 32,
  newLabels: 32,
  sourceBytes: 8192,
  selectionBytes: 16384,
  outputBytes: 524288,
} as const;

export const malDigest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
export type MalTagEvidence = {
  kind: 'missing' | 'empty' | 'unknown' | 'invalid' | 'unsupported' | 'supported';
  raw?: string;
  grammar: 'mal-comma-v1';
  values: { index: number; raw: string; value: string; duplicateOf: number | null }[];
  reason: string | null;
};

/** Use the retained XML leaf, never the display title, MalValue rendering or comments.
 * XML entities/CDATA have already been decoded by the installed upload parser.
 * The supported subset has literal commas and no quoting or backslash escaping.
 * Ambiguous quoting/escaping is evidence only; it is never partially tokenized.
 */
export function malTagEvidence(row: Pick<MalRow, 'fields'>): MalTagEvidence {
  const base = { grammar: 'mal-comma-v1' as const, values: [], reason: null };
  if (!Object.hasOwn(row.fields, 'my_tags')) return { ...base, kind: 'missing' };
  const raw = row.fields.my_tags!;
  if (typeof raw !== 'string' || !raw.isWellFormed()) return { ...base, kind: 'invalid', reason: 'invalid-text' };
  if (raw === '') return { ...base, kind: 'empty', raw };
  if (Buffer.byteLength(raw) > MAL_LABEL_LIMITS.sourceBytes)
    return { ...base, kind: 'unsupported', reason: 'source-byte-limit' };
  if (raw.trim() === '') return { ...base, kind: 'unknown', raw };
  if (/["\\]/u.test(raw)) return { ...base, kind: 'unsupported', raw, reason: 'ambiguous-quoting-or-escaping' };
  if (/\p{Cc}/u.test(raw)) return { ...base, kind: 'invalid', raw, reason: 'control-character' };
  const tokens = raw.split(',');
  if (tokens.length > MAL_LABEL_LIMITS.values)
    return { ...base, kind: 'unsupported', raw, reason: 'source-value-limit' };
  if (tokens.some((v) => v.trim() === '')) return { ...base, kind: 'invalid', raw, reason: 'empty-delimited-value' };
  const seen = new Map<string, number>();
  return {
    ...base,
    kind: 'supported',
    raw,
    values: tokens.map((raw, index) => {
      const value = raw.trim(),
        duplicateOf = seen.get(value) ?? null;
      if (duplicateOf === null) seen.set(value, index);
      return { index, raw, value, duplicateOf };
    }),
  };
}

export type MalLabelSelection = { value: number; target: { labelId: string; revision: number } | { name: string } };
export type MalReviewedLabel = {
  value: number;
  sourceValue: string | null;
  target: { labelId: string; revision: number } | { name: string } | null;
  status: 'ready' | 'duplicate' | 'invalid' | 'collision' | 'unavailable' | 'unsupported';
  reason: string | null;
};
export type MalLabelReview = {
  evidence: MalTagEvidence;
  sourceDigest: string;
  selections: MalReviewedLabel[];
  selectionDigest: string;
};
export type MalLabelOutcome = {
  value: number;
  status: 'accepted' | 'unchanged' | 'stale' | 'unsupported' | 'failed';
  labelId: string | null;
  assignment: { id: string; revision: number } | null;
  reason: string | null;
};
