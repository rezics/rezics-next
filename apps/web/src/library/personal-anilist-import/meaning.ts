import { m } from '../../paraglide/messages.js';
import {
  ANILIST_ROLES,
  type AniListCompleteness,
  type AniListFailureKind,
  type AniListFieldValidity,
  type AniListIdentifier,
  type AniListJson,
  type AniListMatchState,
  type AniListOutcomeStatus,
  type AniListRecord,
  type AniListRow,
  type AniListScoreFormat,
  type AniListSource,
  type AniListSourceField,
} from './contract';

function record(value: AniListJson | undefined): value is AniListRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function aniListTitle(evidence: AniListRecord, fallback: string): string {
  const media = record(evidence.media) ? evidence.media : undefined;
  const title = media && record(media.title) ? media.title : undefined;
  if (title) {
    for (const key of ['userPreferred', 'romaji', 'english', 'native'] as const) {
      const label = title[key];
      if (typeof label === 'string' && label.trim()) return label.trim();
    }
  }
  if (typeof evidence.mediaId === 'number' && Number.isSafeInteger(evidence.mediaId) && evidence.mediaId > 0)
    return `AniList ${evidence.mediaId}`;
  if (media && typeof media.id === 'number' && Number.isSafeInteger(media.id) && media.id > 0)
    return `AniList ${media.id}`;
  return fallback;
}

export function aniListMediaType(evidence: AniListRecord): string | null {
  const media = record(evidence.media) ? evidence.media : undefined;
  return media && typeof media.type === 'string' ? media.type : null;
}

export function aniListMediaLabel(type: string | null): string {
  if (type === 'ANIME') return m.library_anilist_media_anime();
  if (type === 'MANGA') return m.library_anilist_media_manga();
  return m.library_anilist_media_unknown();
}

export function aniListMatchLabel(match: AniListMatchState | null, skipped: boolean): string {
  if (skipped) return m.library_anilist_match_skipped();
  if (match === 'matched') return m.library_anilist_match_matched();
  if (match === 'unmatched') return m.library_anilist_match_unmatched();
  if (match === 'unavailable') return m.library_anilist_match_unavailable();
  if (match === 'ambiguous') return m.library_anilist_match_ambiguous();
  return m.library_anilist_match_unmatched();
}

export function aniListOutcomeLabel(status: AniListOutcomeStatus): string {
  if (status === 'applied') return m.library_anilist_result_applied();
  if (status === 'skipped') return m.library_anilist_result_skipped();
  if (status === 'stale') return m.library_anilist_result_stale();
  if (status === 'unsupported') return m.library_anilist_result_unsupported();
  return m.library_anilist_result_failed();
}

export function aniListFailureLabel(kind: AniListFailureKind, detail?: string): string {
  if (kind === 'denied') return m.library_anilist_denied();
  if (kind === 'malformed')
    return detail ? m.library_anilist_malformed_detail({ detail }) : m.library_anilist_malformed();
  if (kind === 'too-large') return m.library_anilist_too_large();
  if (kind === 'conflict') return detail ?? m.library_anilist_conflict_upload();
  if (kind === 'not-found') return m.library_anilist_missing_upload();
  if (kind === 'idempotency') return m.library_anilist_idempotency();
  return m.library_anilist_unavailable();
}

export function aniListValidityLabel(validity: AniListFieldValidity): string {
  if (validity === 'unknown') return m.library_anilist_validity_unknown();
  if (validity === 'invalid') return m.library_anilist_validity_invalid();
  return m.library_anilist_validity_valid();
}

export function aniListScoreFormatLabel(format: AniListScoreFormat | null): string {
  if (format === 'POINT_100') return m.library_anilist_score_point_100();
  if (format === 'POINT_10_DECIMAL') return m.library_anilist_score_point_10_decimal();
  if (format === 'POINT_10') return m.library_anilist_score_point_10();
  if (format === 'POINT_5') return m.library_anilist_score_point_5();
  if (format === 'POINT_3') return m.library_anilist_score_point_3();
  return m.library_anilist_score_unknown();
}

export function aniListFieldValue(evidence: AniListRecord, field: AniListSourceField): string {
  if (!Object.hasOwn(evidence, field.field)) return m.library_anilist_missing();
  const value = evidence[field.field];
  if (value === null) return m.library_anilist_null();
  if (field.field === 'score') {
    if (field.validity === 'unknown') return m.library_anilist_score_scale_unknown();
    if (value === 0) return m.library_anilist_score_none();
  }
  if (value === 0) return m.library_anilist_zero();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return m.library_anilist_unknown();
  }
}

export function aniListProgressLabel(field: string, mediaType: string | null): string {
  if (field === 'progressVolumes') return m.library_anilist_volumes();
  if (field !== 'progress') return field;
  if (mediaType === 'ANIME') return m.library_anilist_episodes();
  if (mediaType === 'MANGA') return m.library_anilist_chapters();
  return m.library_anilist_progress_unknown();
}

export function aniListFieldLabel(field: AniListSourceField, mediaType: string | null): string {
  if (field.field === 'status') return m.library_anilist_status();
  if (field.field === 'score') return m.library_anilist_score();
  if (field.field === 'progress' || field.field === 'progressVolumes')
    return aniListProgressLabel(field.field, mediaType);
  if (field.field === 'repeat') return m.library_anilist_repeat();
  if (field.field === 'priority') return m.library_anilist_priority();
  if (field.field === 'notes') return m.library_anilist_notes();
  if (field.field === 'private' || field.field === 'hiddenFromStatusLists') return m.library_anilist_privacy();
  if (field.field === 'customLists') return m.library_anilist_custom_lists();
  if (field.field === 'startedAt') return m.library_anilist_started();
  if (field.field === 'completedAt') return m.library_anilist_completed();
  if (field.field === 'updatedAt') return m.library_anilist_updated();
  if (field.field === 'createdAt') return m.library_anilist_created();
  if (field.field === 'mediaId') return m.library_anilist_media_id();
  if (field.field === 'id') return m.library_anilist_entry_id();
  return field.field;
}

export function aniListIdentifierLabel(identifier: AniListIdentifier): string {
  if (identifier.source === 'myanimelist')
    return m.library_anilist_mal_identifier({ value: identifier.externalId });
  return m.library_anilist_identifier({ value: identifier.externalId });
}

export function aniListGroupLabel(group: AniListRecord | null): string | null {
  if (!group) return null;
  if (typeof group.name === 'string' && group.name.trim()) return group.name.trim();
  if (typeof group.status === 'string' && group.status.trim()) return group.status.trim();
  return m.library_anilist_group();
}

export function aniListWrapperLabel(completeness: AniListCompleteness): string {
  if (completeness.wrapper === 'lists') return m.library_anilist_wrapper_lists();
  if (completeness.wrapper === 'MediaListCollection') return m.library_anilist_wrapper_collection();
  if (completeness.wrapper === 'data') return m.library_anilist_wrapper_data();
  if (completeness.wrapper === 'array') return m.library_anilist_wrapper_array();
  return m.library_anilist_wrapper_array();
}

export function aniListStatusOf(evidence: AniListRecord): string | null {
  return typeof evidence.status === 'string' ? evidence.status : null;
}

export function aniListIsRepeating(status: string | null): boolean {
  return status === 'REPEATING';
}

export function aniListHasAdmittedStatus(row: AniListRow): boolean {
  const status = aniListStatusOf(row.source.evidence);
  if (!status || aniListIsRepeating(status)) return false;
  return status in ANILIST_ROLES;
}

export function aniListCanChooseTarget(match: AniListMatchState | null): boolean {
  return match === 'unmatched' || match === 'ambiguous' || match === 'unavailable' || match === null;
}

export function aniListNeedsReplace(row: AniListRow): boolean {
  return !!row.proposal?.current || !!row.review?.observation?.current;
}

export function aniListEmptyFields(source: AniListSource): boolean {
  return source.fields.length === 0;
}

export function aniListUnsupportedFields(source: AniListSource): AniListSourceField[] {
  return source.fields.filter((field) => field.field !== 'status' || field.validity !== 'valid');
}

export function aniListPrivateNote(source: AniListSource): AniListSourceField | undefined {
  return source.fields.find((field) => field.field === 'notes');
}

export function aniListAppliedFields(row: { skip: boolean; applyStatus: boolean }): string[] {
  return row.skip || !row.applyStatus ? [] : ['status'];
}
