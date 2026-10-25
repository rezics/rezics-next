/**
 * TEST ONLY. IMPORT_BINDINGS_DRIVER exports openRecordBindings(database).
 * Forward directly to future importer-owned RecordBindings on this caller's real
 * SQLite handle. The caller installs the shared probe BEFORE any preparation.
 * No model state, generated IDs, transport, kernel SQL, source policy, fence
 * evaluation, acknowledged-record metadata or run-baseline writes belong here.
 * Every method is synchronous, including transactions, so all real executions
 * are visible to the shared SQLite probe. Do not open another database.
 *
 * Keys are source-leading exact (source, external_id), never subject-only.
 * prepare journals exact serialized public request bytes and planner-supplied
 * key before returning. Its signature is a private converter/planner identity,
 * never a random native UUID. Uncertain bootstrap cannot be replaced by changed
 * source payload. A resolved or terminal claim never needs another create.
 * Actual matching 200/201 create results alone bind subjects; propose results
 * alone bind candidates. Retraction removes only its exact owned candidate after
 * acknowledgement. Replayed acknowledgement is idempotent, including removal.
 * Journal identity survives replay after remote success/local mapping failure.
 *
 * Current candidate index retains only current owned IDs and original request
 * attachment/signature, not history or adopted community statements. Page seeks
 * exact source/external/group plus exclusive candidate cursor, <=100 entries.
 * At most 100 current/pending candidates per group, 300 per record, bounded
 * request/status bytes; historical journals may remain keyed, never scanned by
 * current operations. Rejections are atomic and diagnostics never echo inputs.
 *
 * Media prepare persists the COMPLETE portable request/key; acceptance binds only
 * actual 202 reserved ID/container/purpose. Status snapshots must preserve that
 * identity AND original credit/provenance. Only current available ID is exposed
 * to the pure converter's mediaIds; reserved/uploaded never appear there.
 * Rejected is terminal for that job. URL/version replacement policy belongs to
 * the coordinator, which explicitly supplies a new key. Fenced omission also
 * belongs there; this store cannot fabricate an open fence.
 * No HTTP, byte fetch, R2, BFF, media:complete or baseline side effects.
 *
 * All boundaries reject accessors, descriptors with hidden values, toJSON,
 * nonfinite numbers, cycles, excessive depth/bytes before persistence; accept
 * sanitized plain and null-prototype JSON. Validate actual portable bulk/media
 * schemas plus command-specific result and source/subject/group attachment.
 */
import type { Database } from 'bun:sqlite';
import type { BatchWriteRequest, BatchWriteResult, FieldGroup } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';

export const MISSING_BINDINGS_DRIVER = 'IMPORT_BINDINGS_DRIVER is required: bind real importer RecordBindings';
export const CAPS = {
  source: 32,
  externalId: 255,
  key: 255,
  signature: 128,
  requestBytes: 65536,
  responseBytes: 65536,
  depth: 32,
  page: 100,
  groupCandidates: 100,
  recordCandidates: 300,
} as const;
export interface Owner {
  source: string;
  external_id: string;
}
export interface Journal {
  key: string;
  bytes: string;
  signature: string;
}
export interface Candidate extends Journal {
  candidate: string;
  subject: string;
  field_group: FieldGroup;
}
export type Claim = { state: 'pending' } | { state: 'bound'; subject: string } | { state: 'taken-down' };
export interface PendingMedia extends Journal {
  accepted: MediaImportAccepted | null;
  status: MediaImportStatus | null;
}
export interface RecordBindings {
  /** Serialize once, reserve durably; one command per journal, no statements in create. */
  prepare(owner: Owner, signature: string, request: BatchWriteRequest): Journal;
  journal(owner: Owner, key: string): Journal | null;
  acknowledge(owner: Owner, key: string, result: BatchWriteResult): void;
  claim(owner: Owner): Claim | null;
  /** Actual remote claim 404 observation, terminal even across reopen. */
  takenDown(owner: Owner, response: { status: 404 }): void;
  candidates(owner: Owner, group: FieldGroup, page: { after?: string; limit: number }): Candidate[];
  prepareMedia(owner: Owner, key: string, signature: string, request: MediaImportRequest): PendingMedia;
  acceptMedia(owner: Owner, key: string, response: MediaImportAccepted): void;
  observeMedia(owner: Owner, key: string, response: MediaImportStatus): void;
  mediaPending(owner: Owner, key: string): PendingMedia | null;
  mediaIds(owner: Owner): { cover?: string };
  /** Release prepared statements only; caller owns and closes the handle. */
  close(): void;
}
export type OpenRecordBindings = (database: Database) => RecordBindings;
