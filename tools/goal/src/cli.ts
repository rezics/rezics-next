#!/usr/bin/env bun
// `goal <command> [args]`. Each command module exports `run(argv)` and returns the exit code.

export type Command = { run(argv: string[]): number | Promise<number> };

const commands: Record<string, () => Promise<Command>> = {};

const [command, ...argv] = Bun.argv.slice(2);
const load = command === undefined ? undefined : commands[command];
if (load === undefined) {
  console.error(`usage: goal <${Object.keys(commands).sort().join('|')}> [args]`);
  process.exit(2);
}
process.exit(await (await load()).run(argv));
