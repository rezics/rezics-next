import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding, type SearchSortValue } from './cursor.ts';

/** Supplied from current native Global standard-question metadata, never the request or a cached cursor. */
export type RatingCursorContext = { questionId: string; populationId: string; priorEpoch: number | null };
export type RatingPhase = 'scored' | 'unscored';
export type RatingCursorResult =
  | { ok: true; generation: number; phase: RatingPhase; after: SearchSortValue[] }
  | { ok: false; reason: 'invalid' | 'expired' | 'restart' };

const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const PREFIX = 'rating-v1';
// Native name_sort uses null for names beyond this UTF-16 bound; preserve that missing-last position.
const MAX_NAME_LENGTH = 512;
// The shared token decoder caps the entire encoded token at this length.
const MAX_TOKEN_LENGTH = 4_096;

function validContext(context: unknown): context is RatingCursorContext {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return false;
  const { questionId, populationId, priorEpoch } = context as Record<string, unknown>;
  return (
    typeof questionId === 'string' &&
    questionId.length === 36 &&
    routeOf(questionId) !== null &&
    populationId === GLOBAL_CONTEXT &&
    (priorEpoch === null || (typeof priorEpoch === 'number' && Number.isSafeInteger(priorEpoch) && priorEpoch > 0))
  );
}

function validPosition(epoch: number | null, phase: unknown, after: unknown): after is SearchSortValue[] {
  if (!Array.isArray(after)) return false;
  let name: unknown;
  let id: unknown;
  if (phase === 'scored') {
    if (epoch === null || after.length !== 3) return false;
    const score: unknown = after[0];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) return false;
    [, name, id] = after;
  } else if (phase === 'unscored' && after.length === 2) {
    [name, id] = after;
  } else return false;
  return (
    (name === null || (typeof name === 'string' && name.length <= MAX_NAME_LENGTH && name.isWellFormed())) &&
    typeof id === 'string' &&
    id.length === 36 &&
    routeOf(id) !== null
  );
}

export function encodeRatingCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  context: RatingCursorContext,
  cursor: { generation: number; phase: RatingPhase; after: readonly SearchSortValue[] },
  now = Date.now(),
): string {
  if (!validContext(context) || !cursor || !validPosition(context.priorEpoch, cursor.phase, cursor.after))
    throw new TypeError('Invalid rating cursor');
  const token = encodeSearchCursor(
    ring,
    binding,
    {
      generation: cursor.generation,
      after: [PREFIX, context.questionId, context.populationId, context.priorEpoch, cursor.phase, ...cursor.after],
    },
    now,
  );
  if (token.length > MAX_TOKEN_LENGTH) throw new TypeError('Rating cursor exceeds the token length limit');
  return token;
}

export function decodeRatingCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  context: RatingCursorContext,
  token: string,
  now = Date.now(),
): RatingCursorResult {
  // Authenticate the original request/viewer/operation before inspecting eligibility metadata.
  const decoded = decodeSearchCursor(ring, binding, token, now);
  if (!decoded.ok) return decoded;
  const [prefix, questionId, populationId, priorEpoch, phase, ...after] = decoded.after;
  const signedContext = { questionId, populationId, priorEpoch };
  if (
    prefix !== PREFIX ||
    !validContext(signedContext) ||
    !validPosition(signedContext.priorEpoch, phase, after) ||
    !validContext(context)
  )
    return { ok: false, reason: 'invalid' };
  if (questionId !== context.questionId || priorEpoch !== context.priorEpoch) return { ok: false, reason: 'restart' };
  return { ok: true, generation: decoded.generation, phase: phase as RatingPhase, after };
}
