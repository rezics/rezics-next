import { join, resolve } from 'node:path';
import { confirmationStatus, confirmationUsage, parseConfirmationArgs, runConfirmation } from '../confirm.ts';
import { stateDir } from '../ledger.ts';
import { provideGoalctl } from '../regress.ts';
import { declaredTestTimeout, planUnitGateShards } from '../unit-gate.ts';
import { heavyQaStatus, qaSlotCount } from '../qa-slots.ts';

export const usage = confirmationUsage;

export default async function confirm(args: string[]): Promise<number> {
  const options = parseConfirmationArgs(args);
  const directory = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
  if (options.status) { console.log(confirmationStatus(directory, Date.now(), options.run)); return 0; }
  // Owner deadlines must not import the entry module while it awaits this command.
  provideGoalctl({ declaredTestTimeout, planUnitGateShards, heavyQaStatus });
  const manifest = await runConfirmation({ repo: process.cwd(), stateDir: directory,
    at: options.at, lanes: options.lanes, record: options.record,
    // Moving reports to a worktree does not move the host's admission configuration.
    slots: qaSlotCount(join(stateDir, 'qa-slots')),
    checkoutRoot: process.env.GOAL_REGRESS_CHECKOUT_ROOT });
  console.log(confirmationStatus(directory, Date.now(), manifest.runId));
  console.log(`Wall time: ${Date.parse(manifest.finishedAt!) - Date.parse(manifest.startedAt)}ms`);
  console.log(`Manifest: ${resolve(directory, 'confirm', manifest.runId, 'manifest.json')}`);
  return manifest.status === 'passed' ? 0 : 1;
}
