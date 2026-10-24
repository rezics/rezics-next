#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runIntegration, type IntegrationRuntime } from './integration-cli.ts';

export type Command = { run(argv: string[]): number | Promise<number> };
export const commands: Record<string, () => Promise<Command>> = Object.fromEntries(
  ['land', 'train', 'manager', 'inbox', '_manager-host'].map(command => [command, async () => ({
    async run(argv: string[]): Promise<number> {
      const modulePath = process.env.GOAL_RUNTIME;
      if (!modulePath) throw new Error('Set GOAL_RUNTIME to the module exporting createIntegrationRuntime()');
      const module = await import(pathToFileURL(resolve(modulePath)).href) as { createIntegrationRuntime(): IntegrationRuntime | Promise<IntegrationRuntime> };
      const runtime = await module.createIntegrationRuntime();
      try { return await runIntegration([command, ...argv], runtime); }
      finally { runtime.db.close(); }
    },
  })]),
);

if (import.meta.main) {
  const [command, ...argv] = Bun.argv.slice(2);
  const load = command === undefined ? undefined : commands[command];
  if (!load) { console.error('usage: goal <land|train|manager|inbox> [args]'); process.exit(2); }
  try { process.exit(await (await load()).run(argv)); }
  catch (error) { console.error(String(error)); process.exit(1); }
}
