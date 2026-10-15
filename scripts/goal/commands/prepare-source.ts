import { withSlot } from '../qa-slots.ts';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export const usage = 'Usage: goalctl prepare-source owner | owner-later | independent-recipe | independent-authority | fixture-small';
export default async function prepareSource(args: string[]): Promise<number> {
  const kind = args[0];
  if (args.length !== 1 || !['owner', 'owner-later', 'independent-recipe', 'independent-authority', 'fixture-small'].includes(kind!))
    throw new Error(usage);
  // Publication remains an explicit admitted action, never a preflight fallback.
  const env = { ...process.env, REZICS_FIXTURE_ROOT: process.env.REZICS_FIXTURE_ROOT ?? resolve('.temp/fixture') };
  mkdirSync('.temp', { recursive: true });
  return withSlot(kind === 'fixture-small'
    ? ['bun', 'scripts/fixture/cli.ts', 'build', '--profile', 'small']
    : ['bun', kind!.startsWith('owner')
      ? 'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts'
      : 'tests/qa/fault-recovery/independent-restore-support.ts',
    '--prepare-retained-source', '--evidence', `.temp/retained-source-${kind}.json`,
    ...(kind === 'owner-later' ? ['--later-api-admission'] : []),
    ...(kind === 'independent-recipe' ? ['--recipe'] : [])], false, undefined, { env });
}
