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
export interface DatasetImage {
  record: string;
  role: string;
  url: string;
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
