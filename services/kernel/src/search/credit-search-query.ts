import { isDeepStrictEqual } from 'node:util';
import { CREDIT_SEARCH_LIMITS, type CreditSearchProjection, type CreditSearchWitness } from './credit-search.ts';
import { compileText, type TextLeaf, type TextNode } from './text.ts';

/** Engine field of a credited creator name. The mapping's names analyzer owns its matching. */
export const CREDIT_NAME_FIELD = 'credited_names.name.value';
/** Displayed contexts per hit; the owner page shows at most three current credits. */
export const CREDIT_CONTEXT_LIMIT = 3;

export type CreditQualifierOperand = Readonly<{ property: string; value: string }>;

/**
 * Compiles creator-name text against complete credited names. Every text leaf and every qualifier
 * is evaluated inside ONE nested credit document, so a qualifier can only confirm the same statement
 * that matched the name. Work-level completeness is a root filter, never inferred from hits.
 */
export function compileCreditedText(
  text: TextNode,
  qualifiers: readonly CreditQualifierOperand[] = [],
): { query: Record<string, unknown>; leaves: TextLeaf[] } {
  if (qualifiers.length > CREDIT_SEARCH_LIMITS.qualifiersPerCredit)
    throw new RangeError('Credited-name qualifiers exceed the admitted bound');
  const names = compileText(text, { field: CREDIT_NAME_FIELD, prefix: 'c' });
  const sameCredit: Record<string, unknown>[] = [names.query, ...qualifiers.map(qualifierClause)];
  return {
    query: {
      bool: {
        filter: [{ term: { credit_search_complete: true } }],
        must: [
          {
            nested: {
              path: 'credited_names',
              score_mode: 'max',
              query: {
                bool: { filter: [{ term: { 'credited_names.direction': 'outgoing' } }], must: sameCredit },
              },
              inner_hits: { name: 'credited_names', size: CREDIT_CONTEXT_LIMIT, _source: true },
            },
          },
        ],
      },
    },
    leaves: names.leaves,
  };
}

function qualifierClause(qualifier: CreditQualifierOperand): Record<string, unknown> {
  return {
    nested: {
      path: 'credited_names.qualifiers',
      score_mode: 'none',
      query: {
        bool: {
          filter: [
            { term: { 'credited_names.qualifiers.property': qualifier.property } },
            { term: { 'credited_names.qualifiers.value': qualifier.value } },
          ],
        },
      },
    },
  };
}

const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed();

/** Engine `_source` of one credited-name document. Anything malformed is not evidence. */
export function parseCreditedNameEvidence(value: unknown): CreditSearchWitness | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  const name = doc.name as Record<string, unknown> | undefined;
  const qualifiers = doc.qualifiers;
  if (
    !bounded(doc.workId, 256) ||
    !bounded(doc.statementId, 256) ||
    !Number.isSafeInteger(doc.revision) ||
    (doc.revision as number) < 1 ||
    !bounded(doc.release, 256) ||
    !bounded(doc.property, 256) ||
    !bounded(doc.targetId, 256) ||
    doc.direction !== 'outgoing' ||
    !bounded(doc.nameRevision, 256) ||
    !Array.isArray(qualifiers) ||
    qualifiers.length > CREDIT_SEARCH_LIMITS.qualifiersPerCredit ||
    !name ||
    !bounded(name.language, 35) ||
    !bounded(name.value, CREDIT_SEARCH_LIMITS.nameBytes)
  )
    return undefined;
  const parsed = qualifiers.map((item: unknown) => {
    const qualifier = item as Record<string, unknown> | null;
    return qualifier && bounded(qualifier.property, 256) && bounded(qualifier.value, 256)
      ? { property: qualifier.property as string, value: qualifier.value as string }
      : undefined;
  });
  if (parsed.some((item) => item === undefined)) return undefined;
  return {
    workId: doc.workId as string,
    statementId: doc.statementId as string,
    revision: doc.revision as number,
    release: doc.release as string,
    property: doc.property as string,
    targetId: doc.targetId as string,
    direction: 'outgoing',
    qualifiers: parsed as { property: string; value: string }[],
    nameRevision: doc.nameRevision as string,
    name: { language: name.language as string, value: name.value as string },
  };
}

/**
 * Engine inner hits become evidence only when they are exact members of the complete projection.
 * The result is still unverified: `currentCreditSearchMatch` revalidates each one against the source.
 */
export function selectCreditEvidence(
  innerHitSources: readonly unknown[],
  projection: CreditSearchProjection,
): CreditSearchWitness[] {
  if (projection.state !== 'complete') return [];
  const evidence: CreditSearchWitness[] = [];
  for (const source of innerHitSources) {
    const witness = parseCreditedNameEvidence(source);
    if (witness && projection.names.some((name) => isDeepStrictEqual(name, witness))) evidence.push(witness);
  }
  return evidence;
}
