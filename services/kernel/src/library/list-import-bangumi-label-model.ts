import type { BangumiEvidence, BangumiGuard } from './list-import-bangumi-model.ts';
import { normalizePersonalLabelName } from './label-store.ts';

/** Selection limits constrain effects without rejecting previously admitted source evidence. */
export const BANGUMI_LABEL_LIMITS = { selections: 16, page: 32, reviewBytes: 32768 } as const;
export type BangumiTagMapping = { index: number; target: { labelId: string } | { name: string } };
export type BangumiTag = {
  index: number;
  value: unknown;
  status: 'supported' | 'invalid' | 'unknown';
  proposedName: string | null;
};
export type BangumiTagEvidence = 'missing' | 'empty' | 'known' | 'invalid' | 'unknown';
export type BangumiLabelItem = {
  index: number;
  source: unknown;
  status: 'ready' | 'invalid' | 'duplicate';
  duplicateOf: number | null;
  target: { labelId: string; revision: number } | { name: string };
};
export type BangumiLabelReview = {
  token: string;
  /** The retained row is immutable; its current Subject review is its revision operand. */
  rowRevision: string;
  subject: BangumiGuard | null;
  evidence: BangumiTagEvidence;
  items: BangumiLabelItem[];
};
export type BangumiLabelOutcome = {
  index: number;
  status: 'assigned' | 'unchanged' | 'duplicate' | 'invalid' | 'stale' | 'capacity' | 'conflict' | 'limit' | 'failed';
  label: { id: string; revision: number } | null;
  assignment: { id: string; revision: number } | null;
  created: boolean;
};
export type BangumiLabelState = {
  review: BangumiLabelReview;
  confirmed: boolean;
  outcomes: BangumiLabelOutcome[];
};

/** The installed field's validity is authoritative; mixed arrays never gain partial admission. */
export function bangumiTagEvidence(e: BangumiEvidence): BangumiTagEvidence {
  const field = e.fields.find((f) => f.field === 'tags');
  if (!field) return 'missing';
  if (field.meaning !== 'known') return field.meaning;
  if (!Array.isArray(field.value) || !field.value.every((v) => typeof v === 'string')) return 'invalid';
  return field.value.length ? 'known' : 'empty';
}
export function bangumiTag(e: BangumiEvidence, index: number): BangumiTag | null {
  const field = e.fields.find((f) => f.field === 'tags');
  if (!field || !Array.isArray(field.value) || index < 0 || index >= field.value.length) return null;
  const value: unknown = field.value[index];
  if (bangumiTagEvidence(e) !== 'known')
    return { index, value, status: field.meaning === 'unknown' ? 'unknown' : 'invalid', proposedName: null };
  try {
    return { index, value, status: 'supported', proposedName: normalizePersonalLabelName(value) };
  } catch {
    return { index, value, status: 'invalid', proposedName: null };
  }
}

export type BangumiTagPage = {
  ordinal: number;
  rowRevision: string | null;
  evidence: BangumiTagEvidence;
  tags: BangumiTag[];
  next: number | null;
  labels: BangumiLabelState | null;
};
