import { stateDir } from '../ledger.ts';
import { trainMetrics } from '../merge-train.ts';

export const usage = 'Usage: goalctl train';
export default function train(args: string[]): number {
  if (args.length) throw new Error(usage);
  console.log(JSON.stringify(trainMetrics(stateDir), null, 2));
  return 0;
}
