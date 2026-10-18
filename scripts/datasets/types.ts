import type { Capture } from './network.ts';

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
export interface DatasetCoverEvidence {
  /** Normalized source identity. The source may not have a reviewed version yet. */
  provider: string;
  namespace: string;
  externalId: string;
  revision: string | null;
  /** HTTPS URL of the captured source record JSON paired with recordDigest. */
  captureUrl: string;
  recordDigest: string;
  /** RFC 6901 JSON Pointer into the captured record. */
  field: string;
  sourceName: string;
  sourceUrl: string;
  holder: { name: string; field: string } | null;
}
export interface DatasetImage {
  record: string;
  /** Provider supplied role, retained for audit. */
  role: string;
  url: string;
  sourceEvidence?: DatasetCoverEvidence;
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
  captureRole?: 'cover' | 'other';
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
  kind: 'field' | 'edge' | 'image';
  /** RFC 6901 pointer in record, or the snapshot for edge/image occurrences. */
  path: string;
}

export type DatasetMappingDisposition =
  | { status: 'mapped'; reason: string; mapping: DatasetMappingReceipt }
  | { status: 'source-only' | 'unmapped' | 'absent'; reason: string };

/** Small shared adapter over the importer, not a second source or command owner.
 * Mappers consume public source conversion/adoption/support APIs through command.
 * A new revision uses a new label; it never rewrites a previous request or support. */
export interface DatasetMappingContext {
  snapshot: DatasetSnapshot;
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
