import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import reylo from 'reylo/esbuild';

const driverURL = new URL('./erasure-operation-driver.ts', import.meta.url);
process.env.ERASURE_OPERATION_DRIVER = fileURLToPath(driverURL);
const phaseLog = fileURLToPath(new URL('../../../../.temp/erasure-phases.log', import.meta.url));
const bundleDir = fileURLToPath(new URL('../../.temp/erasure-worker/', import.meta.url));
mkdirSync(dirname(phaseLog), { recursive: true });

// Compile the worker once. The child then loads JavaScript with its SQL already
// inlined, instead of transpiling the kernel graph under the hook timer.
mkdirSync(bundleDir, { recursive: true });
const built = await Bun.build({
  entrypoints: [fileURLToPath(driverURL)],
  outdir: bundleDir,
  target: 'bun',
  splitting: true,
  packages: 'external',
  plugins: [
    reylo(),
    {
      name: 'external-parent-imports',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind !== 'dynamic-import' || args.path.includes('growth.ts')) return;
          if (args.path.startsWith('@') || !args.path.startsWith('.')) return { path: args.path, external: true };
          return { path: resolve(args.resolveDir, args.path), external: true };
        });
      },
    },
  ],
});
if (!built.success) throw new Error(built.logs.map((entry) => entry.message).join('\n'));
const bundle = built.outputs.find((output) => output.kind === 'entry-point')?.path;
if (!bundle) throw new Error('Erasure worker bundle has no entry point');
process.env.ERASURE_OPERATION_WORKER_BUNDLE = bundle;

const workerProgram = `import { writeSync } from 'node:fs';
writeSync(1, 'ERASURE_WORKER_PHASE spawn\\n');
try {
  const module = await import(${JSON.stringify(bundle)});
  writeSync(1, 'ERASURE_WORKER_PHASE imported\\n');
  await module.runOperationWorkerProcess();
} catch (error) {
  console.error(error);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeSync(1, 'ERASURE_WORKER_FAILED ' + detail.replaceAll('\\n', ' | ') + '\\n');
  process.exit(1);
}`;

type PrefetchedLane = {
  child: ReturnType<typeof Bun.spawn> & {
    stdin: Bun.FileSink;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
  output: string;
  stderr: string;
  pending: string;
  lines: string[];
  waiters: { startsWith: string; resolve(value: string): void; reject(error: Error): void }[];
  stdoutTask: Promise<void>;
  stderrTask: Promise<void>;
};

function createPrefetchedLane(): PrefetchedLane {
  const lane: PrefetchedLane = {
    child: undefined as never,
    output: '',
    stderr: '',
    pending: '',
    lines: [],
    waiters: [],
    stdoutTask: Promise.resolve(),
    stderrTask: Promise.resolve(),
  };
  const accept = (line: string) => {
    appendFileSync(phaseLog, `${Date.now()} child ${line.slice(0, 240)}\n`);
    lane.output += `${line}\n`;
    for (let index = 0; index < lane.waiters.length; index++) {
      const waiter = lane.waiters[index]!;
      if (line.startsWith(waiter.startsWith)) {
        lane.waiters.splice(index, 1);
        waiter.resolve(line);
        return;
      }
    }
    lane.lines.push(line);
  };
  lane.child = Bun.spawn([process.execPath, '-e', workerProgram], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, DATABASE_URL: '', ERASURE_OPERATION_WORKER: '1' },
  }) as PrefetchedLane['child'];
  const launched = lane.child;
  lane.stdoutTask = (async () => {
    const reader = launched.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      lane.pending += decoder.decode(result.value, { stream: true });
      const split = lane.pending.split('\n');
      lane.pending = split.pop() ?? '';
      for (const line of split) accept(line.replace(/\r$/, ''));
    }
  })();
  lane.stderrTask = (async () => {
    const reader = launched.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const text = decoder.decode(result.value, { stream: true });
      lane.stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) appendFileSync(phaseLog, `${Date.now()} stderr ${line.slice(0, 400)}\n`);
      }
    }
  })();
  return lane;
}

const prefetched: PrefetchedLane[] = [createPrefetchedLane()];
(globalThis as { __erasureWorkerLanes?: PrefetchedLane[] }).__erasureWorkerLanes = prefetched;

// Compile the parent graph before the hook timer starts. The frozen suite's
// beforeEach then only pays for the native system and the worker launch.
await Promise.all([
  import('./erasure-operation-driver.ts'),
  import('../../src/http/kernel.ts'),
  import('../../src/access/write-rate.ts'),
  import('./support/erasure-operation-fixtures.ts'),
  import('../support/growth.ts'),
  import('@rezics/document'),
  import('./support/sql-observer.ts'),
]);
// The frozen suite expects a null tombstone digest. Loading it by URL keeps that
// comparison in the test run without pulling the suite into this compilation.
const suite = new URL('../../../../specs/erasure-operation-outcomes.test.ts', import.meta.url);
await import(suite.href);
