/** The env prefix and following command, with every original argv token left in place. */
export type EnvironmentOperation =
  | { kind: 'unset'; name: string; raw: readonly [string, string] }
  | { kind: 'assignment'; name: string; value: string; raw: readonly [string] };

export type EnvironmentPrefix = {
  offset: number;
  raw: readonly string[];
  command: readonly string[];
  operations: readonly EnvironmentOperation[];
};

/** Parse only env's leading unset and assignment syntax; callers keep their own allowlists. */
export function parseEnvironmentPrefix(argv: readonly string[]): EnvironmentPrefix {
  if (argv[0] !== 'env') return { offset: 0, raw: [], command: argv, operations: [] };

  const operations: EnvironmentOperation[] = [];
  let offset = 1;
  while (offset < argv.length) {
    if (argv[offset] === '-u' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(argv[offset + 1] ?? '')) {
      operations.push({ kind: 'unset', name: argv[offset + 1]!, raw: [argv[offset]!, argv[offset + 1]!] });
      offset += 2;
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]*)$/.exec(argv[offset]!);
    if (assignment) {
      operations.push({
        kind: 'assignment',
        name: assignment[1]!,
        value: assignment[2]!,
        raw: [argv[offset]!],
      });
      offset += 1;
      continue;
    }
    break;
  }
  return { offset, raw: argv.slice(0, offset), command: argv.slice(offset), operations };
}

export type BunTestArgument =
  | { kind: 'option'; flag: string; value: string; index: number; raw: readonly [string, string] }
  | { kind: 'operand'; value: string; index: number; raw: readonly [string] };

export type BunTestCommand = {
  /** Raw argv from the beginning through `test`, including any leading wrapper tokens. */
  prefix: readonly string[];
  /** Index in the original argv of the first token following `test` and any optional cwd. */
  argumentsStart: number;
  /** Ordered test flags and operands, retaining the exact token groups. */
  arguments: readonly BunTestArgument[];
};

/** Parse Bun's test command shape without deciding which cwd, options, or files a caller admits. */
export function parseBunTestCommand(argv: readonly string[], start = 0): BunTestCommand | undefined {
  if (argv[start] !== 'bun') return undefined;

  let index = start + 1;
  if (argv[index] === '--cwd' && argv[index + 1]) index += 2;
  else if (argv[index]?.startsWith('--cwd=')) index += 1;
  if (argv[index] !== 'test') return undefined;
  index += 1;

  const argumentsStart = index;
  const args: BunTestArgument[] = [];
  while (index < argv.length) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (flag === '--timeout' && value !== undefined) {
      args.push({ kind: 'option', flag, value, index, raw: [flag, value] });
      index += 2;
      continue;
    }
    if ((flag === '-t' || flag === '--test-name-pattern') && value && !value.startsWith('-')) {
      args.push({ kind: 'option', flag, value, index, raw: [flag, value] });
      index += 2;
      continue;
    }
    args.push({ kind: 'operand', value: flag, index, raw: [flag] });
    index += 1;
  }
  return { prefix: argv.slice(0, argumentsStart), argumentsStart, arguments: args };
}
