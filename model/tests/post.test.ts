import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseTurtleProfile, profileSource } from '../compiler/shacl.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { postDeclaration } from '../definitions/post-v1.ts';

const postProfile = parseTurtleProfile('post-v1', readFileSync(
  new URL('../definitions/post-v1.ttl', import.meta.url), 'utf8'), postDeclaration);

test('Posts have a native publication shape without a Work or Main Version', () => {
  const shape = profileSource(postProfile);
  expect(shape).toContain('sh:hasValue rv:Post');
  expect(shape).toContain('sh:path rdfs:label ; sh:minCount 1');
  expect(shape).toContain('sh:uniqueLang true');
  for (const path of ['publisher', 'head']) expect(shape).toContain(`sh:path rv:${path} ; sh:minCount 1 ; sh:maxCount 1`);
  expect(shape).toContain('sh:path rv:mainVersion ; sh:maxCount 0');
  expect(shape).toContain('sh:path schema:isPartOf ; sh:maxCount 0');
  expect(shape).toContain('sh:path rv:spoiler ; sh:maxCount 1 ; sh:datatype');
  const registry = buildCommandRegistry([postProfile], { canonicalOrder: [], demandOrder: [] });
  expect(registry.canonical.find(route => route.type === 'https://rezics.com/vocab/Post')?.routes)
    .toEqual([{ profile: 'post-v1', shape: 'https://rezics.com/definition/post-v1/post-shape', when: [] }]);
});
