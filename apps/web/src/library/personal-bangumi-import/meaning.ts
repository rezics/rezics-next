import { m } from '../../paraglide/messages.js';
import type {
  BangumiApplyState,
  BangumiEvidence,
  BangumiFailureKind,
  BangumiMatch,
  BangumiOutcomeStatus,
  BangumiRecord,
  BangumiRetainedField,
  BangumiRow,
} from './contract';

export function bangumiTitle(source: BangumiRecord, fallback: string): string {
  const subject = source.subject;
  if (subject && typeof subject === 'object' && !Array.isArray(subject)) {
    const labels = subject;
    if (typeof labels.name === 'string' && labels.name.trim()) return labels.name.trim();
    if (typeof labels.name_cn === 'string' && labels.name_cn.trim()) return labels.name_cn.trim();
  }
  if (typeof source.subject_id === 'number' && Number.isSafeInteger(source.subject_id) && source.subject_id > 0)
    return `Bangumi ${source.subject_id}`;
  return fallback;
}

export function bangumiMediumLabel(medium: string): string {
  if (medium === 'book') return m.library_bangumi_medium_book();
  if (medium === 'anime') return m.library_bangumi_medium_anime();
  if (medium === 'music') return m.library_bangumi_medium_music();
  if (medium === 'game') return m.library_bangumi_medium_game();
  if (medium === 'live_action') return m.library_bangumi_medium_live();
  return m.library_bangumi_medium_unknown();
}

export function bangumiMatchLabel(match: BangumiMatch | null, skipped: boolean): string {
  if (skipped) return m.library_bangumi_match_skipped();
  if (match === 'matched') return m.library_bangumi_match_matched();
  if (match === 'already_matched') return m.library_bangumi_match_already();
  if (match === 'unmatched') return m.library_bangumi_match_unmatched();
  if (match === 'unavailable') return m.library_bangumi_match_unavailable();
  if (match === 'chosen') return m.library_bangumi_match_chosen();
  if (match === 'ambiguous') return m.library_bangumi_match_ambiguous();
  return m.library_bangumi_match_unmatched();
}

export function bangumiOutcomeLabel(status: BangumiOutcomeStatus): string {
  if (status === 'applied') return m.library_bangumi_result_applied();
  if (status === 'skipped') return m.library_bangumi_result_skipped();
  if (status === 'stale') return m.library_bangumi_result_stale();
  if (status === 'unsupported') return m.library_bangumi_result_unsupported();
  return m.library_bangumi_result_failed();
}

export function bangumiFailureLabel(kind: BangumiFailureKind, detail?: string): string {
  if (kind === 'denied') return m.library_bangumi_denied();
  if (kind === 'malformed') return detail ? m.library_bangumi_malformed_detail({ detail }) : m.library_bangumi_malformed();
  if (kind === 'too-large') return m.library_bangumi_too_large();
  if (kind === 'conflict') return detail ?? m.library_bangumi_conflict_upload();
  if (kind === 'not-found') return m.library_bangumi_missing_upload();
  if (kind === 'idempotency') return m.library_bangumi_idempotency();
  return m.library_bangumi_unavailable();
}

export function bangumiStateLabel(state: BangumiApplyState): string {
  if (state === 'replace') return m.library_bangumi_replace();
  if (state === 'omit') return m.library_bangumi_omit();
  return m.library_bangumi_preserve();
}

export function bangumiMeaningLabel(meaning: BangumiRetainedField['meaning']): string {
  if (meaning === 'unknown') return m.library_bangumi_meaning_unknown();
  if (meaning === 'invalid') return m.library_bangumi_meaning_invalid();
  return m.library_bangumi_meaning_known();
}

export function bangumiFieldValue(field: BangumiRetainedField): string {
  if (field.field === 'rate') {
    if (field.meaning === 'invalid') return m.library_bangumi_invalid({ raw: String(field.value ?? '') });
    if (field.value === 0) return m.library_bangumi_rate_none();
    if (typeof field.value === 'number')
      return `${field.value} (${m.library_bangumi_rate_scale({ min: 1, max: 10 })})`;
  }
  if (field.value === undefined) return m.library_bangumi_missing();
  if (field.value === null) return m.library_bangumi_unknown();
  if (typeof field.value === 'string') return field.value;
  if (typeof field.value === 'number' || typeof field.value === 'boolean') return String(field.value);
  if (Array.isArray(field.value) && field.value.every((item) => typeof item === 'string')) return field.value.join(', ');
  try {
    return JSON.stringify(field.value);
  } catch {
    return m.library_bangumi_unknown();
  }
}

export function bangumiMeasureLabel(field: string, medium: string): string {
  if (field === 'vol_status') return m.library_bangumi_volumes();
  if (field !== 'ep_status') return field;
  if (medium === 'book') return m.library_bangumi_chapters();
  if (medium === 'anime' || medium === 'live_action') return m.library_bangumi_episodes();
  return m.library_bangumi_ep_status();
}

export function bangumiFieldLabel(field: BangumiRetainedField, medium: string): string {
  if (field.field === 'subject_id') return m.library_bangumi_subject_id();
  if (field.field === 'type') return m.library_bangumi_type();
  if (field.field === 'rate') return m.library_bangumi_rate();
  if (field.field === 'ep_status' || field.field === 'vol_status') return bangumiMeasureLabel(field.field, medium);
  if (field.field === 'tags') return m.library_bangumi_tags();
  if (field.field === 'comment') return m.library_bangumi_comment();
  if (field.field === 'notes') return m.library_bangumi_notes();
  if (field.field === 'private') return m.library_bangumi_privacy();
  if (field.field === 'updated_at') return m.library_bangumi_updated();
  return field.field;
}

export function bangumiKnownFields(evidence: BangumiEvidence): BangumiRetainedField[] {
  return evidence.fields.filter((field) => field.meaning === 'known');
}

export function bangumiUnknownFields(evidence: BangumiEvidence): BangumiRetainedField[] {
  return evidence.fields.filter((field) => field.meaning !== 'known');
}

export function bangumiPrivateNote(evidence: BangumiEvidence): BangumiRetainedField | undefined {
  return evidence.fields.find((field) => field.field === 'comment' || field.field === 'notes');
}

export function bangumiCanChooseTarget(match: BangumiMatch | null): boolean {
  return match === 'unmatched' || match === 'ambiguous' || match === 'unavailable' || match === null;
}

export function bangumiNeedsReplace(row: Pick<BangumiRow, 'review'>): boolean {
  return !!row.review?.conflict || row.review?.match === 'already_matched';
}

export function bangumiHasUnsupportedProposal(row: BangumiRow): boolean {
  return row.review !== null && row.review.proposedState === null && !row.review.conflict;
}

export function bangumiEmptyFields(evidence: BangumiEvidence): boolean {
  return evidence.fields.length === 0;
}
