import { inferenceCompilerFlags } from './inference-cost.ts';

const args = Bun.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--diagnostics')) throw new Error('Usage: eden-gate.ts [--diagnostics]');

const started = performance.now();
const child = Bun.spawn(['bun', 'node_modules/typescript/bin/tsc', '--project',
  'tests/qa/client/tsconfig.json', ...(args.length ? inferenceCompilerFlags : [])], { stdout: 'inherit', stderr: 'inherit' });
let expired = false;
const timeout = setTimeout(() => { expired = true; child.kill(); }, 30_000);
const code = await child.exited;
clearTimeout(timeout);
const elapsed = performance.now() - started;
if (expired || code !== 0 || elapsed > 30_000) {
  throw new Error(`Eden MainApp consumer typecheck failed or exceeded 30s (${elapsed.toFixed(0)}ms)`);
}
console.log(`Eden MainApp consumer typecheck: ${elapsed.toFixed(0)}ms`);
