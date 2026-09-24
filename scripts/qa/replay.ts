import { resolve } from 'node:path';
import { selectTestCommand } from './test.ts';

const root = resolve(import.meta.dir, '../..');

export interface ReplaySelection { seed: number; file: string; id: string }

export function parseReplayArgs(args: string[]): ReplaySelection {
  if (args.length !== 5 || args[0] !== '--seed' || args[3] !== '-t'
    || !/^-?(?:0|[1-9][0-9]*)$/.test(args[1] ?? '')
    || !/^[A-Z][A-Z0-9]*\d{2,}$/.test(args[4] ?? '')) {
    throw new Error('Usage: yarn qa:replay --seed <signed-32-bit integer> <file> -t <ID>');
  }
  const seed = Number(args[1]);
  if (!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    throw new Error('Replay seed must be a signed 32-bit integer');
  }
  // The ordinary selector validates the checkout path and routes stack-backed files.
  selectTestCommand([args[2]!, '-t', args[4]!]);
  return { seed, file: args[2]!, id: args[4]! };
}

if (import.meta.main) {
  const selection = parseReplayArgs(process.argv.slice(2));
  const [program, args] = selectTestCommand([selection.file, '-t', selection.id]);
  console.log(`Replaying ${selection.id} with fast-check seed ${selection.seed}`);
  const child = Bun.spawn([program, ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, REZICS_QA_SEED: String(selection.seed) } });
  process.exit(await child.exited);
}
