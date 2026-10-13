import { loadOutcomes, rowId } from '../../qa/cases/outcomes.ts';
import { launchCoverage } from '../../qa/cases/launch-coverage.ts';
import { confirmedScopeReport, latestConfirmation } from '../confirmed.ts';
import { stateDir } from '../ledger.ts';
import { resolve } from 'node:path';

export const usage = 'Usage: goalctl scope [task-id]';

export default async function scope(args: string[]): Promise<number> {
  if (args.length) throw new Error(usage);
  const directory = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
  console.log(confirmedScopeReport([...(await loadOutcomes({ root: process.cwd() })).values()],
    launchCoverage.map(rowId), latestConfirmation(directory)));
  return 0;
}
