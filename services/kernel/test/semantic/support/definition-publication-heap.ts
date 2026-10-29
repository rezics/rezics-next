import { bundledRelease } from '@rezics/definitions/bundled';
import { publicationFixture } from './definition-publication-work.ts';

// Test-only serial workloads. These are not release admission limits.
export const HEAP_SCALES = [16, 64, 256] as const;
export const DIAGNOSTIC_WIRE_CAP = 1024 * 1024;
export type HeapFamily = 'properties' | 'strings' | 'nodes';
export type HeapShape = { family: HeapFamily; scale: number; valid: boolean };
export type HeapPoint = {
  heapSize: number;
  heapCapacity: number;
  extraMemorySize: number;
  objectCount: number;
  globals: number;
};
export type HeapReading = { beforeGC: HeapPoint; collections: HeapPoint[]; min: number; max: number };
export type HeapPhase = { name: string; elapsedMs: number; heap: HeapReading };
export type HeapObservation = {
  shape: HeapShape;
  wireBytes: number;
  releaseBytes: number;
  jsonNodes: number;
  properties: number;
  contextCanonicalBytes: number;
  envelopeMinusBodyBytes: number;
  errors: { pointer: string; code: string }[];
  digest: string;
  phases: HeapPhase[];
  baseline: HeapReading;
  // This is a sample range, not a confidence interval or a worst-case bound.
  cMin: number;
  cMax: number;
  observedCapacityMax: number;
};

export function maximumContextWitness() {
  return {
    operation: 'definitions.publish',
    client_id: '\u0000'.repeat(1024),
    requested_by: `urn:rezics:request:${'00000000-0000-0000-0000-000000000000'}:${'00000000-0000-0000-0000-000000000000'}`,
  };
}

export function heapFixture(shape: HeapShape) {
  // Keep the original full catalogue and its three added types. Do not fork the
  // prior release builder, validator, or checker to make heap evidence easier.
  const release = publicationFixture(shape.family === 'properties' ? shape.scale : 12);
  if (shape.family === 'properties') {
    for (const [key, property] of Object.entries(release.properties))
      if (key.startsWith('work:')) property.descriptions = { en: `${key}:`.padEnd(1024, 'x') };
  } else if (shape.family === 'strings') {
    // An independently growing, valid unbounded string; property count is fixed.
    release.generator.version = 'x'.repeat(shape.scale * 1024);
  } else if (shape.valid) {
    // Short unique CURIE scalar arrays, with no repeated bases/filter expansion.
    // Every populated array is sorted and unique, including on invalid variants.
    release.prefixes.h = 'https://example.org/heap/';
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const names = [...alphabet];
    for (const first of alphabet) for (const second of alphabet) names.push(first + second);
    const mappings = names
      .sort()
      .slice(0, shape.scale * 4)
      .map((name) => `h:${name}`);
    for (const [key, property] of Object.entries(release.properties))
      if (key.startsWith('work:')) property.mappings = [...mappings];
  } else {
    // One-digit numbers attain the JSON array scalar-node density limit: two
    // bytes/value asymptotically. enum has no uniqueItems: this cannot enter
    // TypeBox's known quadratic duplicate diagnostic. Semantic equality fails.
    release.properties['work:p0000']!.value = { enum: Array(shape.scale * 256).fill(0) };
  }
  if (!shape.valid && shape.family !== 'nodes') release.properties['work:p0000']!.labels.en = '';
  const wire = new TextEncoder().encode(JSON.stringify({ release }));
  if (wire.byteLength > DIAGNOSTIC_WIRE_CAP) throw new Error('Diagnostic fixture exceeds its safe wire cap');
  return { release, wire };
}

export function jsonNodeCount(value: unknown): number {
  const pending = [value];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    count++;
    if (current !== null && typeof current === 'object')
      for (const child of Object.values(current)) pending.push(child);
  }
  return count;
}

export function retainsCatalogue(release: ReturnType<typeof publicationFixture>): boolean {
  return (
    Object.keys(bundledRelease.properties).every((key) => key in release.properties) &&
    Object.keys(bundledRelease.types).every((key) => key in release.types)
  );
}
