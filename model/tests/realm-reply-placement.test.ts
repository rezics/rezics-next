import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { buildArtifacts } from '../compiler/generate.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { realmReplyPlacementProfile } from '../definitions/realm-reply-placement-v1.ts';

test('SUB06: reply placement has one generated canonical route and bound exact references', () => {
  const artifacts = buildArtifacts(resolve(import.meta.dir, '../..'));
  const shape = artifacts.get('generated/model/shapes/realm-reply-placement-v1.ttl')!;
  for (const path of ['realm', 'reply', 'rootTarget', 'rootRevision', 'author',
    'contentRevision', 'contentDigest', 'contentPreparation', 'ownerDataEpoch',
    'ownerSequence', 'reviewDecision', 'reviewDigest', 'placementOutcome']) {
    expect(shape).toContain(`sh:path rv:${path} ; sh:minCount 1 ; sh:maxCount 1`);
  }
  expect(shape).toContain('sh:or (');
  expect(shape).toContain('rv:Rejected');
  expect(shape).toContain('rv:Revoked');
  expect(shape).toContain('rv:RealmReplySlot');
  const registry = buildCommandRegistry([realmReplyPlacementProfile],
    { established: {}, canonicalOrder: [], demandOrder: [] });
  expect(registry.canonical.find(entry => entry.type === 'https://rezics.com/vocab/RealmReplyPlacement')?.routes)
    .toEqual([{ profile: 'realm-reply-placement-v1',
      shape: 'https://rezics.com/definition/realm-reply-placement-v1/placement-shape', when: [] }]);
  expect(registry.bindings.get('realm-reply-placement-v1')?.required)
    .toContain('review');
  expect(registry.bindings.get('realm-reply-placement-v1')?.roles)
    .toEqual(['slot', 'placement']);
});
