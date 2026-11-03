#!/usr/bin/env bun
import { checkSettings, createRuntime, loadSettings, settingsFile, type Runtime } from './config.ts';
import { runIntegration, type IntegrationRuntime, recordManagerCommand } from './integration-cli.ts';
import { runWorkerCommand, READ_ONLY_WORKER_COMMANDS } from './worker-commands.ts';
import { parseWorkerCommandArguments, type ParsedWorkerCommandArguments } from './command-arguments.ts';
import { installPrivate } from './shared-dependencies.ts';
import { installService, reportServices } from './service.ts';
import { MAINTENANCE_JOBS, runMaintenance, runResidentVerifier, type MaintenanceJob } from './maintenance.ts';
import { runPublicationCommand } from './publication-command.ts';

const workerCommands = [
  'dispatch',
  'amend',
  'status',
  'retry',
  'priority',
  'stop',
  'cancel',
  'retarget',
  'consult',
  'attempts',
  'report',
  'import-attempt',
  'event',
];
const integrationCommands = [
  'land',
  'train',
  'promote',
  'verify',
  'manager',
  'inbox',
  'backlog',
  'publication',
  '_manager-host',
];
export const commands = [...workerCommands, ...integrationCommands, 'service', 'maintenance'];
/** Commands that run often and never settle workers themselves; the manager host's sweep recovers orphans. */
export const SWEEP_FREE_COMMANDS = new Set([
  'service',
  'maintenance',
  'train',
  'inbox',
  'backlog',
  'publication',
  'amend',
  'event',
  ...READ_ONLY_WORKER_COMMANDS,
]);

/** Runtime injection is confined to the programmatic test entry point. */
export async function run(
  argv: string[],
  factory: (options?: {
    trainMode: 'detached' | 'inline';
  }) => Runtime | IntegrationRuntime | Promise<Runtime | IntegrationRuntime> = createRuntime,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'deps' && args[0] === 'private' && args.length === 1) {
    try {
      installPrivate(process.cwd());
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return 1;
    }
  }
  if (command === 'service' && args[0] !== 'run-verifier') {
    try {
      if (args.length !== 1) throw new Error('usage: goal service install|status|restart|logs');
      if (args[0] === 'install') {
        const settings = loadSettings();
        await installService({ mainCheckout: settings.mainCheckout, localConfig: settingsFile() });
        return await reportServices('status');
      }
      if (args[0] === 'status' || args[0] === 'restart' || args[0] === 'logs') return await reportServices(args[0]);
      throw new Error('usage: goal service install|status|restart|logs');
    } catch (error) {
      console.error(String(error));
      return 1;
    }
  }
  if (command === 'config') {
    if (args[0] !== 'check' || args.length > 2) {
      console.error('usage: goal config check [file]');
      return 2;
    }
    const file = settingsFile(args[1] === undefined ? {} : { localFile: args[1] });
    try {
      checkSettings({ localFile: file });
      console.log(`valid: ${file}`);
      return 0;
    } catch (error) {
      console.error(`invalid: ${file}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (!command || !commands.includes(command)) {
    console.error(`usage: goal <${commands.join('|')}> [args]`);
    return 2;
  }
  let runtime: Runtime | IntegrationRuntime | undefined;
  // Only the train itself and land drain the train in this process; everything else, the host included, hands it
  // off, so a promotion never holds a command or the manager socket.
  const trainMode = ['land', 'train'].includes(command) ? 'inline' : 'detached';
  let parsedWorkerArguments: ParsedWorkerCommandArguments | undefined;
  try {
    if (workerCommands.includes(command)) parsedWorkerArguments = parseWorkerCommandArguments(command, args);
    runtime = await factory({ trainMode });
    if (command === 'service') {
      if (args.length !== 1) throw new Error('usage: goal service run-verifier');
      return await runResidentVerifier(runtime);
    }
    if (command === 'maintenance') {
      if (args.length !== 1 || (args[0] !== 'all' && !MAINTENANCE_JOBS.includes(args[0] as MaintenanceJob)))
        throw new Error('usage: goal maintenance all|reap|alarm|detect|regenerate');
      if (!('settings' in runtime)) throw new Error('Maintenance requires the configured Goal runtime');
      return await runMaintenance(args[0] as MaintenanceJob | 'all', runtime);
    }
    // A command settles only orphans whose worker has exited; the host adopts the ones still running. The train and
    // the inbox leave that to the host's sweep: every settle spawns a train, and each spawned train swept the whole
    // store before finding the train lease held, so dozens swept at once (load 146 on 2026-10-28).
    if (runtime.recoverOrphans && !SWEEP_FREE_COMMANDS.has(command))
      await runtime.recoverOrphans({ adoptRunning: false });
    if (workerCommands.includes(command)) {
      if (!('job' in runtime)) throw new Error('Worker commands require the shared runtime');
      if (!READ_ONLY_WORKER_COMMANDS.has(command)) await recordManagerCommand(runtime);
      if (command === 'retarget') {
        if (!('tasks' in runtime)) throw new Error('Worker commands require the shared runtime');
        if (process.env.GOAL_TASK_ID && process.env.GOAL_ATTEMPT)
          runtime.store.assertCurrent({ taskId: process.env.GOAL_TASK_ID, attempt: Number(process.env.GOAL_ATTEMPT) });
        if (parsedWorkerArguments?.command !== 'retarget') throw new Error('Worker command arguments were not parsed');
        runtime.tasks.retarget(parsedWorkerArguments.taskId, parsedWorkerArguments.target);
        return 0;
      }
      if (!parsedWorkerArguments) throw new Error('Worker command arguments were not parsed');
      return await runWorkerCommand(command, args, { runtime, parsedArguments: parsedWorkerArguments });
    }
    if (command === 'publication') {
      if (!('settings' in runtime)) throw new Error('Publication commands require the configured Goal runtime');
      return await runPublicationCommand(args, runtime);
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
