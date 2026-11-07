import type { KernelClient } from '@rezics/client';
import {
  CANONICAL_ID,
  EPISODE_INSPECT_CAP,
  EPISODE_READ_SEAM,
  EPISODE_RECORD_SEAM,
  canonicalIds,
  quotedIdempotencyKey,
  type ChecklistFailureKind,
  type ChecklistIntent,
  type EpisodeCompletion,
  type EpisodeProgressView,
} from './contract';

const MAX_REVISION = 2_147_483_646;
const MAX_CURSOR_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 1 && value <= MAX_REVISION;
}

function problemCode(body: unknown): string {
  return isRecord(body) && typeof body.code === 'string' ? body.code : '';
}

export function mapEpisodeStatus(status: number, body: unknown): ChecklistFailureKind {
  const code = problemCode(body);
  if (status === 400 && (code === 'invalid_cursor' || /invalid_cursor/i.test(code))) return 'invalid_cursor';
  if (status === 400) return 'invalid_request';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not_found';
  if (status === 409 && (code === 'stale_cursor' || /stale_cursor/i.test(code))) return 'stale_cursor';
  if (status === 409) return 'conflict';
  if (status === 422 && code === 'idempotency_conflict') return 'idempotency_conflict';
  if (status === 422 && code === 'unsupported_library_profile') return 'unsupported_library_profile';
  if (status === 422) return 'idempotency_conflict';
  return 'unavailable';
}

function callBody(error: unknown): unknown {
  if (isRecord(error) && 'value' in error) return error.value;
  return error;
}

type EpisodeViewExpectation = { kind: 'inspect'; ids: readonly string[] } | { kind: 'retained'; limit: number };

function admitCompletion(value: unknown): EpisodeCompletion | undefined {
  if (!hasExactKeys(value, ['episodeSubjectId', 'completed', 'membership', 'ordinal'])) return undefined;
  const { episodeSubjectId, completed, membership, ordinal } = value;
  if (membership === 'unavailable') {
    if (episodeSubjectId !== null || completed !== null || ordinal !== null) return undefined;
    return { episodeSubjectId: null, completed: null, membership, ordinal: null };
  }
  if (membership !== 'member' && membership !== 'detached') return undefined;
  if (
    typeof episodeSubjectId !== 'string' ||
    !CANONICAL_ID.test(episodeSubjectId) ||
    typeof completed !== 'boolean' ||
    (typeof ordinal !== 'string' && ordinal !== null)
  ) {
    return undefined;
  }
  return { episodeSubjectId, completed, membership, ordinal };
}

/** Admit one complete native response before any caller projects rows or treats `next` as terminal. */
function admitEpisodeProgressView(
  value: unknown,
  expectation: EpisodeViewExpectation,
): EpisodeProgressView | undefined {
  if (!hasExactKeys(value, ['revision', 'episodes', 'next'])) return undefined;
  if (!validRevision(value.revision) || !Array.isArray(value.episodes) || value.episodes.length > EPISODE_INSPECT_CAP) {
    return undefined;
  }
  if (
    value.next !== null &&
    (typeof value.next !== 'string' || value.next.length === 0 || value.next.length > MAX_CURSOR_LENGTH)
  ) {
    return undefined;
  }

  if (expectation.kind === 'inspect') {
    if (value.episodes.length !== expectation.ids.length || value.next !== null) return undefined;
  } else if (value.episodes.length > expectation.limit) {
    return undefined;
  }

  const episodes: EpisodeCompletion[] = [];
  const seen = new Set<string>();
  for (const [index, input] of value.episodes.entries()) {
    const episode = admitCompletion(input);
    if (!episode) return undefined;
    if (episode.episodeSubjectId !== null) {
      if (seen.has(episode.episodeSubjectId)) return undefined;
      seen.add(episode.episodeSubjectId);
      if (expectation.kind === 'inspect' && episode.episodeSubjectId !== expectation.ids[index]) return undefined;
    }
    episodes.push(episode);
  }

  return { revision: value.revision, episodes, next: value.next };
}

export type EpisodeInspectQuery = { ids: readonly string[] } | { cursor?: string; limit?: number };

export type EpisodeInspectResult =
  | { ok: true; view: EpisodeProgressView }
  | { ok: false; kind: ChecklistFailureKind; seam?: string };

export async function inspectEpisodes(
  client: KernelClient,
  sessionId: string,
  authorization: string,
  query: EpisodeInspectQuery,
): Promise<EpisodeInspectResult> {
  let params: { ids: string } | { cursor?: string; limit: number };
  let expectation: EpisodeViewExpectation;
  if ('ids' in query) {
    const ids = canonicalIds(query.ids);
    if (!ids || ids.length === 0) return { ok: false, kind: 'invalid_request' };
    params = { ids: ids.join(',') };
    expectation = { kind: 'inspect', ids };
  } else {
    const limit = query.limit ?? EPISODE_INSPECT_CAP;
    if (!Number.isInteger(limit) || limit < 1 || limit > EPISODE_INSPECT_CAP) {
      return { ok: false, kind: 'invalid_request' };
    }
    params = {
      limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    };
    expectation = { kind: 'retained', limit };
  }

  try {
    const result = await client.progressSessions({ sessionId }).episodes.get({
      query: params,
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const status = result.status ?? 0;
    if (status === 200) {
      const view = admitEpisodeProgressView(result.data, expectation);
      if (view) return { ok: true, view };
      return { ok: false, kind: 'unavailable', seam: EPISODE_READ_SEAM };
    }
    return { ok: false, kind: mapEpisodeStatus(status, callBody(result.error)) };
  } catch {
    return { ok: false, kind: 'unavailable', seam: EPISODE_READ_SEAM };
  }
}

export type EpisodeRecordResult =
  | { ok: true; revision: number }
  | { ok: false; kind: ChecklistFailureKind; seam?: string };

export function recordBody(
  revision: number,
  intent: ChecklistIntent,
): { revision: number; add?: string[]; remove?: string[] } | { revision: number; clear: true } {
  if (intent.kind === 'clear') return { revision, clear: true };
  return {
    revision,
    ...(intent.add.length ? { add: intent.add } : {}),
    ...(intent.remove.length ? { remove: intent.remove } : {}),
  };
}

function admitRecordRevision(value: unknown): number | undefined {
  if (!hasExactKeys(value, ['revision']) || !validRevision(value.revision)) return undefined;
  return value.revision;
}

export async function recordEpisodes(
  client: KernelClient,
  sessionId: string,
  key: string,
  revision: number,
  intent: ChecklistIntent,
): Promise<EpisodeRecordResult> {
  try {
    const result = await client.progressSessions({ sessionId }).$recordEpisodes.post(recordBody(revision, intent), {
      headers: { 'idempotency-key': quotedIdempotencyKey(key) },
    });
    const status = result.status ?? 0;
    if (status === 200) {
      const responseRevision = admitRecordRevision(result.data);
      if (responseRevision !== undefined) return { ok: true, revision: responseRevision };
      return { ok: false, kind: 'unavailable', seam: EPISODE_RECORD_SEAM };
    }
    return { ok: false, kind: mapEpisodeStatus(status, callBody(result.error)) };
  } catch {
    return { ok: false, kind: 'unavailable', seam: EPISODE_RECORD_SEAM };
  }
}
