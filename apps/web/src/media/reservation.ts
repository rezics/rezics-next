import { sessionSubject, viewerCredential } from '../session/request.ts';
import {
  mediaClient,
  parseAvatarUploadAdvice,
  problem,
  readAvatarUploadAdvice,
  readReservation,
  reserveMedia,
  type Media,
  type ReservationInput,
} from './kernel.ts';
import type { MediaEnv } from './index.ts';
import { reserveRealmMedia, type RealmMediaReservation } from '../community/realm-presentation-native';

const invalidRequest = () => problem(400, 'invalid_request', 'Invalid Request');
const bodyLimit = 4 * 1024;
const imageTypes = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];
const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function imageFields(fields: Record<string, unknown>) {
  if (
    !['post-image', 'avatar', 'realm-icon', 'realm-banner'].includes(String(fields.purpose)) ||
    typeof fields.mediaType !== 'string' ||
    !imageTypes.includes(fields.mediaType) ||
    typeof fields.byteCount !== 'number' ||
    !Number.isSafeInteger(fields.byteCount) ||
    fields.byteCount < 1 ||
    ('sha256' in fields && (typeof fields.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fields.sha256)))
  )
    throw invalidRequest();
  const shared = {
    purpose: fields.purpose as 'post-image' | 'avatar' | 'realm-icon' | 'realm-banner',
    mediaType: fields.mediaType as ReservationInput['mediaType'],
    byteCount: fields.byteCount,
  };
  if (!('sha256' in fields)) return shared;
  return { ...shared, sha256: fields.sha256 as string };
}

function futureThread(value: unknown): { boardId: string; idempotencyKey: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidRequest();
  const thread = value as Record<string, unknown>;
  const keys = Object.keys(thread);
  if (
    keys.length !== 2 ||
    typeof thread.boardId !== 'string' ||
    !contentId.test(thread.boardId) ||
    typeof thread.idempotencyKey !== 'string' ||
    !uuid.test(thread.idempotencyKey)
  )
    throw invalidRequest();
  return { boardId: thread.boardId, idempotencyKey: thread.idempotencyKey };
}

type SiteReservation = ReservationInput | (RealmMediaReservation & { realmId: string });

function reservationKey(header: string | null): string | undefined {
  if (header === null || header === '') return undefined;
  try {
    const value = JSON.parse(header) as unknown;
    if (typeof value === 'string' && value.length >= 1 && value.length <= 255) return value;
  } catch {
    /* invalid structured key */
  }
  throw invalidRequest();
}

async function reservationInput(request: Request): Promise<SiteReservation> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw problem(415, 'invalid_request', 'Invalid Request');
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(bodyLimit))
    throw problem(413, 'invalid_request', 'Invalid Request');
  if (!request.body) throw invalidRequest();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(bodyLimit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > bodyLimit) {
        await reader.cancel().catch(() => {});
        throw problem(413, 'invalid_request', 'Invalid Request');
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    throw invalidRequest();
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalidRequest();
  const fields = input as Record<string, unknown>;
  if (
    Object.keys(fields).some(
      (key) => !['containerId', 'newThread', 'realmId', 'purpose', 'mediaType', 'byteCount', 'sha256'].includes(key),
    )
  )
    throw invalidRequest();
  const hasContainer = Object.prototype.hasOwnProperty.call(fields, 'containerId');
  const hasFuture = Object.prototype.hasOwnProperty.call(fields, 'newThread');
  const shared = imageFields(fields);
  if (shared.purpose === 'realm-icon' || shared.purpose === 'realm-banner') {
    if (hasContainer || hasFuture || typeof fields.realmId !== 'string' || !contentId.test(fields.realmId))
      throw invalidRequest();
    return { ...shared, purpose: shared.purpose, realmId: fields.realmId };
  }
  if ('realmId' in fields || hasContainer === hasFuture) throw invalidRequest();
  if (hasContainer) {
    if (typeof fields.containerId !== 'string') throw invalidRequest();
    if (shared.purpose === 'avatar' && !contentId.test(fields.containerId)) throw invalidRequest();
    return { containerId: fields.containerId, ...shared, purpose: shared.purpose };
  }
  if (shared.purpose === 'avatar') throw invalidRequest();
  return { newThread: futureThread(fields.newThread), ...shared, purpose: 'post-image' };
}

function publicMedia({ id, state, mediaType, byteCount, sha256, containerId }: Media) {
  return { media: { id, state, mediaType, byteCount, sha256, containerId } };
}

export async function reserve(request: Request, env: MediaEnv): Promise<Response> {
  const input = await reservationInput(request);
  const key = reservationKey(request.headers.get('idempotency-key'));
  const client = mediaClient(env.KERNEL_ORIGIN);
  const credential = viewerCredential(request);
  const media =
    'realmId' in input
      ? await reserveRealmMedia(
          client,
          credential,
          input.realmId,
          {
            purpose: input.purpose,
            mediaType: input.mediaType,
            byteCount: input.byteCount,
            ...('sha256' in input ? { sha256: input.sha256 } : {}),
          },
          key,
        )
      : await reserveMedia(client, credential, input, key);
  return Response.json(publicMedia(media), {
    status: 201,
    headers: { location: `/media/${encodeURIComponent(media.id)}`, 'cache-control': 'private, no-store' },
  });
}

export async function avatarUploadAdvice(request: Request, env: MediaEnv): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length) throw invalidRequest();
  const credential = viewerCredential(request);
  const viewerId = sessionSubject(request);
  if (!credential || !viewerId) throw problem(401, 'authentication_required', 'Authentication Required');
  const advice = await readAvatarUploadAdvice(mediaClient(env.KERNEL_ORIGIN), credential, viewerId);
  const parsed = parseAvatarUploadAdvice(advice, viewerId);
  if (!parsed) throw problem(502, 'dependency_unavailable', 'Dependency Unavailable');
  return Response.json(parsed, { headers: { 'cache-control': 'private, no-store' } });
}

export async function read(request: Request, id: string, env: MediaEnv): Promise<Response> {
  const media = await readReservation(mediaClient(env.KERNEL_ORIGIN), id, viewerCredential(request));
  return Response.json(publicMedia(media), { headers: { 'cache-control': 'private, no-store' } });
}
