import type { WorkerJob } from './job.ts';
import type { GateRunner } from './merge.ts';
import type { Settings } from './types.ts';

/** Check the integrated batch, publish it on main, or revert its failing dependency closure on dev. */
export async function promote(options: { settings: Settings; job: WorkerJob; runGate?: GateRunner }): Promise<void> {
  void options;
  throw new Error('not implemented');
}
