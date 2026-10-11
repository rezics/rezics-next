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
