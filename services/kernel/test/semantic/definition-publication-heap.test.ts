import { expect, test } from 'bun:test';
import { gcAndSweep, heapStats } from 'bun:jsc';
import { createHash } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { PROPOSED_ANALYSIS_MAX, workDiagnostic } from './support/definition-publication-work.ts';
import {
  HEAP_SCALES,
  DIAGNOSTIC_WIRE_CAP,
  heapFixture,
  jsonNodeCount,
  maximumContextWitness,
  retainsCatalogue,
  type HeapObservation,
  type HeapReading,
  type HeapFamily,
} from './support/definition-publication-heap.ts';

type Reply = {
  kind: string;
  error?: string;
  isMainThread?: boolean;
  threadId?: number;
  heap?: HeapReading;
  idle?: HeapReading;
  values?: { size: number; count: number; baseline: HeapReading; retained: HeapReading; released: HeapReading }[];
  observation?: HeapObservation;
  input?: ArrayBuffer;
  detachedBytes?: number;
};
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('one real Worker measures idle and retained job heap across independent valid and invalid three-scale families', async () => {
  // There is exactly one Worker constructor in the entire diagnostic, no pool,
  // replacement, fake exit acknowledgement, native route or database binding.
  const worker = new Worker(new URL('./support/definition-publication-heap-worker.ts', import.meta.url).href);
  const queue: Reply[] = [];
  let pending: { resolve: (value: Reply) => void; reject: (error: Error) => void } | undefined;
  let failed: Error | undefined;
  let closed = false;
  const close = new Promise<void>((resolve) => {
    worker.addEventListener('close', () => {
      closed = true;
      if (pending) pending.reject(new Error('Worker closed before diagnostic reply'));
      pending = undefined;
      resolve();
    });
  });
  worker.onmessage = (event: MessageEvent<Reply>) => {
    if (event.data.kind === 'failure') {
      failed = new Error(event.data.error);
      pending?.reject(failed);
      pending = undefined;
    } else if (pending) {
      const { resolve } = pending;
      pending = undefined;
      resolve(event.data);
    } else queue.push(event.data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failed = new Error(event.message);
    pending?.reject(failed);
    pending = undefined;
  };
  const next = async (kind: string): Promise<Reply> => {
    if (failed) throw failed;
    const value =
      queue.shift() ??
      (await new Promise<Reply>((resolve, reject) => {
        pending = { resolve, reject };
      }));
    if (value.kind !== kind) throw new Error(`Expected ${kind}, received ${value.kind}`);
    return value;
  };
  const observations: HeapObservation[] = [];
  let finished = false;
  try {
    const ready = await next('ready');
    console.log('definition-publication-heap ready', JSON.stringify(ready));
    expect(ready.isMainThread).toBe(false);
    expect(ready.threadId).toBeGreaterThan(0);
    expect(ready.heap!.min).toBeGreaterThan(0);
    worker.postMessage({ kind: 'calibrate' });
    const calibration = await next('calibrated');
    console.log('definition-publication-heap calibration', JSON.stringify(calibration));
    let previousGrowth = 0;
    for (const value of calibration.values!) {
      expect(value.count).toBe(value.size);
      const cellGrowth = value.retained.collections[0]!.objectCount - value.baseline.collections[0]!.objectCount;
      expect(cellGrowth).toBeGreaterThanOrEqual(value.size);
      const growth = value.retained.min - value.baseline.max;
      expect(growth).toBeGreaterThan(previousGrowth);
      previousGrowth = growth;
    }

    // Independently establish VM locality: live parent objects are observable in
    // the parent's heap, but not counted as new objects in the Worker's heap.
    gcAndSweep();
    const parentBefore = heapStats().objectCount;
    const parentWitness = Array.from({ length: 32768 }, (_, index) => ({ index }));
    gcAndSweep();
    const parentAfter = heapStats().objectCount;
    worker.postMessage({ kind: 'idle' });
    const isolated = await next('idle');
    expect(parentAfter - parentBefore).toBeGreaterThanOrEqual(parentWitness.length);
    expect(isolated.heap!.collections[0]!.objectCount - calibration.idle!.collections[0]!.objectCount).toBeLessThan(
      parentWitness.length,
    );
    console.log(
      'definition-publication-heap VM locality',
      JSON.stringify({
        parentBefore,
        parentAfter,
        retainedParentObjects: parentWitness.length,
        worker: isolated.heap,
      }),
    );

    for (const family of ['properties', 'strings', 'nodes'] as const satisfies readonly HeapFamily[]) {
      for (const valid of [true, false]) {
        const series: HeapObservation[] = [];
        for (const scale of HEAP_SCALES) {
          const shape = { family, valid, scale };
          const { release, wire } = heapFixture(shape);
          expect(retainsCatalogue(release)).toBe(true);
          if (family === 'properties' && valid) {
            // Consume the prior diagnostic, including actual checker imports;
            // never substitute a second release builder or estimated steps.
            const diagnostic = workDiagnostic(release);
            expect(diagnostic.allSafe).toBe(true);
            expect(diagnostic.newSteps).toBe(967 + 14 * scale);
          }
          worker.postMessage({ kind: 'idle' });
          await next('idle');
          const originalBytes = wire.byteLength;
          const originalHash = sha(wire);
          const expectedNodes = jsonNodeCount({ release });
          const input = wire.buffer as ArrayBuffer;
          worker.postMessage({ kind: 'sample', shape, input, context: maximumContextWitness() }, [input]);
          expect(wire.byteLength).toBe(0);
          expect(input.byteLength).toBe(0);
          const reply = await next('sample');
          const observation = reply.observation!;
          // Parent reviews full output and recomputes the measured range before
          // reporting it. These comparisons approve instrumentation, never c.
          expect(observation.shape).toEqual(shape);
          expect(observation.wireBytes).toBe(originalBytes);
          expect(originalBytes).toBeLessThanOrEqual(DIAGNOSTIC_WIRE_CAP);
          expect(observation.jsonNodes).toBe(expectedNodes);
          expect(observation.contextCanonicalBytes).toBe(6304);
          expect(observation.envelopeMinusBodyBytes).toBe(76 + 6 * 1024 + 92);
          expect(observation.errors.length === 0).toBe(valid);
          expect(sha(new Uint8Array(reply.input!))).toBe(originalHash);
          const postMin = Math.max(...observation.phases.map((value) => value.heap.min));
          const postMax = Math.max(...observation.phases.map((value) => value.heap.max));
          expect(observation.cMin).toBe(
            Math.max(0, postMin - observation.baseline.max - originalBytes) / originalBytes,
          );
          expect(observation.cMax).toBe(
            Math.max(0, postMax - observation.baseline.min - originalBytes) / originalBytes,
          );
          expect(observation.phases.map((value) => value.name)).toEqual([
            'received-input-and-context',
            'decode-and-parse',
            'unchanged-validation-including-checker',
            'retained-release-canonicalization',
            'actual-release-digest-including-its-own-JCS',
          ]);
          for (const phase of observation.phases) {
            expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
            expect(phase.heap.collections.length).toBe(3);
            for (const point of phase.heap.collections) {
              expect(point.heapSize).toBeGreaterThan(0);
              expect(point.heapCapacity).toBeGreaterThanOrEqual(point.heapSize);
            }
          }
          const released = await next('released');
          expect(released.detachedBytes).toBe(0);
          console.log('definition-publication-heap sample', JSON.stringify({ observation, released }));
          series.push(observation);
          observations.push(observation);
        }
        expect(series[1]!.wireBytes).toBeGreaterThan(series[0]!.wireBytes);
        expect(series[2]!.wireBytes).toBeGreaterThan(series[1]!.wireBytes);
        if (family === 'nodes') {
          expect(series[1]!.jsonNodes).toBeGreaterThan(series[0]!.jsonNodes);
          expect(series[2]!.jsonNodes).toBeGreaterThan(series[1]!.jsonNodes);
        }
        if (family === 'strings') expect(new Set(series.map((value) => value.jsonNodes)).size).toBe(1);
        if (family !== 'properties') expect(new Set(series.map((value) => value.properties)).size).toBe(1);
        else expect(series[2]!.properties).toBe(Object.keys(bundledRelease.properties).length + HEAP_SCALES[2]);
      }
    }
    const worst = observations.reduce((a, b) => (a.cMax > b.cMax ? a : b));
    console.log(
      'definition-publication-heap observed-only summary',
      JSON.stringify({
        samples: observations.length,
        h0Min: Math.min(...observations.map((value) => value.baseline.min)),
        h0Max: Math.max(...observations.map((value) => value.baseline.max)),
        exercisedC: { min: worst.cMin, max: worst.cMax, shape: worst.shape },
        observedCapacityMax: Math.max(...observations.map((value) => value.observedCapacityMax)),
        truePeak: null,
        worstCaseCApproved: false,
        candidateAnalysisMax: PROPOSED_ANALYSIS_MAX,
        requiredExecutedBoundary: PROPOSED_ANALYSIS_MAX + 8193,
        omitted: [
          'construction-bounded maximum valid/invalid shapes',
          'unsafe quadratic duplicate axis',
          'synchronous phase-internal peak',
          'physical exit/reclamation',
          'native DB/result binding',
          'idle native margin',
        ],
      }),
    );
    worker.postMessage({ kind: 'finish' });
    console.log('definition-publication-heap logical finish', JSON.stringify(await next('finished')));
    await close;
    finished = true;
  } finally {
    if (!finished && !closed) {
      worker.terminate();
      await close;
    }
  }
}, 180_000);
