import { resolve } from 'node:path';
import { withSlot } from '../qa-slots.ts';
import { inspectAuditRecipe, inspectAuditRecipeAddition } from '../../qa/fixtures/audit-corpus.ts';
import { auditPreparationBudgetMs } from '../../../tests/qa/fixtures/audit-corpus-contract.ts';

export const usage = 'Usage: goalctl prepare-audit <inspect|inspect-addition|prepare> [private .temp recipe.json]';
export default async function prepareAudit(args: string[]): Promise<number> {
  const [mode, path = process.env.REZICS_AUDIT_CORPUS_RECIPE ?? '.temp/audit-corpus/recipe.json'] = args;
  if (args.length < 1 || args.length > 2 || !['inspect', 'inspect-addition', 'prepare'].includes(mode!) || !path) throw new Error(usage);
  if (mode === 'inspect-addition') {
    const result = inspectAuditRecipeAddition(resolve('.'), path);
    console.log(JSON.stringify({ recipe: result.recipePin, sourcePins: result.sourcePins,
      commands: result.recipe.stages.flatMap(stage => stage.commands).length,
      deferred: result.recipe.deferred, ready: result.ready, assertionsReached: result.assertionsReached }, null, 2));
    return 0;
  }
  // Inspection is read-only and never starts an owner or obtains a QA slot.
  if (mode === 'inspect') {
    const result = inspectAuditRecipe(resolve('.'), path);
    console.log(JSON.stringify({ recipe: result.recipePin, originalBindings: result.originals.bindings.length,
      preparationBudgetMs: auditPreparationBudgetMs, blockers: result.blockers, ready: false }, null, 2));
    return result.blockers.length ? 2 : 0;
  }
  // Explicit manager preparation phase only. Ordinary preflight never calls it.
  return withSlot(['bun', 'scripts/qa/fixtures/audit-corpus.ts', 'prepare', path], false);
}
