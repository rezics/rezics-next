#!/usr/bin/env bun
import { createRuntime, type Runtime } from './config.ts';
import { runIntegration, type IntegrationRuntime, recordManagerCommand } from './integration-cli.ts';
import { runWorkerCommand } from './worker-commands.ts';

const workerCommands = ['dispatch', 'status', 'retry', 'stop', 'cancel', 'consult', 'attempts', 'report', 'import-attempt', 'event'];
const integrationCommands = ['land', 'train', 'manager', 'inbox', '_manager-host'];
export const commands = [...workerCommands, ...integrationCommands];

/** Runtime injection is confined to the programmatic test entry point. */
export async function run(argv: string[], factory: () => Runtime | IntegrationRuntime | Promise<Runtime | IntegrationRuntime> = createRuntime): Promise<number> {
  const [command, ...args] = argv;
  if (!command || !commands.includes(command)) { console.error(`usage: goal <${commands.join('|')}> [args]`); return 2; }
  let runtime: Runtime | IntegrationRuntime | undefined;
  try {
    runtime = await factory();
    if (runtime.recoverOrphans) await runtime.recoverOrphans();
    if (workerCommands.includes(command)) {
      if (!('job' in runtime)) throw new Error('Worker commands require the shared runtime');
      await recordManagerCommand(runtime);
      return await runWorkerCommand(command, args, { runtime });
    }
    return await runIntegration([command, ...args], runtime);
  } catch (error) { console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); return 1; }
  finally { runtime?.db.close(); }
}
if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
