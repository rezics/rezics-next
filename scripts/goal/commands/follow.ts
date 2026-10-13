import { eventStateDirectory } from '../manager-commands.ts';
import { followWorker } from '../windows.ts';

export const usage = 'Usage: goalctl follow G-NNN';
export default async function follow(args: string[]): Promise<number> {
  if (args.length !== 1 || !/^G-\d+$/i.test(args[0]!)) throw new Error(usage);
  await followWorker(eventStateDirectory(),args[0]!.toUpperCase());
  return 0;
}
