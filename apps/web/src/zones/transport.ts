import { SESSION_HEADER } from '@rezics/client';
import { setResponseHeader } from '@tanstack/react-start/server';
import {
  clearCookie,
  prepareSession,
  SESSION_COOKIE,
  viewerCredential,
  type ReadCredentialMode,
  type SessionEnv,
} from '../kernel/client';
import type { ZoneSessionBinding } from './session.ts';
import { zoneKernelHeaders, zoneSessionRevoked } from './session.ts';

export type ZoneRequestTransport = ZoneSessionBinding & {
  /** True when the current cookie must be cleared: revoked, suspended, or absent. */
  stale: boolean;
  /** True when a session read was requested and no current credential remains. */
  revoked: boolean;
};

const mediaId = /^[A-Za-z0-9_-]+$/;
const mediaVariant = /^(?:original|cover|thumb|[1-9][0-9]{1,3})$/;
const sha256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One current personal BFF session for a served Zone read. Anonymous SSR stays credential-free.
 * A signed-in reread calls `prepareSession` again, so revocation and suspension take effect here
 * rather than on a cached bearer. Upload and download stay on the existing `/media` driver and
 * reuse this credential on the next request.
 */
export async function zoneRequestTransport(
  request: Request,
  env: Partial<SessionEnv>,
  credentialMode: ReadCredentialMode | undefined,
): Promise<ZoneRequestTransport> {
  if (credentialMode !== 'session') return { stale: false, revoked: false };
  const stale = await prepareSession(request, env);
  const authorization = viewerCredential(request) ?? undefined;
  const kernelSession = request.headers.get(SESSION_HEADER) ?? undefined;
  const binding: ZoneSessionBinding = {
    ...(authorization === undefined ? {} : { authorization }),
    ...(kernelSession === undefined ? {} : { kernelSession }),
  };
  return {
    ...binding,
    stale,
    revoked: zoneSessionRevoked(binding, 'session'),
  };
}

/** Clear a revoked or absent session cookie on the Zone BFF response. */
export function applyZoneTransport(transport: ZoneRequestTransport): ZoneRequestTransport {
  setResponseHeader('cache-control', 'private, no-store');
  if (transport.stale) setResponseHeader('set-cookie', clearCookie(SESSION_COOKIE));
  return transport;
}

export function zoneTransportHeaders(
  transport: ZoneRequestTransport,
  kernelSession?: string,
): { authorization?: string; [SESSION_HEADER]?: string } | undefined {
  if (transport.revoked) return;
  return zoneKernelHeaders(transport, kernelSession);
}

export type ZoneMediaIntent = {
  purpose: 'post-image';
  mediaType: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  byteCount: number;
  sha256?: string;
};

const imageTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);

/** Boundary input for a Zone-originated upload intent. The existing `/media` POST owns reservation. */
export function receiveZoneMediaIntent(value: unknown): ZoneMediaIntent | undefined {
  if (!isRecord(value) || value.purpose !== 'post-image') return;
  if (typeof value.mediaType !== 'string' || !imageTypes.has(value.mediaType)) return;
  if (typeof value.byteCount !== 'number' || !Number.isSafeInteger(value.byteCount) || value.byteCount < 1) return;
  if (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !sha256.test(value.sha256))) return;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'purpose' && key !== 'mediaType' && key !== 'byteCount' && key !== 'sha256')) return;
  return {
    purpose: 'post-image',
    mediaType: value.mediaType as ZoneMediaIntent['mediaType'],
    byteCount: value.byteCount,
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
  };
}

export type ZoneMediaCompletion = { sha256: string };

export function receiveZoneMediaCompletion(value: unknown): ZoneMediaCompletion | undefined {
  if (!isRecord(value) || Object.keys(value).join() !== 'sha256' || typeof value.sha256 !== 'string') return;
  if (!sha256.test(value.sha256)) return;
  return { sha256: value.sha256 };
}

export type ZoneDownloadRequest = { id: string; variant: string };

export function receiveZoneDownloadRequest(value: unknown): ZoneDownloadRequest | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.variant !== 'string') return;
  if (!mediaId.test(value.id) || !mediaVariant.test(value.variant)) return;
  return { id: value.id, variant: value.variant };
}

export type ZoneMediaCall<Result> = (credential: string | null) => Promise<Result>;

/**
 * Run an existing personal media driver with the current Zone session. A revoked or suspended
 * reader supplies no credential, so the next download authorization, upload intent or completion
 * is refused by the same kernel media routes the rest of the site uses.
 */
export async function withZoneMediaCredential<Result>(
  transport: ZoneRequestTransport,
  call: ZoneMediaCall<Result>,
): Promise<Result> {
  return call(transport.revoked ? null : (transport.authorization ?? null));
}

export type ZoneDownloadDecision = { allowed: true } | { allowed: false };

/** Download concealment matches the existing media driver: a failed decision is not found. */
export async function zoneDownloadAuthorization(
  transport: ZoneRequestTransport,
  authorize: ZoneMediaCall<ZoneDownloadDecision>,
): Promise<ZoneDownloadDecision> {
  if (transport.revoked) return { allowed: false };
  try {
    return await withZoneMediaCredential(transport, authorize);
  } catch {
    return { allowed: false };
  }
}

export type ZoneUploadOutcome<Media> = { kind: 'media'; media: Media } | { kind: 'unsigned' };

export async function zoneUploadIntent<Media>(
  transport: ZoneRequestTransport,
  intent: ZoneMediaIntent,
  reserve: (credential: string, intent: ZoneMediaIntent) => Promise<Media>,
): Promise<ZoneUploadOutcome<Media>> {
  if (transport.revoked || transport.authorization === undefined) return { kind: 'unsigned' };
  return { kind: 'media', media: await reserve(transport.authorization, intent) };
}

export async function zoneUploadCompletion<Completion>(
  transport: ZoneRequestTransport,
  completion: ZoneMediaCompletion,
  complete: (credential: string, completion: ZoneMediaCompletion) => Promise<Completion>,
): Promise<ZoneUploadOutcome<Completion>> {
  if (transport.revoked || transport.authorization === undefined) return { kind: 'unsigned' };
  return { kind: 'media', media: await complete(transport.authorization, completion) };
}
