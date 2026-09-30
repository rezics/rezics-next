import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { workDerivationV2Profile } from '../definitions/work-derivation-v2.ts';
import { definitionKeyProfile } from '../definitions/definition-key-v1.ts';
import { semanticDefinitionProfile } from '../definitions/semantic-definition-v1.ts';

test('G-831: lexicon keys have a separate shape and leave accepted semantic definitions closed', () => {
  expect(renderProfile(semanticDefinitionProfile)).not.toContain('skos:notation');
  const key = definitionKeyProfile.shapes[0];
  expect(key.closed).toBe(true);
  expect(key.properties.find(property => property.path === 'skos:notation')).toMatchObject({
    minCount: 1, maxCount: 1, pattern: '^[a-z][a-z0-9-]{0,63}$' });
  expect(renderProfile(definitionKeyProfile)).toContain('rv:DefinitionKey');
});

test('G-831: v2 derivation SHACL binds an exact definition with an open kind vocabulary', () => {
  const shape = workDerivationV2Profile.shapes[0];
  expect(shape.properties.find(property => property.path === 'rv:derivationKind')).toEqual({
    path: 'rv:derivationKind', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:DefinitionRevision' });
  expect(renderProfile(workDerivationV2Profile)).not.toContain('rv:Rewrite');
  expect(renderProfile(workDerivationV2Profile)).not.toContain('rv:Adaptation');
  expect(shape.or[0].some(property => property.path === 'rv:sourceMainRevision' && property.minCount === 1)).toBe(true);
  expect(shape.or[1].some(property => property.path === 'rv:sourceMainRevision' && property.maxCount === 0)).toBe(true);
  expect(workDerivationV2Profile.binding.optional).toContain('source-revision');
});
