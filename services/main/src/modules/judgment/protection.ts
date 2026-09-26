import type { AccessJudgments } from './access.ts';
import type { JudgmentContext } from './schema.ts';

/** Search integration point for one exact supporting Statement and population.
 * This checks the current aggregate and consumes its latest invalidation through
 * the badge projection; the result carries both policy and source generations. */
export function checkJudgmentProtection(
  owner: Pick<AccessJudgments, 'protectionCheck'>, statement: string,
  context: JudgmentContext, concept: string | null,
) {
  return owner.protectionCheck(statement, context, concept);
}
