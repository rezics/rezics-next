import { queueManagerCommit, runManagerCommit } from '../manager-commit.ts';
import { root, stateDir, withLedger } from '../ledger.ts';

export const usage = 'Usage: goalctl commit -m <message> -- <paths...> | commit --retry <manager-id>';

export default async function commit(args: string[]): Promise<number> {
  if (args[0] === '--retry' && args.length === 2) {
    await runManagerCommit(root, stateDir, args[1]!, true);
    console.log(`${args[1]} landed`);
    return 0;
  }
  if (args[0] !== '-m' || !args[1] || args[2] !== '--' || args.length < 4) throw new Error(usage);
  const id = await withLedger(() => queueManagerCommit(root, stateDir, args.slice(3), args[1]!));
  if (id) {
    console.log(`${id} queued; snapshot retained under ${stateDir}/manager-commits`);
    await runManagerCommit(root, stateDir, id);
    console.log(`${id} landed`);
  } else console.log('Nothing to commit');
  return 0;
}
