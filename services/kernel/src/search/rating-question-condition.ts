import { FilterError, parseDiscoveryFilter, walkDiscoveryFilter, type DiscoveryFilterDocument } from '@rezics/filter';
import {
  assertCurrentRatingQuestionSelection,
  qualifyReviewContextWitnesses,
  resolveRatingQuestionSelection,
  type RatingQuestionSelection,
  type ReviewContextCandidate,
  type ReviewContextDependencies,
} from '../content/review-context-eligibility.ts';
import type { ReadContext } from '../content/model.ts';
import { publicFilterReviewQuestionKey } from '../semantic/public-filter-review-question.ts';
import type { PublicFilterReviewQuestionKey } from '../semantic/public-filter-source-contract.ts';

declare const bound: unique symbol;
export type RatingQuestionConditions = Readonly<{
  /** A private copy of the complete admitted request tree, including polarity. */
  filter: DiscoveryFilterDocument;
  /** Native definition revisions, suitable for the signed selection binding. */
  keys: readonly PublicFilterReviewQuestionKey[];
  [bound]: true;
}>;
const bindings = new WeakMap<RatingQuestionConditions, Readonly<{
  deps: ReviewContextDependencies;
  context: ReadContext;
  selections: ReadonlyMap<string, RatingQuestionSelection>;
}>>();

function freezeTree(value: object): void {
  for (const child of Object.values(value))
    if (child !== null && typeof child === 'object') freezeTree(child);
  Object.freeze(value);
}

/** Resolve original definitions authority for every question before enumeration.
 * This does not evaluate Boolean truth, acquire coverage or authorize a primary.
 * The caller supplies the expanded admitted tree; saved definitions never carry
 * request-only operands. Parse again to own and bound the tree before any I/O.
 */
export async function resolveRatingQuestionConditions(
  deps: ReviewContextDependencies,
  filter: DiscoveryFilterDocument,
  context: ReadContext,
): Promise<RatingQuestionConditions> {
  const owned = parseDiscoveryFilter(filter);
  const ids = new Set<string>();
  for (const node of walkDiscoveryFilter(owned)) {
    if ('saved' in node) throw new FilterError('unsupported_query', '/saved', 'unsupported');
    if ('ratingQuestion' in node) ids.add(node.ratingQuestion.id);
  }
  freezeTree(owned);
  const selections = new Map<string, RatingQuestionSelection>();
  const keys: PublicFilterReviewQuestionKey[] = [];
  // Do not short-circuit under NOT or a true OR. Deduplication happens only
  // after the parser charged all leaves, depth and Boolean fanout.
  for (const id of ids) {
    const selection = await resolveRatingQuestionSelection(deps, id, context);
    selections.set(id, selection);
    keys.push(publicFilterReviewQuestionKey(selection.question.id, selection.question.revision));
  }
  const result = Object.freeze({ filter: owned, keys: Object.freeze(keys) }) as RatingQuestionConditions;
  bindings.set(result, { deps, context, selections });
  return result;
}

function bindingFor(
  deps: ReviewContextDependencies,
  conditions: RatingQuestionConditions,
  context: ReadContext,
) {
  const binding = bindings.get(conditions);
  if (!binding || binding.deps !== deps || binding.context !== context)
    throw new TypeError('Question conditions belong to another request');
  return binding;
}

/** Final native metadata/authority check; a revision change refuses the old selection. */
export async function assertCurrentRatingQuestionConditions(
  deps: ReviewContextDependencies,
  conditions: RatingQuestionConditions,
  context: ReadContext,
): Promise<void> {
  for (const selection of bindingFor(deps, conditions, context).selections.values())
    await assertCurrentRatingQuestionSelection(deps, selection, context);
}

/** Qualify the actual native witness batch for one selected leaf. The result is
 * positional witness eligibility, never an existential negative, retained Source
 * observation, coverage receipt or a Boolean complement of an incomplete page.
 */
export async function qualifyRatingQuestionConditionWitnesses(
  deps: ReviewContextDependencies,
  conditions: RatingQuestionConditions,
  questionId: string,
  candidates: readonly ReviewContextCandidate[],
  context: ReadContext,
): Promise<readonly ('current' | 'refused')[]> {
  const selection = bindingFor(deps, conditions, context).selections.get(questionId);
  if (!selection) throw new TypeError('Question is absent from the admitted request');
  return qualifyReviewContextWitnesses(deps, selection, candidates, context);
}
