import { expect, test } from 'bun:test';
import { compositionChangeDigest } from '../src/modules/structure/change.ts';
import { checkExactInstructionSelection } from '../src/modules/structure/selection.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';

const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = '00000000-0000-4000-8000-000000000002';
const selector = { grain: 'content' as const, variantId: `urn:rezics:variant:${revision}`, revision };
const selection = { mode: 'fixed-revision' as const, revision, selector };

test('Recipe adopts exact Content and recording forms and retains selectors in retry identity', () => {
  const operation = { op: 'insert' as const, role: 'instruction', parent: structure,
    position: 'last' as const, target: structure, selection };
  const digest = compositionChangeDigest(structure, structure, [operation], 'recipe-composition');
  expect(compositionChangeDigest(structure, structure, [{ ...operation,
    selection: { ...selection, selector: { ...selector, block: 'procedure' } } }], 'recipe-composition')).not.toBe(digest);
  const media = { grain: 'representation' as const, revision, representation: revision };
  expect(() => compositionChangeDigest(structure, structure, [{ ...operation,
    target: `urn:rezics:media:asset:${revision}`, selection: { ...selection, selector: media } }], 'recipe-composition')).not.toThrow();
});

test('Recipe refuses moving, mismatched and text-plus-adoption instruction forms', () => {
  const profile = structureProfileFor('recipe-composition');
  expect(() => profile.checkOccurrence!({ role: 'instruction', target: structure,
    selection: { mode: 'follow-context' } })).toThrow();
  expect(() => checkExactInstructionSelection(structure, revision, { ...selector, revision: structure })).toThrow();
  expect(() => checkExactInstructionSelection(`urn:rezics:media:asset:${revision}`, revision, selector)).toThrow();
  expect(() => compositionChangeDigest(structure, structure, [{ op: 'insert', role: 'instruction',
    parent: structure, position: 'last', target: structure, selection: { mode: 'follow-context' } }], 'recipe-composition')).toThrow();
});

test('selection replacement participates in retry identity', () => {
  const operation = { op: 'update' as const, occurrence: structure, target: structure, selection };
  expect(compositionChangeDigest(structure, structure, [operation], 'recipe-composition')).not.toBe(
    compositionChangeDigest(structure, structure, [{ ...operation,
      selection: { ...selection, selector: { ...selector, block: 'procedure' } } }], 'recipe-composition'));
});

test('a step target replaces its legacy text only through an explicit qualifier clear', () => {
  const profile = structureProfileFor('recipe-composition');
  expect(() => profile.checkOccurrence!({ role: 'step', target: structure, selection })).not.toThrow();
  expect(() => profile.checkOccurrence!({ role: 'step', target: structure, selection,
    qualifier: { type: 'recipe-step', instructionText: { value: 'Old wording', language: 'en' },
      usesIngredient: [], media: [], scaling: 'linear' } })).toThrow();
  const operation = { op: 'update' as const, occurrence: structure, target: structure, selection };
  expect(compositionChangeDigest(structure, structure, [{ ...operation, qualifier: null }], 'recipe-composition'))
    .not.toBe(compositionChangeDigest(structure, structure, [operation], 'recipe-composition'));
  expect(() => checkExactInstructionSelection(`urn:rezics:media:asset:${revision}`, revision,
    { grain: 'representation', revision, representation: revision, fragment: 'arbitrary bytes' })).toThrow();
});
