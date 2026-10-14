import { workerCheck, parseCheckArgs } from '../check.ts';

export const usage = 'Usage: goalctl check [--only types,lint,tests,guards | --branch <ref>]';

export default async function check(args: string[]): Promise<number> {
  if (args[0] === '--branch') {
    if (args.length !== 2 || !args[1]) throw new Error(usage);
    const { branchCheck } = await import('../branch-check.ts');
    return (await branchCheck(args[1])).code;
  }
  return (await workerCheck({ only: parseCheckArgs(args) })).code;
}
