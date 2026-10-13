import { workerCheck, parseCheckArgs } from '../check.ts';

export const usage = 'Usage: goalctl check [--only types,lint,tests,guards]';

export default async function check(args: string[]): Promise<number> {
  return (await workerCheck({ only: parseCheckArgs(args) })).code;
}
