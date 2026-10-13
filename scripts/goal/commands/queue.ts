import { dropQueue, listQueue, queueBrief } from '../queue.ts';

export const usage = 'Usage: goalctl queue [<brief.md> | --drop <id>]';

export default async function queue(args: string[]): Promise<number> {
  if (!args.length) await listQueue();
  else if (args.length === 2 && args[0] === '--drop' && /^G-\d{3,}$/.test(args[1]!)) await dropQueue(args[1]!);
  else if (args.length === 1 && !args[0]!.startsWith('--')) await queueBrief(args[0]!);
  else throw new Error(usage);
  return 0;
}
