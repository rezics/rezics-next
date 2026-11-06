import { m } from '../../paraglide/messages.js';
import type { MalFailureKind, MalMatch, MalOutcomeStatus, MalPreviewRow, MalScoreOutcome, MalValue } from './contract';

export function malValueLabel(value: MalValue): string {
  if (value.kind === 'missing') return m.library_mal_missing();
  if (value.kind === 'unknown') return m.library_mal_unknown();
  if (value.kind === 'invalid') return m.library_mal_invalid({ raw: value.raw ?? '' });
  if (value.kind === 'zero') return m.library_mal_zero();
  const text = value.value === undefined ? (value.raw ?? '') : String(value.value);
  if (value.precision === 'year') return m.library_mal_precision_year({ value: text });
  if (value.precision === 'month') return m.library_mal_precision_month({ value: text });
  if (value.precision === 'day') return m.library_mal_precision_day({ value: text });
  return text;
}

function scoreScale(score: MalValue): { min: number; max: number; step: number } | undefined {
  return 'scale' in score && score.scale ? score.scale : undefined;
}

export function malScoreLabel(score: MalValue): string {
  if (score.kind === 'zero') return m.library_mal_score_none();
  const scale = scoreScale(score);
  const labelled = scale ? m.library_mal_score_scale({ min: scale.min, max: scale.max }) : '';
  return labelled ? `${malValueLabel(score)} (${labelled})` : malValueLabel(score);
}

export function malOriginalScoreLabel(score: MalValue): string {
  const value =
    score.kind === 'zero'
      ? m.library_mal_score_zero_source({ value: score.raw ?? String(score.value ?? 0) })
      : malValueLabel(score);
  const scale = scoreScale(score);
  const labelled = scale
    ? m.library_mal_score_source_scale({ min: scale.min, max: scale.max, step: scale.step })
    : m.library_mal_none();
  return m.library_mal_score_source_details({ value, scale: labelled });
}

export function malMatchLabel(match: MalMatch, skipped: boolean): string {
  if (skipped) return m.library_mal_match_skipped();
  if (match === 'matched') return m.library_mal_match_matched();
  if (match === 'already-matched') return m.library_mal_match_already();
  if (match === 'unmatched') return m.library_mal_match_unmatched();
  if (match === 'unavailable') return m.library_mal_match_unavailable();
  return m.library_mal_match_ambiguous();
}

export function malKindLabel(kind: MalPreviewRow['kind']): string {
  return kind === 'anime' ? m.library_mal_kind_anime() : m.library_mal_kind_manga();
}

export function malOutcomeLabel(status: MalOutcomeStatus): string {
  if (status === 'applied') return m.library_mal_result_applied();
  if (status === 'skipped') return m.library_mal_result_skipped();
  if (status === 'stale') return m.library_mal_result_stale();
  if (status === 'unsupported') return m.library_mal_result_unsupported();
  return m.library_mal_result_failed();
}

export function malScoreOutcomeLabel(status: MalScoreOutcome['status']): string {
  if (status === 'applied') return m.library_mal_result_applied();
  if (status === 'unavailable') return m.library_mal_score_unavailable();
  return malOutcomeLabel(status);
}

export function malVoteReadKey(row: number, targetId: string, questionId: string): string {
  return JSON.stringify([row, targetId, questionId]);
}

export function malFailureLabel(kind: MalFailureKind, detail?: string): string {
  if (kind === 'denied') return m.library_mal_denied();
  if (kind === 'malformed') return detail ? m.library_mal_malformed_detail({ detail }) : m.library_mal_malformed();
  if (kind === 'too-large') return m.library_mal_too_large();
  if (kind === 'security') return m.library_mal_security();
  if (kind === 'conflict') return detail ?? m.library_mal_conflict_upload();
  if (kind === 'not-found') return m.library_mal_missing_upload();
  if (kind === 'idempotency') return m.library_mal_idempotency();
  return m.library_mal_unavailable();
}

export function malRetainReason(reason: string): string {
  if (reason === 'private-note-only') return m.library_mal_reason_note();
  if (reason === 'no-native-vote-admission') return m.library_mal_reason_score();
  if (reason === 'no-dated-session-or-native-measure-admission') return m.library_mal_reason_measure();
  return m.library_mal_reason_evidence();
}

export function malProgressEntries(row: MalPreviewRow): { key: string; label: string; value: MalValue }[] {
  const labels: Record<string, string> = {
    my_watched_episodes: m.library_mal_episodes(),
    my_read_chapters: m.library_mal_chapters(),
    my_read_volumes: m.library_mal_volumes(),
  };
  return Object.entries(row.progress).map(([key, value]) => ({
    key,
    label: labels[key] ?? key,
    value,
  }));
}

export function admittedFields(row: MalPreviewRow): string[] {
  if (row.review?.skip) return [];
  return (
    row.selectedFields ?? [...(row.state ? ['status'] : []), ...(row.review?.labels?.selections.length ? ['tags'] : [])]
  );
}
