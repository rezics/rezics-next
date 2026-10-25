import { createKernelClient, type KernelClient } from '@rezics/client';
import type { BatchWriteRequest, BatchWriteResult, FieldGroup } from '@rezics/definitions/bulk';
import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import { createImportFetch } from '../services/importer/src/import-fetch';

/** Observations of public client operations, not a second portable wire schema. */
export interface ImportTransport {
  /** Validate entire portable result and match ordered keys before returning acknowledgements. */
  batch(body: BatchWriteRequest, signal?: AbortSignal): Promise<BatchWriteResult>;
  /** Transport rejects oversize requests; this production batching owner splits by count AND bytes. */
  batches(commands: BatchWriteRequest['commands'], signal?: AbortSignal): Promise<BatchWriteResult[]>;
  fence(tuple: FenceTuple, signal?: AbortSignal): Promise<{ fenced: boolean; securityRevision: string | null }>;
  /** Production orchestration: fresh fence lookup on EVERY refresh, including unchanged input.
   * No baseline advancement here. A fenced cover must prevent the next upload. */
  refreshCover(tuple: FenceTuple, body: MediaImportRequest, key: string, signal?: AbortSignal): Promise<MediaOutcome>;
  media(body: MediaImportRequest, key: string, signal?: AbortSignal): Promise<MediaOutcome>;
}
export interface FenceTuple {
  source: string;
  externalId: string;
  fieldGroup: FieldGroup;
}
export type MediaOutcome =
  | { outcome: 'available'; id: string; status: MediaImportStatus }
  | { outcome: 'pending'; status: MediaImportStatus }
  | { outcome: 'rejected'; code: string; status: MediaImportStatus }
  | { outcome: 'fenced' };
export interface TransportOptions {
  origin: string;
  tokenProvider: () => Promise<string>;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  maxAttempts: number;
  maxBodyBytes: number;
  pollAttempts: number;
  pollDelayMs: number;
  session?: string;
  onSession?: (token: string) => void;
}
/**
 * Absolute path/URL exporting createImportTransport. Bind future services/importer
 * public bulk/media/fence wrappers and batching/refresh orchestration only.
 * The factory receives the ACTUAL @rezics/client and existing retry/token adapter;
 * use these instances for all requests. No driver transport, validators, session,
 * media state machine, receipts, successful response synthesis or outcome tables.
 * The suite's fetch callback is a fake remote API for client semantics. It proves
 * no server Auth/Access/job/security enforcement; real API suites own that proof.
 * Ordinary bearer scope media:import_from_url (never media:importFromUrl), with
 * subject:batch_write/source_fence:read as needed, is provisioned externally ONLY
 * on Global {route:0,id:00000000-0000-8000-8000-000000000000}. No grant creation,
 * per-subject grants, service tokens, database access or website/BFF dependency.
 * Use actual portable request/result validators over entire bodies. No competing
 * schema, invented record revision or UUID, image download/relay or baseline write.
 * Status reads use uploader/current media:read_reservation authority. Production
 * disclosure enforcement and final takedown checks belong to the separate API suite.
 */
export async function loadImportTransport(options: TransportOptions): Promise<ImportTransport> {
  const path = process.env.IMPORT_TRANSPORT_DRIVER;
  if (!path) throw new Error('IMPORT_TRANSPORT_DRIVER is required: bind the production importer public transport');
  const importFetch = createImportFetch({
    origin: options.origin,
    token: options.tokenProvider,
    fetch: options.fetch,
    sleep: options.sleep,
    now: options.now,
    maxAttempts: options.maxAttempts,
    maxBodyBytes: options.maxBodyBytes,
  });
  const client = createKernelClient(options.origin, {
    fetch: importFetch,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.onSession === undefined ? {} : { onSession: options.onSession }),
  });
  const factory: (options: TransportOptions & { client: KernelClient; importFetch: typeof fetch }) => ImportTransport =
    (await import(path)).createImportTransport;
  return factory({ ...options, client, importFetch });
}
