import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { Owner, RecordBindings } from '../services/importer/src/record-bindings.ts';

export const INVALID_MEDIA_RESOLVER_DRIVER =
  'IMPORT_MEDIA_RESOLVER_DRIVER must name a module exporting createMediaResolver';

/** Ordinary public JSON operations, with HTTP status preserved for validation. */
export interface MediaFencePort {
  fence(
    tuple: { source: string; externalId: string; fieldGroup: 'cover' },
    signal: AbortSignal,
  ): Promise<{ fenced: boolean; securityRevision: string | null }>;
  /** Exact journal bytes, not a reserialized request; returns the actual 202 body. */
  request(bytes: string, key: string, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  status(id: string, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}
export interface ResolveMediaInput {
  owner: Owner;
  containerId: string;
  mediaImportIntents: readonly MediaImportRequest[];
  signal: AbortSignal;
}
export type MediaResolution =
  | { outcome: 'fenced'; securityRevision: string; mediaIds: Record<string, never> }
  | {
      outcome: 'resolved';
      mediaIds: Record<string, string>;
      assets: { sourceUrl: string; key: string; outcome: 'available' | 'pending' | 'rejected' }[];
    };
export interface MediaResolver {
  resolve(input: ResolveMediaInput): Promise<MediaResolution>;
}
export interface MediaResolverOptions {
  bindings: RecordBindings;
  port: MediaFencePort;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Lower only: defaults 5 reads, 1000ms delay; <=4000ms scheduled waits per asset. */
  pollAttempts?: number;
  pollDelayMs?: number;
}
export type CreateMediaResolver = (options: MediaResolverOptions) => MediaResolver;

/**
 * TEST ONLY. Exact future services/importer/src/media-resolver.ts adapter:
 * export function createMediaResolver(options: MediaResolverOptions): MediaResolver.
 * IMPORT_MEDIA_RESOLVER_DRIVER exports that production function directly. This
 * loader only forwards supplied dependencies. No lifecycle, journal, key/UUID
 * generation, validation, network client or successful result synthesis here.
 *
 * Compose the caller's actual RecordBindings and ordinary public raw port. The
 * combined transport.media() API cannot implement the durable acceptance boundary.
 * prepareMedia precedes POST; acceptMedia precedes the FIRST GET; observeMedia
 * precedes disclosure. On uncertain POST replay exact journal bytes/key. Identity
 * uses source/record/version/converter/digest/URL/credit; keys are source-prefixed
 * bounded hashes (source:external_id:<hash>, <=255 bytes), stable across processes,
 * never invented revisions.
 * Multiple assets use their exact journals, not the store's single cover_key.
 * Each invocation queries the current tuple-home cover fence once, even with
 * unchanged metadata/available cache. Fence errors fail closed; fenced returns
 * the actual string securityRevision unchanged and no media IDs or media calls.
 * Caller remains responsible for final disclosure protection and source baseline.
 * Rejection is explicit, never an instruction to complete the source baseline.
 *
 * <=64 assets, <=64KiB each portable request/status. At most four in-flight calls:
 * <=64*(1 POST + 5 GET) logical media calls plus one fence per invocation. Accepted
 * resumes do not POST. No unbounded loop or extra resolver retries; production
 * createImportFetch owns the separate bounded HTTP retry budget. Config can only
 * lower polling limits. Exact keyed operations O(log N), bounded bytes per asset;
 * no page/history enumeration or duplicate durable mapping authority.
 *
 * Production request/status bodies use @rezics/definitions/media-import ONLY.
 * Ordinary action AND scope media:import_from_url on Global Context
 * {route:0,id:00000000-0000-8000-8000-000000000000}; containerId is placement only.
 * No grants creation, website/BFF, image bytes, media:complete or kernel SQL.
 * The remote fake in the suite is a unit boundary, not authorization/API proof.
 */
export async function loadMediaResolver(suppliedPath?: string): Promise<CreateMediaResolver> {
  const configuredPath = suppliedPath ?? process.env.IMPORT_MEDIA_RESOLVER_DRIVER;
  const path =
    configuredPath === undefined
      ? new URL('../services/importer/tests/media-resolver-driver.ts', import.meta.url).href
      : configuredPath;
  if (!path) throw new Error(INVALID_MEDIA_RESOLVER_DRIVER);
  const binding: unknown = await import(path);
  if (
    binding === null ||
    typeof binding !== 'object' ||
    !('createMediaResolver' in binding) ||
    typeof binding.createMediaResolver !== 'function'
  )
    throw new TypeError(INVALID_MEDIA_RESOLVER_DRIVER);
  return binding.createMediaResolver as CreateMediaResolver;
}
