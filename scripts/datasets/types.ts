import type { DatasetSelectionManifest } from './selection.ts';
import type { ManualSourceIntake } from '../../services/main/src/modules/source/intake.ts';
import type { RetainedConversionRequest } from '../../services/main/src/modules/source/field-support-contract.ts';
import type { RetainedConversion } from '../../services/main/src/modules/source/retained-record.ts';
import type { Capture } from './network.ts';
import type { DatasetSelectionManifest } from './selection.ts';
import type { ManualSourceIntake } from '../../services/main/src/modules/source/intake.ts';
import type { RetainedConversionRequest, RetainedSupportRequest } from '../../services/main/src/modules/source/field-support-contract.ts';
import type { RetainedConversion } from '../../services/main/src/modules/source/retained-record.ts';

export type Provider = 'vndb' | 'bangumi' | 'musicbrainz';
export interface DatasetRecord {
  /** Source identity, not a predetermined REZICS ID. */
  key: string;
  provider: Provider;
  kind: string;
  externalId: string;
  title: string;
  language: string;
  sourceUrl: string;
  data: Record<string, unknown>;
  /** Native mapping; the complete source record is always retained separately. */
  native:
    | 'work'
    | 'person'
    | 'organization'
    | 'concept'
    | 'character'
    | 'episode'
    | 'release'
    | 'source-only';
  semanticTypes?: string[];
}
export interface DatasetEdge {
  from: string;
  to: string;
  kind: string;
  data: Record<string, unknown>;
}
export type DatasetCaptureRole = 'cover' | 'portrait' | 'screenshot' | 'other';

export interface DatasetMediaEvidence {
  /** Normalized source identity. The source may not have a reviewed version yet. */
  provider: string;
  namespace: string;
  externalId: string;
  revision: string | null;
  /** HTTPS URL of the captured source. JSON uses recordDigest directly. */
  captureUrl: string;
  /** SHA-256 of source JSON bytes, or of the canonical decoded COPY row. */
  recordDigest: string;
  /** RFC 6901 JSON Pointer into source JSON or the decoded COPY row. */
  field: string;
  sourceName: string;
  sourceUrl: string;
  holder: { name: string; field: string } | null;
  /** Explicit derivation from retained archive bytes; never a fabricated JSON capture. */
  derivation?: {
    format: 'vndb-copy-image-v1';
    archiveDigest: string;
    table: 'vn' | 'chars' | 'vn_screenshots' | 'releases_images' | 'vn_image_votes';
    imageId: string;
  };
}
/** Compatibility name for the original cover-only producer. */
export type DatasetCoverEvidence = DatasetMediaEvidence;
export interface DatasetImage {
  record: string;
  /** Provider supplied role, retained for audit. */
  role: string;
  url: string;
  sourceEvidence?: DatasetMediaEvidence;
}
export interface DatasetSource {
  provider: Provider;
  roots: string[];
  records: DatasetRecord[];
  edges: DatasetEdge[];
  images: DatasetImage[];
  /** Exact elected surfaces and acquisition consistency; bounded != globally complete. */
  scope: Record<string, unknown>;
}
export interface StoredImage extends DatasetImage {
  /** Normalized role for capture admission; `all` never promotes an image. */
  captureRole?: DatasetCaptureRole;
  /** Frozen provider image response; its URL is the image URL, not evidence.captureUrl. */
  capture: Capture | null;
  missing: boolean;
  unavailable?: { status: number };
}
export interface DatasetSnapshot {
  format: 'rezics-local-dataset-v1';
  id: string;
  digest: string;
  sources: DatasetSource[];
  captures: Capture[];
  images: StoredImage[];
  createdAt: string;
}

/** API receipts remain authoritative; this is a view of the existing import journal. */
export interface DatasetNativeRecord {
  id: string;
  kind: string;
  receipt: Record<string, unknown>;
  urls: string[];
  sourceIdentity?: string;
  /** Exact values written by this producer, never inferred from a reused identity. */
  projection?: { recordDigest: string; fields: Record<string, unknown> };
}

export type DatasetMapperId = 'fields' | 'relations' | 'credits' | 'releases' | 'media';

export interface DatasetIntakeReference {
  record: string;
  observation: string;
  byteDigest: string;
}

export interface DatasetFrozenIdentity {
  key: string;
  provider: Provider;
  namespace: string;
  externalId: string;
}

export interface DatasetSnapshotReference {
  id: string;
  digest: string;
  /** Only a digest of the actual retained file, never of a reserialization. */
  fileSha256?: string;
}

export type DatasetIntakeRequest = ManualSourceIntake & {
  profile: 'source-manual-intake-v1';
  retention: 'retained';
  rawBytesBase64: string;
};

export interface DatasetIntakePayload {
  format: 'json' | 'rezics-dataset-chunk-v1';
  /** Digest/length of assembled bytes, distinct from record and part digests. */
  byteDigest: string;
  byteLength: number;
}

export interface DatasetRecordEnvelope {
  format: 'rezics-dataset-record-v1';
  snapshot: string;
  digest: string;
  record: DatasetRecord;
  edges: DatasetEdge[];
  images: StoredImage[];
}

export interface DatasetRecordOccurrences {
  /** Parallel to envelope.edges/images, in their actual submitted order. */
  edges: string[];
  images: string[];
  /** Original /images indices; an election is not Media admission or adoption. */
  electedImages: string[];
}

export interface DatasetIntakeCoordinate {
  snapshot: DatasetSnapshotReference;
  /** Original frozen record, separate from a scope or multipart Source record. */
  identity: DatasetFrozenIdentity;
  recordDigest: string;
  purpose: 'record' | 'scope' | 'image-candidates' | 'cover-evidence';
  index: number;
  count: number;
  payload: DatasetIntakePayload;
  occurrences?: DatasetRecordOccurrences;
}

export interface DatasetCommandResponse {
  /** Old journals did not retain HTTP status. Absence must stay unknown. */
  status?: number;
  body: Record<string, unknown>;
}

export interface DatasetRecordedCommand {
  label: string;
  key: string;
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  responses: DatasetCommandResponse[];
  result?: Record<string, unknown>;
}

export interface DatasetRetainedConversionReceipt {
  request: RetainedConversionRequest;
  conversion: RetainedConversion;
  command: DatasetRecordedCommand;
}

export interface DatasetFieldAdoption {
  record: string;
  field: RetainedSupportRequest['evidence']['field'];
  status: 'pending' | 'mapped';
  reason: string;
  conversion?: DatasetRecordedCommand;
  native?: DatasetRecordedCommand;
  nativeRead?: { path: string; body: Record<string, unknown> };
  nativeReads?: { path: string; body: Record<string, unknown> }[];
  support?: DatasetRecordedCommand;
  supportRead?: { path: string; body: Record<string, unknown> };
}

export interface DatasetFieldAdoptionJournal {
  profile: 'rezics-dataset-field-adoptions-v1';
  snapshot: DatasetSnapshotReference;
  conversions: Record<string, DatasetRetainedConversionReceipt>;
  fields: DatasetFieldAdoption[];
}

/** Actual command custody, including intents whose reply has not been observed. */
export interface DatasetIntakeCommand {
  label: string;
  key: string;
  method: 'POST';
  path: '/v1/sources/intakes';
  request: DatasetIntakeRequest;
  coordinate: DatasetIntakeCoordinate;
  responses: DatasetCommandResponse[];
  result?: Record<string, unknown>;
}

export interface DatasetIntakeReceipt extends DatasetIntakeReference {
  index: number;
  byteLength: number;
  /** Exact request and acknowledged reply; IDs alone are not intake custody. */
  command: DatasetIntakeCommand & { result: Record<string, unknown> };
}

export interface DatasetRetainedRecord {
  identity: DatasetFrozenIdentity;
  snapshot: DatasetSnapshotReference;
  record: DatasetRecord;
  recordDigest: string;
  envelope: DatasetRecordEnvelope;
  occurrences: DatasetRecordOccurrences;
  payload: DatasetIntakePayload;
  intakes: DatasetIntakeReceipt[];
}

export interface DatasetIntakeJournal {
  format: 'rezics-dataset-intake-receipts-v1';
  snapshot: DatasetSnapshotReference;
  /** Failed/interrupted intents remain here without an invented result. */
  commands: DatasetIntakeCommand[];
  /** Preserve older exact commands even when their frozen coordinate is unverified. */
  unboundCommands: (Omit<DatasetIntakeCommand, 'coordinate' | 'request'> & { request: unknown })[];
  /** Only complete, checked, acknowledged record intakes enter this view. */
  records: Record<string, DatasetRetainedRecord>;
}

export interface DatasetSourceReference {
  key: string;
  provider: Provider;
  namespace: string;
  externalId: string;
  snapshot: string;
  snapshotDigest: string;
  recordDigest: string;
  /** Ordered retained intake parts. Multiple parts are not one convertible observation. */
  observations: readonly string[];
  intakes: readonly DatasetIntakeReference[];
  /** Complete actual envelope and ordered custody, not a conversion/adoption. */
  retained?: DatasetRetainedRecord;
  /** Only an acknowledged retained conversion supplies the canonical Source record. */
  conversion?: DatasetRetainedConversionReceipt;
}

export interface DatasetMappingReceipt {
  /** API-returned target at its exact grain. */
  target: string;
  /** Public consuming read, not a retained source JSON URL. */
  readPath: string;
  /** Exact acknowledged command result; an attempted write is not a mapping. */
  receipt: Record<string, unknown>;
}

export interface DatasetCoverageKey {
  record: string;
  /** source-image is a provider candidate, not an acquired /images occurrence. */
  kind: 'field' | 'edge' | 'image' | 'source-image';
  /** RFC 6901 pointer in record, or the immutable parent snapshot for occurrences. */
  path: string;
}

export type DatasetMappingDisposition =
  | { status: 'mapped'; reason: string; mapping: DatasetMappingReceipt }
  | { status: 'source-only' | 'unmapped' | 'absent'; reason: string };

/** Small shared adapter over the importer, not a second source or command owner.
 * Mappers consume public source conversion/adoption/support APIs through command.
 * A new revision uses a new label; it never rewrites a previous request or support. */
export interface DatasetMappingContext {
  /** Always the immutable parent, including when an offline selection is active. */
  snapshot: DatasetSnapshot;
  /** Original parent indices; excluded occurrences cannot acquire dispositions. */
  selection?: DatasetSelectionManifest;
  actingSubject: string;
  selected: ReadonlySet<string>;
  records: ReadonlyMap<string, DatasetRecord>;
  native: ReadonlyMap<string, DatasetNativeRecord>;
  source(key: string): DatasetSourceReference;
  command(label: string, method: 'POST' | 'PUT', path: string,
    body: unknown): Promise<Record<string, unknown>>;
  /** Fresh owner reads supply CAS heads; do not journal a changing read. */
  read(path: string): Promise<Record<string, unknown>>;
  disposition(key: DatasetCoverageKey, disposition: DatasetMappingDisposition): void;
}

export interface DatasetNativeMapper {
  id: DatasetMapperId;
  revision: string;
  map(context: DatasetMappingContext): Promise<void>;
}
