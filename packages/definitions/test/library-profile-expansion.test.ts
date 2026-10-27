import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { verticalProfile } from '../../../services/kernel/test/support/manifests.ts';
import { bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { RELEASE_LIMITS, validateRelease } from '../src/index.ts';
import {
  compiledProfile,
  libraryProfile,
  profileOf,
  referenceOf,
  registryOf,
  sourcesFor,
  expansionProfile,
} from './support/library-profiles.ts';

test('library profile expansion fits release limits at ten and one hundred manifests', async () => {
  const bundled = await compileCatalogue(bundledSources());
  for (const count of [10, 100]) {
    const plain = await compileCatalogue(sourcesFor(count, false));
    const configured = await compileCatalogue(sourcesFor(count, true));
    expect(validateRelease(configured)).toEqual([]);
    expect(Object.keys(configured.types)).toHaveLength(Object.keys(bundled.types).length + count * 3);
    expect(Object.keys(configured.properties)).toHaveLength(Object.keys(bundled.properties).length + count * 12);
    expect(Object.keys(configured.types).length).toBeLessThanOrEqual(RELEASE_LIMITS.types);
    expect(Object.keys(configured.properties).length).toBeLessThanOrEqual(RELEASE_LIMITS.properties);
    expect(configured.properties).toEqual(plain.properties);
    expect(configured.contexts).toEqual(plain.contexts);
    expect(configured.filters).toEqual(plain.filters);
    const added = new Map<string, ReturnType<typeof libraryProfile>>();
    let referenceBytes = 0;
    for (let i = 0; i < count; i++) {
      const v = verticalProfile(i);
      const source = expansionProfile(i);
      added.set(source.id, compiledProfile(source));
      for (const type of [v.work, v.edition]) {
        expect(referenceOf(configured, type)).toEqual({ profileId: source.id });
        expect(profileOf(configured, type)).toEqual(compiledProfile(source));
        referenceBytes += Buffer.byteLength(',"library":') + Buffer.byteLength(canonicalize({ profileId: source.id })!);
      }
      expect(referenceOf(configured, v.agent)).toBeUndefined();
    }
    expect(added.size).toBe(1 + count / 2);
    expect(Object.keys(registryOf(configured)!)).toHaveLength(Object.keys(registryOf(plain)!).length + added.size);
    let registryBytes = 0;
    for (const [id, p] of added) {
      expect(registryOf(configured)![id]).toEqual(p);
      // Existing bundled registry is nonempty: charge a comma, one key, one colon, one object, once.
      registryBytes += Buffer.byteLength(`,${JSON.stringify(id)}:`) + Buffer.byteLength(canonicalize(p)!);
    }
    const bytes = Buffer.byteLength(canonicalize(configured)!);
    const baseline = Buffer.byteLength(canonicalize(plain)!);
    expect(bytes).toBeGreaterThan(baseline);
    expect(bytes).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
    expect(bytes - baseline).toBe(registryBytes + referenceBytes);
    // Deleting exactly the charged members recovers every other byte of the data-only baseline.
    const stripped = structuredClone(configured);
    for (const id of added.keys()) delete registryOf(stripped)![id];
    for (let i = 0; i < count; i++) {
      const v = verticalProfile(i);
      for (const type of [v.work, v.edition])
        delete (stripped.types[type] as unknown as Record<string, unknown>).library;
    }
    expect(stripped).toEqual(plain);
    for (const [key, definition] of Object.entries(bundled.types)) expect(configured.types[key]).toEqual(definition);
  }
}, 120_000);
