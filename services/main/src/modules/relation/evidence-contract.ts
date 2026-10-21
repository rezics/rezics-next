import { t } from 'elysia';
import type { Static } from 'typebox';
import { problemResult, sourcePosition } from '../../api-contract.ts';
import { readId } from '../work/read-contract.ts';
import { associationEvidenceCitation } from './evidence-citation-contract.ts';
export { associationEvidenceCitation, manualAssociationCitation, retainedSourceFieldCitation } from './evidence-citation-contract.ts';

export const ASSOCIATION_EVIDENCE_PROFILE = 'association-evidence-v1';
export const ASSOCIATION_EVIDENCE_COST = { citations: 16, frames: 8, cursor: 2048, bytes: 512 * 1024 } as const;
const closed = { additionalProperties: false } as const;
export const associationEvidenceQuery = t.Object({ profile: t.Literal(ASSOCIATION_EVIDENCE_PROFILE),
  context: t.Union([t.Literal('global'), readId]), position: t.Union([t.Literal('start'), t.Literal('all'), readId]),
  claim: readId, claimRevision: readId,
  frame: t.Optional(t.Array(readId, { maxItems: ASSOCIATION_EVIDENCE_COST.frames, uniqueItems: true })),
  actingSubject: t.Optional(readId),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: ASSOCIATION_EVIDENCE_COST.citations, multipleOf: 1 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: ASSOCIATION_EVIDENCE_COST.cursor })),
}, closed);
export const associationEvidenceResult = t.Object({ profile: t.Literal(ASSOCIATION_EVIDENCE_PROFILE),
  occurrence: readId, revision: readId, claim: readId, claimRevision: readId,
  sourcePosition, modelGeneration: t.String({ minLength: 1 }),
  items: t.Array(associationEvidenceCitation, { maxItems: ASSOCIATION_EVIDENCE_COST.citations }),
  nextCursor: t.Nullable(t.String({ minLength: 1, maxLength: ASSOCIATION_EVIDENCE_COST.cursor })), complete: t.Boolean(),
  count: t.Object({ value: t.Integer({ minimum: 0, maximum: ASSOCIATION_EVIDENCE_COST.citations }),
    kind: t.Literal('exact-page'), total: t.Null() }, closed),
}, closed);
export const associationEvidenceStale = t.Object({ ...problemResult(409).properties,
  code: t.Literal('stale_query_result'), restart: t.Object({ method: t.Literal('GET'), path: t.String() }, closed),
}, closed);
export type AssociationEvidenceQuery = Static<typeof associationEvidenceQuery>;
export type AssociationCitation = Static<typeof associationEvidenceCitation>;
export type AssociationEvidenceSelection = Omit<AssociationEvidenceQuery, 'cursor' | 'limit' | 'frame'> & {
  occurrence: string; revision: string; limit: number; frame: string[];
};
