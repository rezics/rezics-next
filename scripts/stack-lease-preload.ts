import { readFileSync } from 'node:fs';
import { acquireStackSlot } from './stack-lease.ts';

const requiredValueOptions = new Set([
  '--timeout',
  '--rerun-each',
  '--retry',
  '--seed',
  '--coverage-reporter',
  '--coverage-dir',
  '-t',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--shard',
  '--timings',
]);

function testArguments(): string[] {
  // Bun sets process.argv to the first test file, while /proc preserves the full `bun test` invocation.
  try {
    const args = readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
    const command = args.indexOf('test');
    if (command !== -1) return args.slice(command + 1);
  } catch {
    // Use Bun's test-file argv below if procfs is unavailable.
  }

  return process.argv.length > 2 ? process.argv.slice(2) : process.argv.slice(1);
}

function testFileFilters(args: string[]): string[] {
  const filters: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') {
      filters.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith('-')) {
      filters.push(argument);
      continue;
    }
    if (argument.includes('=')) continue;
    if (requiredValueOptions.has(argument)) {
      index++;
      continue;
    }
    if (argument === '--changed') {
      if (args[index + 1] && !args[index + 1]!.startsWith('-')) index++;
      continue;
    }
    if ((argument === '--bail' || argument === '--parallel') && /^\d+$/.test(args[index + 1] ?? '')) {
      index++;
    }
  }
  return filters;
}

function includesSpecs(filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => /(?:^|[/\\])specs(?:[/\\]|$)/.test(filter));
}

if (includesSpecs(testFileFilters(testArguments()))) {
  const slot = await acquireStackSlot('root bun test');
  if (slot.env.REZICS_STACK_SLOT !== undefined) {
    process.env.REZICS_STACK_SLOT = slot.env.REZICS_STACK_SLOT;
  }
}
