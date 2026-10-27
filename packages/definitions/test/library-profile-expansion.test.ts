import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { verticalManifests, verticalProfile } from '../../../services/kernel/test/support/manifests.ts';
import { bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { RELEASE_LIMITS, validateRelease } from '../src/index.ts';
import { compiledProfile, libraryLabels, libraryProfile, LIBRARY_LOCALES, profileOf } from './library-profiles.test.ts';

// Reuse the existing launch-grain generator: 3 types, 12 properties and 8 presentation files per manifest.
function sourcesFor(count: number, profiles: boolean) {
  const bundled = bundledSources();
  const extra = verticalManifests(count);
  if (profiles) {
    for (let i = 0; i < count; i++) {
      const vertical = verticalProfile(i);
      const schema = Bun.YAML.parse(extra.schemas[vertical.schema]!) as {
        classes: Record<string, { annotations?: Record<string, unknown> }>;
      };
      const p = libraryProfile(`v${i}.reading`);
      // An abstract structural node with no CURIE exercises compile-time inheritance.
      schema.classes[`V${i}LibraryBase`] = { annotations: { library: p } };
      Object.assign(schema.classes[`V${i}LibraryBase`]!, { abstract: true, is_a: 'CreativeWork' });
      for (const suffix of ['Work', 'Edition'])
        Object.assign(schema.classes[`V${i}${suffix}`]!, { is_a: `V${i}LibraryBase` });
      (extra.schemas as Record<string, string>)[vertical.schema] = JSON.stringify(schema);
      for (const locale of LIBRARY_LOCALES) {
        const key = `${vertical.name}/${locale}`;
        const labels = Bun.YAML.parse(extra.presentation[key]!) as Record<string, unknown>;
        labels.libraryProfiles = { [p.id]: libraryLabels(p, locale) };
        (extra.presentation as Record<string, string>)[key] = JSON.stringify(labels);
      }
    }
  }
  return {
    ...bundled,
    schemas: {
      ...bundled.schemas,
      ...extra.schemas,
      'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${Array.from({ length: count }, (_, i) => `  - v${i}`).join('\n')}\n`,
    },
    presentation: { ...bundled.presentation, ...extra.presentation },
  };
}

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
    let profileBytes = 0;
    for (let i = 0; i < count; i++) {
      const v = verticalProfile(i);
      for (const type of [v.work, v.edition]) {
        const p = profileOf(configured, type);
        expect(p).toEqual(compiledProfile(libraryProfile(`v${i}.reading`)));
        const bytes = Buffer.byteLength(canonicalize(p)!);
        expect(bytes).toBeLessThanOrEqual(16 * 1024);
        profileBytes += bytes;
      }
      expect(profileOf(configured, v.agent)).toBeUndefined();
    }
    const bytes = Buffer.byteLength(canonicalize(configured)!);
    const baseline = Buffer.byteLength(canonicalize(plain)!);
    expect(bytes).toBeGreaterThan(baseline);
    expect(bytes).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
    // Every copied profile and the JSON member delimiters count toward the real canonical release.
    expect(bytes - baseline).toBe(profileBytes + count * 2 * Buffer.byteLength(',"library":'));
    expect(profileBytes).toBeLessThanOrEqual(count * 2 * 16 * 1024);
    for (const [key, definition] of Object.entries(bundled.types)) expect(configured.types[key]).toEqual(definition);
  }
}, 120_000);
