import { t } from 'elysia';
import { readId } from '../work/read-contract.ts';

/** Public references only. Binding, conversion and settlement certificates stay private.
 * A missing provider revision or URL is not inferred from a snapshot or another edition. */
export interface ReleaseSourceEvidence {
  provider: string;
  namespace: string;
  externalId: string;
  sourceRevision: string | null;
  datasetSnapshotDigest: string;
  recordDigest: string;
  fieldLocator: string;
  record: string;
  observation: string;
  href: string | null;
}

export const RELEASE_EVIDENCE_COST = { supports: 32 } as const;
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
export const releaseSourceEvidenceSchema = t.Array(t.Object({
  provider: t.String(), namespace: t.String(), externalId: t.String(),
  sourceRevision: t.Nullable(t.String()), datasetSnapshotDigest: digest, recordDigest: digest,
  fieldLocator: t.String(), record: readId, observation: readId, href: t.Nullable(t.String()),
}, { additionalProperties: false }), { maxItems: RELEASE_EVIDENCE_COST.supports });
