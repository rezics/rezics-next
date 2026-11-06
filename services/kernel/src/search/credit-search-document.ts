import type { CreditSearchProjection, CreditSearchWitness } from './credit-search.ts';

/** One nested document per (statement, creator name). Shape matches `credit-search-mapping.ts`. */
export type CreditedNameDocument = {
  workId: string;
  statementId: string;
  revision: number;
  release: string;
  property: string;
  targetId: string;
  direction: 'outgoing';
  nameRevision: string;
  qualifiers: { property: string; value: string }[];
  name: { language: string; value: string };
};

/** Fields written beside a Subject's ordinary document when the generation carries the credit mapping. */
export type CreditSearchFields = {
  credit_search_complete: boolean;
  credited_names: CreditedNameDocument[];
};

function creditedNameDocument(witness: CreditSearchWitness): CreditedNameDocument {
  return {
    workId: witness.workId,
    statementId: witness.statementId,
    revision: witness.revision,
    release: witness.release,
    property: witness.property,
    targetId: witness.targetId,
    direction: witness.direction,
    nameRevision: witness.nameRevision,
    qualifiers: witness.qualifiers.map(({ property, value }) => ({ property, value })),
    name: { language: witness.name.language, value: witness.name.value },
  };
}

/**
 * All-or-readiness per work: only a complete projection publishes names. Any other state replaces
 * the previous names with an explicit incomplete cut, so a stale creator name cannot survive.
 * The projection is already validated by `projectCreditSearch`; its witnesses are published unchanged.
 */
export function creditSearchFields(projection: CreditSearchProjection | undefined): CreditSearchFields {
  if (projection === undefined || projection.state !== 'complete')
    return { credit_search_complete: false, credited_names: [] };
  return {
    credit_search_complete: true,
    credited_names: projection.names.map(creditedNameDocument),
  };
}
