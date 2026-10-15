import { withSlot } from '../qa-slots.ts';
import { resolve } from 'node:path';

export const usage = 'Usage: goalctl prepare-source owner | owner-later | independent-recipe | independent-authority | fixture-small';
export default async function prepareSource(args: string[]): Promise<number> {
  const kind = args[0];
  if (args.length !== 1 || !['owner', 'owner-later', 'independent-recipe', 'independent-authority', 'fixture-small'].includes(kind!))
    throw new Error(usage);
  // Publication remains an explicit admitted action, never a preflight fallback.
  const env = { ...process.env, REZICS_FIXTURE_ROOT: process.env.REZICS_FIXTURE_ROOT ?? resolve('.temp/fixture') };
  return withSlot(kind === 'fixture-small'
    ? ['bun', 'scripts/fixture/cli.ts', 'build', '--profile', 'small']
    : ['bun', 'scripts/qa/test.ts', 'tests/qa/fault-recovery/retained-source-preparation.test.ts',
      '--test-name-pattern', `^prepare retained ${kind}$`], false, undefined, { env });
}
