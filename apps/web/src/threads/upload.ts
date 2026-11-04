import type { FutureThreadUploadEpisode } from './thread-upload-episode/episode';
import { sessionCsrfToken } from '../session/query';
import type { DocumentNode, DocumentSnapshot } from '@rezics/document';
import type { UploadedImage } from '@rezics/ui';
import type { ReservationInput } from '../media/kernel';
import { isPlatformClosedProblem } from '../kernel/platform-closed.ts';

/** Kernel reservation accepts only these image types. */
const postImageTypes = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'] as const;
type PostImageType = (typeof postImageTypes)[number];
const _typeListCoversContract: ReservationInput['mediaType'] extends PostImageType ? true : never = true;
const _contractCoversTypeList: PostImageType extends ReservationInput['mediaType'] ? true : never = true;

/** Kernel reservation rejects a byteCount above 20 MiB. */
const postImageByteLimit = 20 * 1024 * 1024;
export const replyImageLimit = 32;

const initialDelay = 250;
const maxDelay = 2_000;
const maxWait = 60_000;
const maxReads = 32;

export type UploadRefusalReason = 'closed' | 'type' | 'too-large' | 'rejected' | 'rate-limited' | 'unavailable';

export class UploadRefusal extends Error {
  readonly reason: UploadRefusalReason;
  readonly retryAfter?: number;
  retryAfterHeader?: string;
  responseTime?: number;
  /** Retain a known reservation when completion or processing has an uncertain outcome. */
  mediaId?: string;
  constructor(reason: UploadRefusalReason, retryAfter?: number) {
    super(reason);
    this.name = 'UploadRefusal';
    this.reason = reason;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

type ReservedMedia = { id: string; state: string; mediaType: string; byteCount: number; containerId?: string };
type FutureThread = { boardId: string; idempotencyKey: string };
type PostReserveTarget = string | { containerId: string } | { newThread: FutureThread };
type ReserveTarget = PostReserveTarget | { realmId: string };
type ImagePurpose = 'post-image' | 'avatar' | 'realm-icon' | 'realm-banner';
export type UploadStage = 'reservation' | 'transfer' | 'processing';
export type MediaReservationIntent = Readonly<{
  key: string;
  body: Readonly<ReturnType<typeof reserveBody>>;
  file: File;
  viewer: string;
}>;

/** One attachment's original commands. A disclosed container gets its own immutable reservation command. */
export type ReplyImageReservation = {
  original: MediaReservationIntent;
  container?: MediaReservationIntent;
};
export type ReplyImageUploadOptions = {
  episode?: FutureThreadUploadEpisode;
  reservation: ReplyImageReservation;
  onStage?: (stage: UploadStage) => void;
};

function isPostImageType(value: string): value is PostImageType {
  return (postImageTypes as readonly string[]).includes(value);
}

function csrfToken(): string {
  return sessionCsrfToken() ?? '';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): DOMException {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === 'AbortError') return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000)));
}

async function refusalFrom(response: Response): Promise<UploadRefusal> {
  if (response.status === 403) {
    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    if (isPlatformClosedProblem(response.status, body)) {
      await response.body?.cancel().catch(() => {});
      return new UploadRefusal('closed');
    }
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 415) return new UploadRefusal('type');
  if (response.status === 413) return new UploadRefusal('too-large');
  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    if (retryAfter === undefined) return new UploadRefusal('rate-limited');
    return new UploadRefusal('rate-limited', retryAfter);
  }
  return new UploadRefusal('unavailable');
}

function siteFetch(path: string, init: RequestInit & { method: string }): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method !== 'GET' && init.method !== 'HEAD') headers.set('X-CSRF-Token', csrfToken());
  return fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers });
}

function containerIdFrom(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.containerId === 'string' && record.containerId !== '') return record.containerId;
  const media = record.media;
  if (!media || typeof media !== 'object') return null;
  const containerId = (media as Record<string, unknown>).containerId;
  return typeof containerId === 'string' && containerId !== '' ? containerId : null;
}

function mediaOf(value: unknown): ReservedMedia | null {
  if (!value || typeof value !== 'object' || !('media' in value)) return null;
  const media = (value as { media: unknown }).media;
  if (!media || typeof media !== 'object') return null;
  const record = media as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id === '' ||
    typeof record.state !== 'string' ||
    typeof record.mediaType !== 'string' ||
    typeof record.byteCount !== 'number'
  )
    return null;
  const containerId = record.containerId;
  return {
    id: record.id,
    state: record.state,
    mediaType: record.mediaType,
    byteCount: record.byteCount,
    ...(typeof containerId === 'string' && containerId !== '' ? { containerId } : {}),
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function bitmapSize(file: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function elementSize(file: Blob, signal: AbortSignal): Promise<{ width: number; height: number }> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const onAbort = () => {
      image.src = '';
      URL.revokeObjectURL(url);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    image.onload = () => {
      signal.removeEventListener('abort', onAbort);
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(size);
    };
    image.onerror = () => {
      signal.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
      reject(new UploadRefusal('unavailable'));
    };
    image.src = url;
  });
}

async function naturalSize(file: Blob, signal: AbortSignal): Promise<{ width: number; height: number }> {
  throwIfAborted(signal);
  let size: { width: number; height: number };
  if (typeof createImageBitmap === 'function') {
    try {
      size = await bitmapSize(file);
    } catch (error) {
      if (isAbort(error) || error instanceof UploadRefusal) throw error;
      size = await elementSize(file, signal);
    }
  } else size = await elementSize(file, signal);
  throwIfAborted(signal);
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1)
    throw new UploadRefusal('unavailable');
  return size;
}

function reserveBody(target: ReserveTarget, file: File, purpose: ImagePurpose) {
  const image = { purpose, mediaType: file.type, byteCount: file.size };
  if (typeof target === 'string') return { containerId: target, ...image };
  if ('containerId' in target) return { containerId: target.containerId, ...image };
  if ('realmId' in target) return { realmId: target.realmId, ...image };
  return { newThread: Object.freeze({ ...target.newThread }), ...image };
}

export function createMediaReservationIntent(
  target: ReserveTarget,
  file: File,
  purpose: ImagePurpose,
  viewer: string,
): MediaReservationIntent {
  return Object.freeze({
    key: crypto.randomUUID(),
    body: Object.freeze(reserveBody(target, file, purpose)),
    file,
    viewer,
  });
}

async function reserve(
  target: ReserveTarget,
  file: File,
  signal: AbortSignal,
  purpose: ImagePurpose,
  intent?: MediaReservationIntent,
  options?: ReplyImageUploadOptions,
): Promise<ReservedMedia> {
  throwIfAborted(signal);
  options?.episode?.assertCurrent();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (intent) headers['idempotency-key'] = JSON.stringify(intent.key);
  const response = await siteFetch('/media', {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify(intent?.body ?? reserveBody(target, file, purpose)),
  });
  throwIfAborted(signal);
  options?.episode?.assertCurrent();
  if (response.status === 409 && typeof target !== 'string' && 'newThread' in target) {
    const disclosed = containerIdFrom(await response.json().catch(() => undefined));
    throwIfAborted(signal);
    options?.episode?.assertCurrent();
    const known = options?.episode?.containerId ?? disclosed;
    if (!known) throw new UploadRefusal('unavailable');
    options?.episode?.remember(known);
    // Recovery repeats this exact command even if its response is lost.
    const reservation = options?.reservation;
    if (reservation && !reservation.container)
      reservation.container = createMediaReservationIntent({ containerId: known }, file, purpose, intent!.viewer);
    return reserve({ containerId: known }, file, signal, purpose, reservation?.container, options);
  }
  if (!response.ok) throw await refusalFrom(response);
  const payload = await response.json();
  throwIfAborted(signal);
  options?.episode?.assertCurrent();
  const media = mediaOf(payload);
  if (!media) throw new UploadRefusal('unavailable');
  if (typeof target !== 'string' && 'newThread' in target) {
    const containerId = containerIdFrom(payload);
    if (containerId) options?.episode?.remember(containerId);
  }
  return media;
}

async function putBytes(media: ReservedMedia, file: File, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const response = await siteFetch(`/media/${encodeURIComponent(media.id)}`, {
    method: 'PUT',
    signal,
    headers: { 'content-type': media.mediaType },
    body: file.slice(0, file.size, media.mediaType),
  });
  if (!response.ok) throw await refusalFrom(response);
  await response.body?.cancel().catch(() => {});
}

async function readReservation(id: string, signal: AbortSignal): Promise<ReservedMedia> {
  const response = await siteFetch(`/media/${encodeURIComponent(id)}`, { method: 'GET', signal });
  if (!response.ok) throw await refusalFrom(response);
  const media = mediaOf(await response.json());
  if (!media || media.id !== id) throw new UploadRefusal('unavailable');
  return media;
}

async function poll(
  id: string,
  signal: AbortSignal,
  initial?: ReservedMedia,
  started = Date.now(),
): Promise<ReservedMedia> {
  let delay = initialDelay;
  for (let read = 0; read < maxReads; read += 1) {
    throwIfAborted(signal);
    const media = read === 0 && initial ? initial : await readReservation(id, signal);
    throwIfAborted(signal);
    if (media.state === 'available' || media.state === 'rejected') return media;
    const wait = Math.min(delay, maxDelay);
    delay = Math.min(delay * 2, maxDelay);
    if (read === maxReads - 1 || Date.now() + wait - started > maxWait) break;
    await pause(wait, signal);
  }
  throw new UploadRefusal('unavailable');
}

async function readUploadedImage(
  mediaId: string,
  file: File,
  signal: AbortSignal,
  initial?: ReservedMedia,
  started?: number,
): Promise<UploadedImage> {
  try {
    const settled = await poll(mediaId, signal, initial, started);
    if (settled.state !== 'available') throw new UploadRefusal('rejected');
    const size = await naturalSize(file, signal);
    return { src: mediaId, width: size.width, height: size.height };
  } catch (error) {
    throwIfAborted(signal);
    if (isAbort(error)) throw error;
    const failure = error instanceof UploadRefusal ? error : new UploadRefusal('unavailable');
    failure.mediaId = mediaId;
    throw failure;
  }
}

/** Reserve a post image on a thread or a future thread, upload its bytes, and resolve once content accepts it. */
async function uploadImage(
  target: ReserveTarget,
  file: File,
  signal: AbortSignal,
  purpose: ImagePurpose,
  intent?: MediaReservationIntent,
  onStage?: (stage: UploadStage) => void,
  options?: ReplyImageUploadOptions,
): Promise<UploadedImage> {
  let mediaId: string | undefined;
  try {
    throwIfAborted(signal);
    if (!isPostImageType(file.type)) throw new UploadRefusal('type');
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadRefusal('unavailable');
    if (file.size > postImageByteLimit) throw new UploadRefusal('too-large');
    if (
      intent &&
      (intent.file !== file ||
        intent.body.purpose !== purpose ||
        (purpose === 'avatar' && 'containerId' in intent.body && intent.body.containerId !== intent.viewer))
    )
      throw new UploadRefusal('unavailable');
    onStage?.('reservation');
    const reserved = await reserve(target, file, signal, purpose, intent, options);
    mediaId = reserved.id;
    throwIfAborted(signal);
    onStage?.('transfer');
    await putBytes(reserved, file, signal);
    throwIfAborted(signal);
    onStage?.('processing');
    return await readUploadedImage(mediaId, file, signal);
  } catch (error) {
    throwIfAborted(signal);
    if (isAbort(error)) throw error;
    const failure = error instanceof UploadRefusal ? error : new UploadRefusal('unavailable');
    if (mediaId !== undefined) failure.mediaId = mediaId;
    throw failure;
  }
}

export function uploadReplyImage(
  target: PostReserveTarget,
  file: File,
  signal: AbortSignal,
  options?: ReplyImageUploadOptions,
): Promise<UploadedImage> {
  const command = options?.reservation.container ?? options?.reservation.original;
  const originalTarget = command?.body;
  const reservedTarget =
    originalTarget && 'containerId' in originalTarget ? { containerId: originalTarget.containerId! } : target;
  return uploadImage(reservedTarget, file, signal, 'post-image', command, options?.onStage, options);
}

/** Resume only missing bytes on the original reservation, then observe its native processing state. */
export async function resumeReplyImageUpload(
  mediaId: string,
  file: File,
  signal: AbortSignal,
  onStage?: (stage: UploadStage) => void,
): Promise<UploadedImage> {
  const started = Date.now();
  try {
    throwIfAborted(signal);
    if (!isPostImageType(file.type)) throw new UploadRefusal('type');
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadRefusal('unavailable');
    if (file.size > postImageByteLimit) throw new UploadRefusal('too-large');
    onStage?.('processing');
    const current = await readReservation(mediaId, signal);
    throwIfAborted(signal);
    if (current.mediaType !== file.type || current.byteCount !== file.size) throw new UploadRefusal('unavailable');
    if (current.state === 'rejected') throw new UploadRefusal('rejected');
    if (current.state === 'reserved') {
      onStage?.('transfer');
      await putBytes(current, file, signal);
      throwIfAborted(signal);
      onStage?.('processing');
    }
    return await readUploadedImage(mediaId, file, signal, current, started);
  } catch (error) {
    throwIfAborted(signal);
    if (isAbort(error)) throw error;
    const failure = error instanceof UploadRefusal ? error : new UploadRefusal('unavailable');
    failure.mediaId = mediaId;
    throw failure;
  }
}

export function uploadAvatar(
  accountId: string,
  file: File,
  signal: AbortSignal,
  intent?: MediaReservationIntent,
  onStage?: (stage: UploadStage) => void,
): Promise<UploadedImage> {
  if (intent && intent.viewer !== accountId) return Promise.reject(new UploadRefusal('unavailable'));
  return uploadImage({ containerId: accountId }, file, signal, 'avatar', intent, onStage);
}

export async function readSiteAvatarUploadAdvice(signal: AbortSignal): Promise<{
  ok: true;
  body: unknown;
  retryAfter?: string;
  responseTime: number;
}> {
  const response = await siteFetch('/media/avatar-upload-advice', { method: 'GET', signal });
  const responseTime = Date.now();
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  if (!response.ok) {
    const refusal = await refusalFrom(response);
    if (retryAfter !== undefined) refusal.retryAfterHeader = retryAfter;
    refusal.responseTime = responseTime;
    throw refusal;
  }
  try {
    return {
      ok: true,
      body: await response.json(),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      responseTime,
    };
  } catch {
    const refusal = new UploadRefusal('unavailable');
    if (retryAfter !== undefined) refusal.retryAfterHeader = retryAfter;
    refusal.responseTime = responseTime;
    throw refusal;
  }
}

/** Realm uploads reuse the uploader-bound byte/digest/completion pipeline; previews need a native derivative summary. */
export async function uploadRealmImage(
  realmId: string,
  purpose: 'realm-icon' | 'realm-banner',
  file: File,
  signal: AbortSignal,
): Promise<{ id: string }> {
  let mediaId: string | undefined;
  try {
    throwIfAborted(signal);
    if (!isPostImageType(file.type)) throw new UploadRefusal('type');
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadRefusal('unavailable');
    if (file.size > postImageByteLimit) throw new UploadRefusal('too-large');
    const reserved = await reserve({ realmId }, file, signal, purpose);
    mediaId = reserved.id;
    throwIfAborted(signal);
    await putBytes(reserved, file, signal);
    return await finishRealmUpload(mediaId, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    const failure = error instanceof UploadRefusal ? error : new UploadRefusal('unavailable');
    if (mediaId) failure.mediaId = mediaId;
    throw failure;
  }
}

async function finishRealmUpload(mediaId: string, signal: AbortSignal): Promise<{ id: string }> {
  const settled = await poll(mediaId, signal);
  if (settled.state !== 'available') throw new UploadRefusal('rejected');
  return { id: mediaId };
}

/**
 * Re-read the original reservation before any byte transfer.
 * Purpose stays with the caller: this read has no purpose field.
 */
export async function resumeRealmImageUpload(
  mediaId: string,
  file: File,
  realmId: string,
  signal: AbortSignal,
): Promise<{ id: string }> {
  try {
    throwIfAborted(signal);
    if (!isPostImageType(file.type)) throw new UploadRefusal('type');
    if (!Number.isSafeInteger(file.size) || file.size < 1) throw new UploadRefusal('unavailable');
    if (file.size > postImageByteLimit) throw new UploadRefusal('too-large');
    const current = await readReservation(mediaId, signal);
    throwIfAborted(signal);
    if (current.containerId !== realmId || current.mediaType !== file.type || current.byteCount !== file.size)
      throw new UploadRefusal('unavailable');
    if (current.state === 'rejected') throw new UploadRefusal('rejected');
    throwIfAborted(signal);
    if (current.state === 'reserved') await putBytes(current, file, signal);
    return await finishRealmUpload(mediaId, signal);
  } catch (error) {
    throwIfAborted(signal);
    if (isAbort(error)) throw error;
    const failure = error instanceof UploadRefusal ? error : new UploadRefusal('unavailable');
    failure.mediaId = mediaId;
    throw failure;
  }
}

/** Distinct image sources in document order. */
export function imageSources(snapshot: DocumentSnapshot): string[] {
  const sources: string[] = [];
  const visit = (node: DocumentNode): void => {
    if (node.type === 'image') {
      const src = node.attrs?.src;
      if (typeof src === 'string' && src.length > 0 && !sources.includes(src)) sources.push(src);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(snapshot.doc);
  return sources;
}
