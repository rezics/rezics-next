import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeSearchCursor, encodeSearchCursor, type SearchCursorBinding, type SearchSortValue } from './cursor.ts';

/** Supplied from current native standard-question metadata, never request or cursor evidence. */
export type RatingCursorContext = {
  questionId: string;
  populationId: string;
  priorEpoch: number | null;
  realm?: { authority: string; revision: string };
  /** Opaque digest of current question, prior, publication, meaning and canonical observations. */
  observation?: string;
};
export type RatingPhase = 'scored' | 'unscored';
export type RatingCursorResult =
  | { ok: true; generation: number; phase: RatingPhase; after: SearchSortValue[] }
  | { ok: false; reason: 'invalid' | 'expired' | 'restart' };

const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const PREFIX = 'rating-v1';
const MAX_NAME_LENGTH = 512;

function validContext(context: unknown): context is RatingCursorContext {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return false;
  const { questionId, populationId, priorEpoch, realm, observation } = context as RatingCursorContext;
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
        typeof observation === 'string' &&
        observation.length > 0 &&
        observation.length <= 256 &&
        [realm.authority, realm.revision].every(
          (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
        )) &&
    (priorEpoch === null || (typeof priorEpoch === 'number' && Number.isSafeInteger(priorEpoch) && priorEpoch > 0))
  );
}

function prefix(context: RatingCursorContext): string {
  return context.realm
    ? `rating-realm-v1:${createHash('sha256')
        .update(JSON.stringify([context.realm.authority, context.realm.revision, context.observation]))
        .digest('hex')}`
    : PREFIX;
}

function encryptionKey(ring: KeyRing, kid: number): Buffer {
  const key = ring.keys.get(kid);
  if (!key || key.byteLength < 32) throw new Error('Rating cursor encryption key is unavailable');
  return createHash('sha256').update(key).update('rezics-rating-cursor-encryption-v1').digest();
}

function encryptFrontier(
  ring: KeyRing,
  context: RatingCursorContext,
  phase: RatingPhase,
  after: readonly SearchSortValue[],
): string {
  const kid = ring.current;
  if (!Number.isInteger(kid) || kid < 0 || kid > 255) throw new Error('Rating cursor key id is invalid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(ring, kid), iv);
  cipher.setAAD(Buffer.from(`${prefix(context)}\0${phase}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(after), 'utf8'), cipher.final()]);
  return `e1.${kid}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

function decryptFrontier(
  ring: KeyRing,
  context: RatingCursorContext,
  phase: RatingPhase,
  token: string,
): SearchSortValue[] | undefined {
  try {
    const match = /^e1\.([0-9]{1,3})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) return undefined;
    const kid = Number(match[1]);
    const iv = decodeBase64Url(match[2]!);
    const ciphertext = decodeBase64Url(match[3]!);
    const tag = decodeBase64Url(match[4]!);
    if (
      !Number.isInteger(kid) ||
      kid < 0 ||
      kid > 255 ||
      !iv ||
      iv.length !== 12 ||
      !ciphertext ||
      !tag ||
      tag.length !== 16
    )
      return undefined;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(ring, kid), iv);
    decipher.setAAD(Buffer.from(`${prefix(context)}\0${phase}`, 'utf8'));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) &&
      value.every(
        (part) => part === null || typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part)),
      )
      ? (value as SearchSortValue[])
      : undefined;
  } catch {
    return undefined;
  }
}

function validPosition(
  epoch: number | null,
  phase: unknown,
  after: unknown,
  realm = false,
): after is SearchSortValue[] {
  if (!Array.isArray(after)) return false;
  let name: unknown;
  let id: unknown;
  if (phase === 'scored') {
    if (epoch === null || after.length !== 3) return false;
    const score: unknown = after[0];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) return false;
    [, name, id] = after;
    if (realm && name !== null) return false;
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
  if (
    !validContext(context) ||
    !cursor ||
    !validPosition(context.priorEpoch, cursor.phase, cursor.after, !!context.realm)
  )
    throw new TypeError('Invalid rating cursor');
  const frontier = context.realm ? [encryptFrontier(ring, context, cursor.phase, cursor.after)] : cursor.after;
  return encodeSearchCursor(
    ring,
    binding,
    {
      generation: cursor.generation,
      after: [prefix(context), context.questionId, context.populationId, context.priorEpoch, cursor.phase, ...frontier],
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
  const [signedPrefix, questionId, populationId, priorEpoch, phase, ...encodedFrontier] = decoded.after;
  const realmToken = typeof signedPrefix === 'string' && /^rating-realm-v1:[0-9a-f]{64}$/.test(signedPrefix);
  const signedContext = {
    questionId,
    populationId,
    priorEpoch,
    ...(realmToken ? { realm: context.realm, observation: context.observation } : {}),
  };
  if (
    (signedPrefix !== PREFIX && !realmToken) ||
    !validContext(signedContext) ||
    (realmToken && (encodedFrontier.length !== 1 || typeof encodedFrontier[0] !== 'string'))
  )
    return { ok: false, reason: 'invalid' };
  if (
    signedPrefix !== prefix(context) ||
    questionId !== context.questionId ||
    populationId !== context.populationId ||
    priorEpoch !== context.priorEpoch
  )
    return { ok: false, reason: 'restart' };
  const after = realmToken
    ? decryptFrontier(ring, context, phase as RatingPhase, encodedFrontier[0] as string)
    : encodedFrontier;
  if (!after || !validPosition(context.priorEpoch, phase, after, realmToken)) return { ok: false, reason: 'invalid' };
  return { ok: true, generation: decoded.generation, phase: phase as RatingPhase, after };
}
