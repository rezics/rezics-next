import { eventStateDirectory, eventLedger } from '../manager-commands.ts';
import { reconcileWindows } from '../windows.ts';

export const usage = 'Usage: goalctl windows [--remove]';
export default function windows(args: string[]): number {
  if (args.length && (args.length !== 1 || args[0] !== '--remove')) throw new Error(usage);
  const directory = eventStateDirectory();
  const report = reconcileWindows(directory,eventLedger(directory),args[0] === '--remove');
  for (const name of report.made) console.log(`made ${name}`);
  for (const name of report.removed) console.log(`removed ${name}`);
  if (report.error) { console.log(report.error); return 1; }
  return 0;
}
