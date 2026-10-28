#!/usr/bin/env bun
import { createRuntime, type Runtime } from './config.ts';
import { runIntegration, type IntegrationRuntime, recordManagerCommand } from './integration-cli.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { installPrivate } from './shared-dependencies.ts';

const workerCommands = [
  'dispatch',
  'status',
  'retry',
  'stop',
  'cancel',
  'retarget',
  'consult',
  'attempts',
  'report',
  'import-attempt',
  'event',
];
const integrationCommands = ['land', 'train', 'promote', 'manager', 'inbox', '_manager-host'];
export const commands = [...workerCommands, ...integrationCommands];
/** Commands that run often and never settle workers themselves; the manager host's sweep recovers orphans. */
export const SWEEP_FREE_COMMANDS = new Set(['train', 'inbox']);

/** Runtime injection is confined to the programmatic test entry point. */
export async function run(
  argv: string[],
  factory: (options?: {
    trainMode: 'detached' | 'inline';
  }) => Runtime | IntegrationRuntime | Promise<Runtime | IntegrationRuntime> = createRuntime,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'deps' && args[0] === 'private' && args.length === 1) {
    try { installPrivate(process.cwd()); return 0; }
    catch (error) { console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); return 1; }
  }
  if (!command || !commands.includes(command)) {
    console.error(`usage: goal <${commands.join('|')}> [args]`);
    return 2;
  }
  let runtime: Runtime | IntegrationRuntime | undefined;
  // Only the train itself and land drain the train in this process; everything else, the host included, hands it
  // off, so a promotion never holds a command or the manager socket.
  const trainMode = ['land', 'train'].includes(command) ? 'inline' : 'detached';
  try {
    runtime = await factory({ trainMode });
    // A command settles only orphans whose worker has exited; the host adopts the ones still running. The train and
    // the inbox leave that to the host's sweep: every settle spawns a train, and each spawned train swept the whole
    // store before finding the train lease held, so dozens swept at once (load 146 on 2026-10-28).
    if (runtime.recoverOrphans && !SWEEP_FREE_COMMANDS.has(command))
      await runtime.recoverOrphans({ adoptRunning: false });
    if (workerCommands.includes(command)) {
      if (!('job' in runtime)) throw new Error('Worker commands require the shared runtime');
      await recordManagerCommand(runtime);
      if (command === 'retarget') {
        if (!('tasks' in runtime)) throw new Error('Worker commands require the shared runtime');
        if (process.env.GOAL_TASK_ID && process.env.GOAL_ATTEMPT)
          runtime.store.assertCurrent({ taskId: process.env.GOAL_TASK_ID, attempt: Number(process.env.GOAL_ATTEMPT) });
        const [taskId, target] = args;
        if (!taskId || !target || args.length !== 2) throw new Error('usage: retarget <task> stabilize');
        runtime.tasks.retarget(taskId, target);
        return 0;
      }
      return await runWorkerCommand(command, args, { runtime });
    }
    return await runIntegration([command, ...args], runtime);
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return 1;
  } finally {
    runtime?.db.close();
  }
}
if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
