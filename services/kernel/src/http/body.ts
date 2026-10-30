import { ProblemError } from './problem.ts';
import { RELEASE_LIMITS } from '@rezics/definitions';
import { parseStrictJson } from './strict-json.ts';

export const DEFAULT_BODY_LIMIT = 1_048_576;
export const MAX_BODY_LIMIT = RELEASE_LIMITS.bytes + 65_536;
export type BodyMode = 'json' | 'raw';
type OwnedBody = Readonly<{ bytes: Uint8Array; wireBytes: number }>;
const bodies = new WeakMap<Request, OwnedBody>();

export class IngressBodyBudget {
  private used = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Ingress body budget must be positive');
  }

  get reserved(): number {
    return this.used;
  }

  reserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.used -= bytes;
    if (this.used < 0) throw new Error('Ingress body reservation underflow');
  }
}

export function requestBody(request: Request): OwnedBody | undefined {
  return bodies.get(request);
}

export function bodyWireBytes(request: Request): number | undefined {
  return bodies.get(request)?.wireBytes;
}

export function bodyBytes(request: Request): Uint8Array | undefined {
  return bodies.get(request)?.bytes;
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new ProblemError('invalid_request');
    if (length > limit) throw new ProblemError('content_too_large');
  }
  const reader = request.body?.getReader();
  if (!reader) {
    const empty = new Uint8Array();
    bodies.set(request, Object.freeze({ bytes: empty, wireBytes: 0 }));
    return empty;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ProblemError('content_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const owned = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    owned.set(chunk, offset);
    offset += chunk.byteLength;
  }
  bodies.set(request, Object.freeze({ bytes: owned, wireBytes: length }));
  return owned;
}

export async function parseBoundedBody(request: Request, limit: number, mode: BodyMode): Promise<unknown> {
  if (request.body === null) {
    await readBoundedBody(request, limit);
    return undefined;
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mode === 'json' && mediaType !== 'application/json' && !mediaType?.endsWith('+json'))
    throw new ProblemError('invalid_request');
  const bytes = await readBoundedBody(request, limit);
  if (mode === 'raw') return bytes;
  try {
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProblemError('invalid_request');
  }
}

export function bodyLimitOf(detail: Record<string, unknown> | undefined): number {
  const limit = detail?.['x-body-limit'];
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_BODY_LIMIT;
}

export function bodyModeOf(detail: Record<string, unknown> | undefined): BodyMode {
  return detail?.['x-body-mode'] === 'raw' ? 'raw' : 'json';
}
