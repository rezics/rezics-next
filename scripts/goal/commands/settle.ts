import { settlePass } from '../settle.ts';

export const usage = 'Usage: goalctl settle';

export default async function settle(args: string[]): Promise<number> {
  if (args.length) throw new Error(usage);
  await settlePass();
  return 0;
}
