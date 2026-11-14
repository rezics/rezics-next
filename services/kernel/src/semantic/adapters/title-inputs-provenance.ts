import type { Pool } from 'pg';
import type { SemanticTitleProvenance } from '../contract/index.ts';
import { createNativeSemanticTitleProvenance } from '../title-inputs-provenance.ts';

export type {
  SemanticTitleFieldBinding,
  SemanticTitleProvenance,
  SemanticTitleProvenanceEntry,
  SemanticTitleProvenanceObservation,
  SemanticTitleProvenanceOrigin,
  SemanticTitleProvenanceSupport,
} from '../contract/index.ts';

/** Bind exact title-field provenance to Content's native tuple route key. */
export function createSemanticTitleProvenanceAdapter(pool: Pool, routeKey: Uint8Array): SemanticTitleProvenance {
  return createNativeSemanticTitleProvenance(pool, routeKey);
}
