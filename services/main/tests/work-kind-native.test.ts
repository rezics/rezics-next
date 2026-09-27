import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { metadataWorkRequestDigest, normalizeWorkSemanticTypes, WORK_SEMANTIC_TYPES }
  from '../src/modules/work/activate.ts';
import { interestKinds, interestSources, matchingWorkKinds, workKinds }
  from '../src/modules/work/work-kinds.ts';

test('G318: every native catalogue kind has a reviewed type, human interest and card intent', () => {
  expect([...WORK_SEMANTIC_TYPES] as string[]).toEqual(Object.keys(workKinds));
  expect(profileRegistry['work-kind-v1'].shapes).toHaveLength(1);
  const shape = readFileSync(resolve(import.meta.dir, '../../../generated/model/shapes/work-kind-v1.ttl'), 'utf8');
  expect(shape.match(/sh:in \( ([^)]+) \)/)?.[1]?.split(' ').filter(type => type !== 'schema:CreativeWork')
    .map(type => type.replace(/^schema:/, 'https://schema.org/')
      .replace(/^rv:/, 'https://rezics.com/vocab/')).sort()).toEqual([...WORK_SEMANTIC_TYPES].sort());
  for (const interest of interestKinds.filter(kind => kind !== 'discussions')) {
    const types = interestSources[interest].workTypes;
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(WORK_SEMANTIC_TYPES as string[]).toContain(type);
      expect(matchingWorkKinds([type], [])).toContain(interest);
    }
  }
  expect(workKinds['https://rezics.com/vocab/ModPackage']).toEqual({ interest: 'software', primaryAction: 'install' });
  expect(workKinds['https://rezics.com/vocab/SkillPackage']).toEqual({ interest: 'ai', primaryAction: 'install' });
  expect(workKinds['https://rezics.com/vocab/PromptTemplate']).toEqual({ interest: 'ai', primaryAction: 'copy' });
  expect(workKinds['https://schema.org/Movie']).toEqual({ interest: 'media', primaryAction: 'watch' });
  expect(matchingWorkKinds(['https://schema.org/DigitalDocument'], [])).toEqual([]);
});

test('G318: Work requests bind exact types while order is canonical and invalid types fail before admission', () => {
  const types = ['https://rezics.com/vocab/ModPackage', 'https://schema.org/SoftwareApplication'];
  expect(normalizeWorkSemanticTypes([...types].reverse())).toEqual([...types].sort());
  expect(metadataWorkRequestDigest('Mod page', types)).toBe(metadataWorkRequestDigest('Mod page', [...types].reverse()));
  expect(metadataWorkRequestDigest('Mod page', types)).not.toBe(metadataWorkRequestDigest('Mod page', [types[0]!]));
  expect(() => normalizeWorkSemanticTypes([...types, types[0]!])).toThrow();
  expect(() => normalizeWorkSemanticTypes(['https://rezics.com/vocab/AccessGrant'])).toThrow();
  expect(() => metadataWorkRequestDigest('Mixed', ['https://schema.org/Book', 'https://schema.org/Movie'])).toThrow();
  expect(() => metadataWorkRequestDigest('Mixed', ['https://rezics.com/vocab/SkillPackage',
    'https://rezics.com/vocab/PromptTemplate'])).toThrow();
  // Earlier graph revisions could already contain mixed types; reading them
  // must remain possible even though new creation no longer admits them.
  expect(normalizeWorkSemanticTypes(['https://schema.org/Book', 'https://schema.org/Movie']))
    .toEqual(['https://schema.org/Book', 'https://schema.org/Movie']);
});
