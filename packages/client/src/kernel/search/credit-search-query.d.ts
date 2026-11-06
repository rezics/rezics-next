import { type CreditSearchProjection, type CreditSearchWitness } from './credit-search.ts';
import { type TextLeaf, type TextNode } from './text.ts';
/** Engine field of a credited creator name. The mapping's names analyzer owns its matching. */
export declare const CREDIT_NAME_FIELD = "credited_names.name.value";
/** Displayed contexts per hit; the owner page shows at most three current credits. */
export declare const CREDIT_CONTEXT_LIMIT = 3;
export type CreditQualifierOperand = Readonly<{
    property: string;
    value: string;
}>;
/**
 * Compiles creator-name text against complete credited names. Every text leaf and every qualifier
 * is evaluated inside ONE nested credit document, so a qualifier can only confirm the same statement
 * that matched the name. Work-level completeness is a root filter, never inferred from hits.
 */
export declare function compileCreditedText(text: TextNode, qualifiers?: readonly CreditQualifierOperand[]): {
    query: Record<string, unknown>;
    leaves: TextLeaf[];
};
/** Engine `_source` of one credited-name document. Anything malformed is not evidence. */
export declare function parseCreditedNameEvidence(value: unknown): CreditSearchWitness | undefined;
/**
 * Engine inner hits become evidence only when they are exact members of the complete projection.
 * The result is still unverified: `currentCreditSearchMatch` revalidates each one against the source.
 */
export declare function selectCreditEvidence(innerHitSources: readonly unknown[], projection: CreditSearchProjection): CreditSearchWitness[];
