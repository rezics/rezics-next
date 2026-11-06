import {
  currentCreditSearchMatch,
  projectCreditSearch,
  type CreditSearchSource,
  type CreditSearchWitness,
} from './credit-search.ts';
import { parseCreditedNameEvidence, selectCreditEvidence } from './credit-search-query.ts';
import type { CreditMatchView } from './discovery-api.ts';

export type CreditedHitCheck =
  | Readonly<{ state: 'current'; witness: CreditSearchWitness }>
  | Readonly<{ state: 'absent' | 'changed' | 'unavailable' }>;

/** Extract only bounded native nested inner-hit witnesses from one engine hit. */
export function creditEvidenceFromEngineHit(hit: unknown): CreditSearchWitness[] | undefined {
  if (hit === null || typeof hit !== 'object' || Array.isArray(hit)) return undefined;
  const inner = (hit as Record<string, unknown>).inner_hits;
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
  const credited = (inner as Record<string, unknown>).credited_names;
  if (credited === null || typeof credited !== 'object' || Array.isArray(credited)) return undefined;
  const hits = (credited as Record<string, unknown>).hits;
  if (hits === null || typeof hits !== 'object' || Array.isArray(hits)) return undefined;
  const entries = (hits as Record<string, unknown>).hits;
  if (!Array.isArray(entries) || entries.length > 3) return undefined;
  const evidence: CreditSearchWitness[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const witness = parseCreditedNameEvidence((entry as Record<string, unknown>)._source);
    if (!witness) return undefined;
    evidence.push(witness);
  }
  return evidence.length ? evidence : undefined;
}

/**
 * Current proof for one credited candidate (a work). The index's inner hits only nominate evidence: a witness
 * proves the match when it is an exact member of the complete projection and the producer still confirms it.
 * Absent evidence, a changed cut and unavailable proof are distinct and never become a positive match.
 */
export async function verifyCreditedHit(
  source: CreditSearchSource | undefined,
  workId: string,
  evidence: readonly CreditSearchWitness[],
): Promise<CreditedHitCheck> {
  if (evidence.length === 0) return { state: 'absent' };
  const projection = await projectCreditSearch(source, workId);
  if (projection.state === 'restart') return { state: 'changed' };
  if (projection.state !== 'complete') return { state: 'unavailable' };
  let outcome: 'absent' | 'changed' | 'unavailable' = 'absent';
  for (const witness of selectCreditEvidence(evidence, projection)) {
    const current = await currentCreditSearchMatch(source, projection, witness);
    if (current === 'current') return { state: 'current', witness };
    if (current === 'restart') outcome = 'changed';
    else if (outcome === 'absent') outcome = 'unavailable';
  }
  return { state: outcome };
}

/** The served shape of a verified match. Only the matched statement's own facts are exposed. */
export function creditMatchView(witness: CreditSearchWitness): CreditMatchView {
  return {
    statementId: witness.statementId,
    property: witness.property,
    targetId: witness.targetId,
    name: { language: witness.name.language, value: witness.name.value },
    qualifiers: witness.qualifiers.map(({ property, value }) => ({ property, value })),
  };
}
