import { viewerCredential } from '../session/request.ts';
import { mediaClient, problem, readReservation, reserveMedia, type Media, type ReservationInput } from './kernel.ts';
import type { MediaEnv } from './index.ts';

const invalidRequest = () => problem(400, 'invalid_request', 'Invalid Request');
const bodyLimit = 4 * 1024;
const imageTypes = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'];
const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function imageFields(fields: Record<string, unknown>) {
  if (
    (fields.purpose !== 'post-image' && fields.purpose !== 'avatar') ||
    typeof fields.mediaType !== 'string' ||
    !imageTypes.includes(fields.mediaType) ||
    typeof fields.byteCount !== 'number' ||
    !Number.isSafeInteger(fields.byteCount) ||
    fields.byteCount < 1 ||
    ('sha256' in fields && (typeof fields.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fields.sha256)))
  )
    throw invalidRequest();
  const shared = {
    purpose: fields.purpose as 'post-image' | 'avatar',
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

async function reservationInput(request: Request): Promise<ReservationInput> {
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
      (key) => !['containerId', 'newThread', 'purpose', 'mediaType', 'byteCount', 'sha256'].includes(key),
    )
  )
    throw invalidRequest();
  const hasContainer = Object.prototype.hasOwnProperty.call(fields, 'containerId');
  const hasFuture = Object.prototype.hasOwnProperty.call(fields, 'newThread');
  if (hasContainer === hasFuture) throw invalidRequest();
  const shared = imageFields(fields);
  if (hasContainer) {
    if (typeof fields.containerId !== 'string') throw invalidRequest();
    if (shared.purpose === 'avatar' && !contentId.test(fields.containerId)) throw invalidRequest();
    return { containerId: fields.containerId, ...shared };
  }
  if (shared.purpose === 'avatar') throw invalidRequest();
  return { newThread: futureThread(fields.newThread), ...shared, purpose: 'post-image' };
}

function publicMedia({ id, state, mediaType, byteCount, sha256, containerId }: Media) {
  return { media: { id, state, mediaType, byteCount, sha256, containerId } };
}

export async function reserve(request: Request, env: MediaEnv): Promise<Response> {
  const input = await reservationInput(request);
  const media = await reserveMedia(mediaClient(env.KERNEL_ORIGIN), viewerCredential(request), input);
  return Response.json(publicMedia(media), {
    status: 201,
    headers: { location: `/media/${encodeURIComponent(media.id)}`, 'cache-control': 'private, no-store' },
  });
}

export async function read(request: Request, id: string, env: MediaEnv): Promise<Response> {
  const media = await readReservation(mediaClient(env.KERNEL_ORIGIN), id, viewerCredential(request));
  return Response.json(publicMedia(media), { headers: { 'cache-control': 'private, no-store' } });
}
