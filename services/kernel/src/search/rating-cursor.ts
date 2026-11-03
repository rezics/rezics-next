import { routeOf } from '../route/route.ts';
import { createHash } from 'node:crypto';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding, type SearchSortValue } from './cursor.ts';

/** Supplied from current native standard-question metadata, never request or cursor evidence. */
export type RatingCursorContext = {
  questionId: string;
  populationId: string;
  priorEpoch: number | null;
  realm?: { authority: string; revision: string };
};
export type RatingPhase = 'scored' | 'unscored';
export type RatingCursorResult =
  | { ok: true; generation: number; phase: RatingPhase; after: SearchSortValue[] }
  | { ok: false; reason: 'invalid' | 'expired' | 'restart' };

const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const PREFIX = 'rating-v1';
// Native name_sort uses null for names beyond this UTF-16 bound; preserve that missing-last position.
const MAX_NAME_LENGTH = 512;

function validContext(context: unknown): context is RatingCursorContext {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return false;
  const { questionId, populationId, priorEpoch, realm } = context as RatingCursorContext;
  return (
    typeof questionId === 'string' &&
    questionId.length === 36 &&
    routeOf(questionId) !== null &&
    (realm === undefined
      ? populationId === GLOBAL_CONTEXT
      : typeof populationId === 'string' &&
        populationId !== GLOBAL_CONTEXT &&
        routeOf(populationId) !== null &&
        realm !== null &&
        typeof realm === 'object' &&
        [realm.authority, realm.revision].every(
          (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
        )) &&
    (priorEpoch === null || (typeof priorEpoch === 'number' && Number.isSafeInteger(priorEpoch) && priorEpoch > 0))
  );
}

function prefix(context: RatingCursorContext): string {
  return context.realm
    ? `rating-realm-v1:${createHash('sha256')
        .update(JSON.stringify([context.realm.authority, context.realm.revision]))
        .digest('hex')}`
    : PREFIX;
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

export async function encodeRatingCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  context: RatingCursorContext,
  cursor: { generation: number; phase: RatingPhase; after: readonly SearchSortValue[] },
  now = Date.now(),
): Promise<string> {
  if (!validContext(context) || !cursor || !validPosition(context.priorEpoch, cursor.phase, cursor.after))
    throw new TypeError('Invalid rating cursor');
  return encodeSearchCursor(
    ring,
    binding,
    {
      generation: cursor.generation,
      after: [prefix(context), context.questionId, context.populationId, context.priorEpoch, cursor.phase, ...cursor.after],
    },
    now,
  );
}

export async function decodeRatingCursor(
  ring: KeyRing,
  binding: SearchCursorBinding,
  context: RatingCursorContext,
  token: string,
  now = Date.now(),
): Promise<RatingCursorResult> {
  // Authenticate the original request/viewer/operation before inspecting eligibility metadata.
  const decoded = await decodeSearchCursor(ring, binding, token, now);
  if (!decoded.ok) return decoded;
  if (!validContext(context)) return { ok: false, reason: 'invalid' };
  const [signedPrefix, questionId, populationId, priorEpoch, phase, ...after] = decoded.after;
  const realmToken = typeof signedPrefix === 'string' && /^rating-realm-v1:[0-9a-f]{64}$/.test(signedPrefix);
  const signedContext = {
    questionId,
    populationId,
    priorEpoch,
    ...(realmToken ? { realm: context.realm } : {}),
  };
  if (
    (signedPrefix !== PREFIX && !realmToken) ||
    !validContext(signedContext) ||
    !validPosition(signedContext.priorEpoch, phase, after)
  )
    return { ok: false, reason: 'invalid' };
  if (
    signedPrefix !== prefix(context) ||
    questionId !== context.questionId ||
    populationId !== context.populationId ||
    priorEpoch !== context.priorEpoch
  )
    return { ok: false, reason: 'restart' };
  return { ok: true, generation: decoded.generation, phase: phase as RatingPhase, after };
}
