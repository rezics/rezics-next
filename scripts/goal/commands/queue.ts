import { dropQueue, listQueue, queueBrief } from '../queue.ts';

export const usage = 'Usage: goalctl queue [<brief.md> [--allow-area] | --drop <id>]';

export default async function queue(args: string[]): Promise<number> {
  if (!args.length) await listQueue();
  else if (args.length === 2 && args[0] === '--drop' && /^G-\d{3,}$/.test(args[1]!)) await dropQueue(args[1]!);
  else {
    const paths = args.filter(arg => arg !== '--allow-area');
    if (paths.length !== 1 || paths[0]!.startsWith('--') || args.length > 2) throw new Error(usage);
    await queueBrief(paths[0]!, new Set(args.filter(arg => arg === '--allow-area')));
  }
  return 0;
}
