import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { postProfile } from '../definitions/post-v1.ts';

test('Posts have a native publication shape without a Work or Main Version', () => {
  const shape = renderProfile(postProfile);
  expect(shape).toContain('sh:hasValue rv:Post');
  expect(shape).toContain('sh:path rdfs:label ; sh:minCount 1');
  expect(shape).toContain('sh:uniqueLang true');
  for (const path of ['publisher', 'head']) expect(shape).toContain(`sh:path rv:${path} ; sh:minCount 1 ; sh:maxCount 1`);
  expect(shape).toContain('sh:path rv:mainVersion ; sh:maxCount 0');
  expect(shape).toContain('sh:path schema:isPartOf ; sh:maxCount 0');
  const registry = buildCommandRegistry([postProfile], { established: {}, canonicalOrder: [], demandOrder: [] });
  expect(registry.canonical.find(route => route.type === 'https://rezics.com/vocab/Post')?.routes)
    .toEqual([{ profile: 'post-v1', shape: 'https://rezics.com/definition/post-v1/post-shape', when: [] }]);
});
