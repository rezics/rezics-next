import { gcAndSweep, heapStats } from 'bun:jsc';
import { releaseDigest, validateRelease, type Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import canonicalize from 'canonicalize';
import { hostname, loadavg, cpus, platform, release as osRelease } from 'node:os';
import { threadId, isMainThread } from 'node:worker_threads';
import { workDiagnostic } from './definition-publication-work.ts';
import {
  DIAGNOSTIC_WIRE_CAP,
  jsonNodeCount,
  type HeapPoint,
  type HeapReading,
  type HeapPhase,
  type HeapObservation,
  type HeapShape,
  type maximumContextWitness,
} from './definition-publication-heap.ts';

declare const self: Worker;

function point(): HeapPoint {
  const value = heapStats();
  return {
    heapSize: value.heapSize,
    heapCapacity: value.heapCapacity,
    extraMemorySize: value.extraMemorySize,
    objectCount: value.objectCount,
    globals: value.globalObjectCount,
  };
}

function reading(): HeapReading {
  const beforeGC = point();
  const collections: HeapPoint[] = [];
  for (let index = 0; index < 3; index++) {
    Bun.gc(true);
    gcAndSweep();
    collections.push(point());
  }
  const sizes = collections.map((value) => value.heapSize);
  return { beforeGC, collections, min: Math.min(...sizes), max: Math.max(...sizes) };
}

type Context = ReturnType<typeof maximumContextWitness>;
// Explicit roots keep the values live across synchronous GCs. Nulling these
// releases JS ownership, not the VM/thread or its physical allocation.
let job: {
  input: ArrayBuffer;
  context: Context;
  text?: string;
  parsed?: { release: Release };
  canonical?: string;
  errors?: ReturnType<typeof validateRelease>;
  digest?: string;
} | null = null;
let calibration: { index: number; text: string }[] | null = null;

// Initialize actual compiled schema, validator and actual eight-source checker
// diagnostic before measuring idle H0. No initialized proof authorizes a job.
if (validateRelease(bundledRelease).length) throw new Error('Current bundle failed Worker initialization');
const initialization = workDiagnostic(bundledRelease);
if (!initialization.allSafe || !initialization.fixedSafe) throw new Error('Worker checker initialization failed');
const ready = {
  kind: 'ready',
  runtime: { version: Bun.version, revision: Bun.revision, executable: process.execPath },
  host: {
    hostname: hostname(),
    platform: platform(),
    release: osRelease(),
    processors: cpus().length,
    load: loadavg(),
  },
  threadId,
  isMainThread,
  initialization: {
    fixedSources: initialization.fixedSources,
    fixedInitializationSteps: initialization.fixedInitializationSteps,
    newSteps: initialization.newSteps,
  },
  heap: reading(),
};

function run(shape: HeapShape): HeapObservation {
  if (!job) throw new Error('Missing owned job');
  const wireBytes = job.input.byteLength;
  if (wireBytes > DIAGNOSTIC_WIRE_CAP) throw new Error('Oversized diagnostic input');
  const phases: HeapPhase[] = [];
  const phase = (name: string, action: () => void) => {
    const start = performance.now();
    action();
    const elapsedMs = performance.now() - start;
    phases.push({ name, elapsedMs, heap: reading() });
  };
  phase('received-input-and-context', () => {});
  phase('decode-and-parse', () => {
    job!.text = new TextDecoder().decode(job!.input);
    job!.parsed = JSON.parse(job!.text);
  });
  phase('unchanged-validation-including-checker', () => {
    job!.errors = validateRelease(job!.parsed!.release);
  });
  phase('retained-release-canonicalization', () => {
    job!.canonical = canonicalize(job!.parsed!.release)!;
  });
  phase('actual-release-digest-including-its-own-JCS', () => {
    job!.digest = releaseDigest(job!.parsed!.release);
  });
  const release = job.parsed!.release;
  const body = { params: {}, body: job.parsed };
  const contextCanonicalBytes = Buffer.byteLength(canonicalize(job.context)!);
  // Arithmetic witness only. No receipt digest implementation/Actor is copied.
  const envelopeMinusBodyBytes =
    Buffer.byteLength(canonicalize({ ...job.context, body })!) - Buffer.byteLength(canonicalize(body)!);
  return {
    shape,
    wireBytes,
    releaseBytes: Buffer.byteLength(job.canonical!),
    jsonNodes: jsonNodeCount(job.parsed),
    properties: Object.keys(release.properties).length,
    contextCanonicalBytes,
    envelopeMinusBodyBytes,
    errors: job.errors!,
    digest: job.digest!,
    phases,
    baseline: idle,
    // Take the largest retained phase, excluding the owned transferred bytes
    // exactly once. Context/diagnostic overhead remains conservatively included.
    cMin: Math.max(0, Math.max(...phases.map((value) => value.heap.min)) - idle.max - wireBytes) / wireBytes,
    cMax: Math.max(0, Math.max(...phases.map((value) => value.heap.max)) - idle.min - wireBytes) / wireBytes,
    observedCapacityMax: Math.max(
      ...phases.flatMap((value) => [
        value.heap.beforeGC.heapCapacity,
        ...value.heap.collections.map((entry) => entry.heapCapacity),
      ]),
    ),
  };
}

let idle = ready.heap;
self.onmessage = (event: MessageEvent) => {
  try {
    if (event.data.kind === 'calibrate') {
      const values = [];
      for (const size of [1024, 4096, 16384]) {
        const baseline = reading();
        calibration = Array.from({ length: size }, (_, index) => ({ index, text: `heap-witness-${index}` }));
        const retained = reading();
        // Read after GC, preventing any liveness optimization of the witness.
        const count = calibration.length;
        calibration = null;
        values.push({ size, count, baseline, retained, released: reading() });
      }
      idle = reading();
      self.postMessage({ kind: 'calibrated', values, idle });
    } else if (event.data.kind === 'sample') {
      job = { input: event.data.input, context: event.data.context };
      const observation = run(event.data.shape);
      const input = job.input;
      job = null;
      self.postMessage({ kind: 'sample', observation, input }, [input]);
      // This task has returned its buffer, detached in the job. No reply claims
      // physical reclamation. The event's input view is detached as well.
      self.postMessage({ kind: 'released', detachedBytes: input.byteLength, heap: reading() });
    } else if (event.data.kind === 'idle') {
      idle = reading();
      self.postMessage({ kind: 'idle', heap: idle });
    } else if (event.data.kind === 'finish') {
      self.onmessage = null;
      self.postMessage({ kind: 'finished', heap: reading() });
      // Natural event-loop exhaustion; no replacement is started by this test.
    } else throw new Error('Unknown heap diagnostic message');
  } catch (error) {
    job = null;
    calibration = null;
    self.postMessage({ kind: 'failure', error: String(error) });
    self.onmessage = null;
  }
};
self.postMessage(ready);
