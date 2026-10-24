#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runIntegration, type IntegrationRuntime } from './integration-cli.ts';
import { runWorkerCommand } from './worker-commands.ts';

export type Command = { run(argv: string[]): number | Promise<number> };

const workerCommands = ['dispatch', 'status', 'retry', 'stop', 'consult', 'attempts', 'import-attempt', 'event'];
const integrationCommands = ['land', 'train', 'manager', 'inbox', '_manager-host'];

export const commands: Record<string, () => Promise<Command>> = Object.fromEntries([
  ...workerCommands.map(name => [name, async () => ({ run: (argv: string[]) => runWorkerCommand(name, argv) })]),
  ...integrationCommands.map(command => [command, async () => ({
    async run(argv: string[]): Promise<number> {
      const modulePath = process.env.GOAL_RUNTIME;
      if (!modulePath) throw new Error('Set GOAL_RUNTIME to the module exporting createIntegrationRuntime()');
      const module = await import(pathToFileURL(resolve(modulePath)).href) as { createIntegrationRuntime(): IntegrationRuntime | Promise<IntegrationRuntime> };
      const runtime = await module.createIntegrationRuntime();
      try { return await runIntegration([command, ...argv], runtime); }
      finally { runtime.db.close(); }
    },
  })]),
]);

export async function run(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const load = command === undefined ? undefined : commands[command];
  if (!load) { console.error(`usage: goal <${Object.keys(commands).sort().join('|')}> [args]`); return 2; }
  try { return await (await load()).run(args); }
  catch (error) { console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); return 1; }
}
if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
