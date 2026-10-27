#!/usr/bin/env bun
import { createRuntime, type Runtime } from './config.ts';
import { runIntegration, type IntegrationRuntime, recordManagerCommand } from './integration-cli.ts';
import { runWorkerCommand } from './worker-commands.ts';

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
const integrationCommands = ['land', 'train', 'manager', 'inbox', '_manager-host'];
export const commands = [...workerCommands, ...integrationCommands];

/** Runtime injection is confined to the programmatic test entry point. */
export async function run(
  argv: string[],
  factory: () => Runtime | IntegrationRuntime | Promise<Runtime | IntegrationRuntime> = createRuntime,
): Promise<number> {
  const [command, ...args] = argv;
  if (!command || !commands.includes(command)) {
    console.error(`usage: goal <${commands.join('|')}> [args]`);
    return 2;
  }
  let runtime: Runtime | IntegrationRuntime | undefined;
  // Only the train itself and land drain the train in this process; everything else, the host included, hands it
  // off, so a promotion never holds a command or the manager socket.
  if (!['land', 'train'].includes(command)) process.env.GOAL_TRAIN_MODE = 'detached';
  try {
    runtime = await factory();
    // A command settles only orphans whose worker has exited; the host adopts the ones still running.
    if (runtime.recoverOrphans) await runtime.recoverOrphans({ adoptRunning: false });
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
