import { withSlot } from '../qa-slots.ts';

export const usage = 'Usage: goalctl prepare-source owner | owner-later | independent-recipe | independent-authority';
export default async function prepareSource(args: string[]): Promise<number> {
  const kind = args[0];
  if (args.length !== 1 || !['owner', 'owner-later', 'independent-recipe', 'independent-authority'].includes(kind!))
    throw new Error(usage);
  // Publication remains an explicit admitted action, never a preflight fallback.
  return withSlot(['bun', 'scripts/qa/test.ts', 'tests/qa/fault-recovery/retained-source-preparation.test.ts',
    '--test-name-pattern', `^prepare retained ${kind}$`]);
}
