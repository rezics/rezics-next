import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import {
  EPISODE_INSPECT_CAP,
  EPISODE_READ_SEAM,
  EPISODE_RECORD_SEAM,
  quotedIdempotencyKey,
  type ChecklistFailureKind,
  type ChecklistIntent,
  type EpisodeProgressView,
} from './contract';

type NativeResult = {
  data?: unknown;
  error?: { value?: unknown; status?: number };
  status?: number;
};

type EpisodeGet = (options: {
  query: { ids?: string; cursor?: string; limit?: string | number };
  headers: { authorization: string };
  fetch?: RequestInit;
}) => Promise<NativeResult>;

type EpisodePost = (
  body: { revision: number; add?: string[]; remove?: string[]; clear?: true },
  options: { headers: { authorization: string; 'idempotency-key': string } },
) => Promise<NativeResult>;

type EpisodeResource = {
  episodes?: { get?: EpisodeGet };
  $recordEpisodes?: { post?: EpisodePost };
};

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemCode(body: unknown): string {
  return record(body) && typeof body.code === 'string' ? body.code : '';
}

export function episodeChecklistMethods(client: KernelClient): {
  read: boolean;
  record: boolean;
  seam: string;
} {
  let read = false;
  let record = false;
  try {
    const resource = client.progressSessions({
      sessionId: '00000000-0000-7000-8000-000000000000',
    }) as EpisodeResource;
    read = isFunction(resource.episodes?.get);
    record = isFunction(resource.$recordEpisodes?.post);
  } catch {
    read = false;
    record = false;
  }
  const seam = !read ? EPISODE_READ_SEAM : EPISODE_RECORD_SEAM;
  return { read, record, seam: read && record ? EPISODE_RECORD_SEAM : seam };
}

export function episodeCommandsAvailable(client: KernelClient): boolean {
  const methods = episodeChecklistMethods(client);
  return methods.read && methods.record;
}

function episodeResource(client: KernelClient, sessionId: string): EpisodeResource | undefined {
  try {
    const resource = client.progressSessions({ sessionId }) as EpisodeResource;
    if (!isFunction(resource.episodes?.get) || !isFunction(resource.$recordEpisodes?.post)) return undefined;
    return resource;
  } catch {
    return undefined;
  }
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
  if (record(error) && 'value' in error) return error.value;
  return error;
}

function asView(value: unknown): EpisodeProgressView | undefined {
  if (!record(value) || typeof value.revision !== 'number' || !Array.isArray(value.episodes)) return undefined;
  const episodes = value.episodes.flatMap((row) => {
    if (!record(row)) return [];
    const membership = row.membership;
    if (membership !== 'member' && membership !== 'detached' && membership !== 'unavailable') return [];
    const shown: EpisodeProgressView['episodes'][number] = {
      episodeSubjectId: typeof row.episodeSubjectId === 'string' ? row.episodeSubjectId : null,
      completed: typeof row.completed === 'boolean' ? row.completed : null,
      membership,
      ordinal: typeof row.ordinal === 'string' ? row.ordinal : null,
    };
    return [shown];
  });
  return {
    revision: value.revision,
    episodes,
    next: typeof value.next === 'string' ? value.next : null,
    ...(typeof value.completeness === 'number' ? { completeness: value.completeness } : {}),
  };
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
  const resource = episodeResource(client, sessionId);
  const get = resource?.episodes?.get;
  if (!get) return { ok: false, kind: 'unavailable', seam: EPISODE_READ_SEAM };
  const params =
    'ids' in query
      ? { ids: query.ids.slice(0, EPISODE_INSPECT_CAP).join(',') }
      : {
          limit: query.limit ?? EPISODE_INSPECT_CAP,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        };
  try {
    const result = await get({
      query: params,
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const status = result.status ?? 0;
    const view = asView(result.data);
    if (status === 200 && view) return { ok: true, view };
    return { ok: false, kind: mapEpisodeStatus(status, callBody(result.error)) };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, kind: 'unavailable', seam: EPISODE_READ_SEAM };
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

export async function recordEpisodes(
  client: KernelClient,
  sessionId: string,
  authorization: string,
  key: string,
  revision: number,
  intent: ChecklistIntent,
): Promise<EpisodeRecordResult> {
  const resource = episodeResource(client, sessionId);
  const post = resource?.$recordEpisodes?.post;
  if (!post) return { ok: false, kind: 'unavailable', seam: EPISODE_RECORD_SEAM };
  try {
    const result = await post(recordBody(revision, intent), {
      headers: { authorization, 'idempotency-key': quotedIdempotencyKey(key) },
    });
    const status = result.status ?? 0;
    if (status === 200 && record(result.data) && typeof result.data.revision === 'number') {
      return { ok: true, revision: result.data.revision };
    }
    return { ok: false, kind: mapEpisodeStatus(status, callBody(result.error)) };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, kind: 'unavailable', seam: EPISODE_RECORD_SEAM };
    return { ok: false, kind: 'unavailable', seam: EPISODE_RECORD_SEAM };
  }
}
