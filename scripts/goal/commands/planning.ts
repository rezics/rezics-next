import { eventLedger, eventStateDirectory } from '../manager-commands.ts';
import { planningLines } from '../planning.ts';

export const usage = 'Usage: goalctl planning [goal]';

export default function planning(args: string[]): number {
  if (args.length > 1 || args.some(arg => arg.startsWith('--'))) throw new Error(usage);
  const directory = eventStateDirectory();
  for (const line of planningLines(directory, eventLedger(directory), args[0])) console.log(line);
  return 0;
}
