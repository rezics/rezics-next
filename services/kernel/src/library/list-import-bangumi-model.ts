import { ProblemError } from '../http/problem.ts';
import type { EntryImportMetadataReview } from './list-import-entry-metadata.ts';

export const BANGUMI_LIMITS = { bytes: 262144, rows: 100, rowBytes: 8192, page: 10, apply: 5, depth: 16 } as const;
export type BangumiRecord = Record<string, unknown>;
export type RetainedField = { field: string; value: unknown; meaning: 'known' | 'unknown' | 'invalid'; reason: string };
export type BangumiEvidence = {
  source: BangumiRecord;
  fields: RetainedField[];
  medium: string;
  stateRole: string | null;
};
export type BangumiGuard = { subjectId: string; releaseDigest: string; identityEpoch: string };
export type BangumiReview = {
  token: string;
  match: 'matched' | 'already_matched' | 'ambiguous' | 'unmatched' | 'unavailable' | 'chosen';
  candidates: string[];
  target: string | null;
  guard: BangumiGuard | null;
  proposedState: string | null;
  current: { state: string; revision: number; incarnationId?: string | null } | null;
  conflict: boolean;
  metadata?: EntryImportMetadataReview[];
};
export type BangumiChoice = {
  ordinal: number;
  reviewToken: string;
  state: 'preserve' | 'replace' | 'omit';
  skip: boolean;
};
export type BangumiOutcome = {
  ordinal: number;
  status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
  applied: string[];
  retained: string[];
};
export type BangumiRow = {
  ordinal: number;
  evidence: BangumiEvidence;
  review: BangumiReview | null;
  outcome: BangumiOutcome | null;
};
const media: Record<string, string> = { 1: 'book', 2: 'anime', 3: 'music', 4: 'game', 6: 'live_action' };
const roles: Record<string, string> = { 1: 'planned', 2: 'completed', 3: 'active', 4: 'paused', 5: 'dropped' };
function dateValue(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(.+))?)?)?$/.exec(v);
  if (!m || Number(m[1]) === 0) return false;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 12)) return false;
  if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate()))
    return false;
  return !m[4] || Number.isFinite(Date.parse(v));
}
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function safe(value: unknown, depth = 0): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ProblemError('invalid_request');
  if (depth > BANGUMI_LIMITS.depth) throw new ProblemError('invalid_request');
  if (typeof value === 'string' && (value.includes('\u0000') || !value.isWellFormed()))
    throw new ProblemError('invalid_request');
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (/token|password|authorization|credential|secret/i.test(key)) throw new ProblemError('invalid_request');
      safe(child, depth + 1);
    }
}
/** A REZICS upload wrapper, never advertised as an official Bangumi export format. */
export function parseBangumiUpload(upload: string): BangumiEvidence[] {
  if (Buffer.byteLength(upload) > BANGUMI_LIMITS.bytes) throw new ProblemError('invalid_request');
  let envelope: unknown;
  try {
    envelope = JSON.parse(upload);
  } catch {
    throw new ProblemError('invalid_request');
  }
  safe(envelope);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new ProblemError('invalid_request');
  const body = envelope as Record<string, unknown>;
  if (
    body.format !== 'rezics.bangumi-collection.v1' ||
    Object.keys(body).some((k) => k !== 'format' && k !== 'collections') ||
    !Array.isArray(body.collections) ||
    body.collections.length < 1 ||
    body.collections.length > BANGUMI_LIMITS.rows
  )
    throw new ProblemError('invalid_request');
  return body.collections.map((raw): BangumiEvidence => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Buffer.byteLength(JSON.stringify(raw)) > BANGUMI_LIMITS.rowBytes
    )
      throw new ProblemError('invalid_request');
    const source = raw as BangumiRecord;
    const medium = integer(source.subject_type) ? (media[String(source.subject_type)] ?? 'unknown') : 'unknown';
    const stateRole = integer(source.type) ? (roles[String(source.type)] ?? null) : null;
    const fields = Object.entries(source).map(([field, value]): RetainedField => {
      let meaning: RetainedField['meaning'] = 'known';
      let reason = 'No native field mapping; retained privately';
      if (field === 'subject_id') {
        if (!integer(value) || value === 0) meaning = 'invalid';
        reason = 'Bangumi provider identifier; never a title match';
      } else if (field === 'subject_type') {
        if (medium === 'unknown') meaning = integer(value) ? 'unknown' : 'invalid';
        reason = 'Original subject type retained; no medium conversion';
      } else if (field === 'type') {
        if (stateRole === null) meaning = integer(value) ? 'unknown' : 'invalid';
        reason = 'Only a unique released native state role may be proposed';
      } else if (field === 'rate') {
        if (!integer(value) || Number(value) > 10) meaning = 'invalid';
        reason =
          value === 0
            ? 'Bangumi zero means unrated; no native vote'
            : 'Bangumi 1–10 scale; no native vote or aggregate';
      } else if (field === 'ep_status' || field === 'vol_status') {
        if (!integer(value)) meaning = 'invalid';
        reason = `${field === 'vol_status' ? 'volumes' : medium === 'book' ? 'chapters' : medium === 'anime' || medium === 'live_action' ? 'episodes' : 'source ep_status (measure unverified)'}; no historical session inferred`;
      } else if (field === 'private') {
        if (typeof value !== 'boolean') meaning = 'invalid';
        reason = 'Source privacy retained; all upload evidence remains owner-private';
      } else if (field === 'comment' || field === 'notes') {
        if (typeof value !== 'string') meaning = 'invalid';
        reason = 'Private source note; never a public review';
      } else if (field === 'tags') {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) meaning = 'invalid';
        reason = 'Source tags; no native label inferred';
      } else if (field.endsWith('_at') || field.endsWith('_date')) {
        if (!dateValue(value)) meaning = 'invalid';
        reason = 'Original date and precision retained; never a command clock';
      } else if (field === 'subject') reason = 'Source display metadata only; never identity authority';
      else meaning = 'unknown';
      return { field, value, meaning, reason };
    });
    const evidence = { source, fields, medium, stateRole };
    if (Buffer.byteLength(JSON.stringify(evidence)) > 32768) throw new ProblemError('invalid_request');
    return evidence;
  });
}
