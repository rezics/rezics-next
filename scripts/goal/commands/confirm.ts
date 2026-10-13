import { resolve } from 'node:path';
import { confirmationStatus, runConfirmation } from '../confirm.ts';
import { stateDir } from '../ledger.ts';
import { provideGoalctl } from '../regress.ts';
import { declaredTestTimeout, planUnitGateShards } from '../unit-gate.ts';
import { heavyQaStatus } from '../qa-slots.ts';

export const usage = 'Usage: goalctl confirm [--status]';

export default async function confirm(args: string[]): Promise<number> {
  if (args.length && (args.length !== 1 || args[0] !== '--status')) throw new Error(usage);
  const directory = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
  if (args[0] === '--status') { console.log(confirmationStatus(directory)); return 0; }
  // Owner deadlines must not import the entry module while it awaits this command.
  provideGoalctl({ declaredTestTimeout, planUnitGateShards, heavyQaStatus });
  const manifest = await runConfirmation({ repo: process.cwd(), stateDir: directory,
    checkoutRoot: process.env.GOAL_REGRESS_CHECKOUT_ROOT });
  console.log(confirmationStatus(directory));
  console.log(`Wall time: ${Date.parse(manifest.finishedAt!) - Date.parse(manifest.startedAt)}ms`);
  console.log(`Manifest: ${resolve(directory, 'confirm', manifest.runId, 'manifest.json')}`);
  return manifest.status === 'passed' ? 0 : 1;
}
