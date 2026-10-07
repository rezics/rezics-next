import { expect, test } from 'bun:test';
import { InvalidCompositionChange, checkedOperations, compositionChangeDigest,
  type CompositionOperation } from '../src/modules/structure/change.ts';
import { InvalidStructureObject, PROFILE_ROLES, checkOccurrenceRecord, checkIngredientReferences,
  type OccurrenceRecord, type OccurrenceRole, type StructureProfile } from '../src/modules/structure/format.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { derivedId } from '../src/modules/structure/graph.ts';

const structure = derivedId('recipe-update-structure');
const occurrence = derivedId('recipe-update-occurrence');
const ingredient = derivedId('recipe-update-ingredient');
const revision = derivedId('recipe-update-revision');
type Qualifier = NonNullable<OccurrenceRecord['qualifier']>;
const ingredientLine: Extract<Qualifier, { type: 'ingredient-line' }> = {
  type: 'ingredient-line', originalText: { value: '1–2 cups flour, sifted', language: 'en' },
  amountLexical: '1–2', amount: { numerator: 1, denominator: 1 },
  amountUpper: { numerator: 2, denominator: 1 }, unit: 'https://example.com/unit/cup',
  unitText: 'cups', preparation: { value: 'sifted', language: 'en' },
  optional: true, scaling: 'linear', substituteFor: [ingredient], parseStatus: 'partial',
  residual: `sha256:${'a'.repeat(64)}`,
};
const recipeStep: Extract<Qualifier, { type: 'recipe-step' }> = {
  type: 'recipe-step', instructionText: { value: 'Fold in the flour.', language: 'en' },
  usesIngredient: [ingredient], media: ['https://example.com/folding.webm'], scaling: 'non-linear',
};
const qualifierCases: readonly { profile: StructureProfile; role: OccurrenceRole; qualifier: Qualifier }[] = [
  { profile: 'work-composition', role: 'part',
    qualifier: { type: 'work-part', displayLabel: 'Part II', inclusion: 'optional' } },
  { profile: 'book-composition', role: 'group', qualifier: { type: 'book-group', division: 'extras' } },
  { profile: 'zone-navigation', role: 'mount', qualifier: { type: 'zone-mount', zone: ingredient,
    key: 'alias', routeSegment: 'recipes', disclosure: 'private', presentation: 'https://example.com/theme' } },
  { profile: 'recipe-composition', role: 'ingredient', qualifier: ingredientLine },
  { profile: 'recipe-composition', role: 'step', qualifier: recipeStep },
];

const record = (role: OccurrenceRole, qualifier: Qualifier): OccurrenceRecord => ({
  occurrence, state: 'active', parent: structure, segmentKey: 'i', orderKey: 'i', role,
  labels: [], introducedBy: revision, qualifier,
  ...(['chapter', 'part', 'member', 'mount', 'navigation'].includes(role) ? { target: ingredient } : {}),
  ...(role === 'chapter' ? { selection: { mode: 'follow-context' as const } } : {}),
});
const update = (qualifier: Qualifier): CompositionOperation => ({ op: 'update', occurrence, qualifier });

test('qualifier updates admit every existing qualifier kind without losing its complete value', () => {
  for (const entry of qualifierCases) {
    expect(checkedOperations([update(entry.qualifier)], entry.profile)).toEqual([update(entry.qualifier)]);
    expect(() => checkOccurrenceRecord(record(entry.role, entry.qualifier), entry.profile)).not.toThrow();
  }
  const operations = [update(ingredientLine), { ...update(recipeStep), occurrence: derivedId('recipe-update-step') }];
  expect(checkedOperations(operations, 'recipe-composition')).toEqual(operations);
});

test('qualifier request admission preserves the owning profile rather than accepting every union member', () => {
  for (const entry of qualifierCases) {
    for (const profile of Object.keys(PROFILE_ROLES) as StructureProfile[]) {
      if (profile === entry.profile) continue;
      // Authored formats can precede an owner registration (Wiki does not yet expose edits).
      try { structureProfileFor(profile); } catch { continue; }
      expect(() => checkedOperations([update(entry.qualifier)], profile)).toThrow(InvalidCompositionChange);
    }
  }
});

test('existing occurrence normalization rejects every mismatched qualifier role across all profiles', () => {
  for (const entry of qualifierCases) {
    for (const [profile, roles] of Object.entries(PROFILE_ROLES)) {
      for (const role of roles) {
        if (profile === entry.profile && role === entry.role) continue;
        expect(() => checkOccurrenceRecord(record(role, entry.qualifier), profile as StructureProfile))
          .toThrow(InvalidStructureObject);
      }
    }
  }
});

test('recipe quantity, unit, note, references and instruction changes each affect the change identity', () => {
  const digest = compositionChangeDigest(structure, revision, [update(ingredientLine)], 'recipe-composition');
  const alternatives: Qualifier[] = [
    { ...ingredientLine, amount: { numerator: 3, denominator: 2 } },
    { ...ingredientLine, unit: 'https://example.com/unit/gram' },
    { ...ingredientLine, preparation: { value: 'unsifted', language: 'en' } },
    { ...ingredientLine, substituteFor: [] },
    { ...ingredientLine, originalText: { value: '1 cup flour', language: 'en' } },
  ];
  for (const qualifier of alternatives) {
    expect(compositionChangeDigest(structure, revision, [update(qualifier)], 'recipe-composition')).not.toBe(digest);
  }
  const stepDigest = compositionChangeDigest(structure, revision, [update(recipeStep)], 'recipe-composition');
  for (const qualifier of [{ ...recipeStep, usesIngredient: [] }, { ...recipeStep,
    instructionText: { value: 'Whisk in the flour.', language: 'en' } }]) {
    expect(compositionChangeDigest(structure, revision, [update(qualifier)], 'recipe-composition')).not.toBe(stepDigest);
  }
});

test('update admission and occurrence normalization reject malformed qualifiers using their shared format', () => {
  const malformed: { profile: StructureProfile; role: OccurrenceRole; qualifier: unknown }[] = [
    { profile: 'work-composition', role: 'part', qualifier: { type: 'work-part', displayLabel: '', inclusion: 'required' } },
    { profile: 'book-composition', role: 'group', qualifier: { type: 'book-group', division: 'chapter' } },
    { profile: 'zone-navigation', role: 'mount', qualifier: { type: 'zone-mount', zone: ingredient,
      routeSegment: 'Bad Route', disclosure: 'public' } },
    { profile: 'recipe-composition', role: 'ingredient', qualifier: { ...ingredientLine,
      amount: { numerator: 1, denominator: 0 } } },
    { profile: 'recipe-composition', role: 'ingredient', qualifier: { ...ingredientLine,
      amount: { numerator: 1.5, denominator: 1 } } },
    { profile: 'recipe-composition', role: 'ingredient', qualifier: { ...ingredientLine,
      substituteFor: ['https://example.com/ingredient'] } },
    { profile: 'recipe-composition', role: 'ingredient', qualifier: { ...ingredientLine,
      substituteFor: Array.from({ length: 17 }, () => ingredient) } },
    { profile: 'recipe-composition', role: 'ingredient', qualifier: { ...ingredientLine,
      unexpected: 'silently dropped' } },
    { profile: 'recipe-composition', role: 'step', qualifier: { ...recipeStep,
      instructionText: { value: '', language: 'en' } } },
    { profile: 'recipe-composition', role: 'step', qualifier: { ...recipeStep,
      usesIngredient: ['https://example.com/ingredient'] } },
    { profile: 'recipe-composition', role: 'step', qualifier: { ...recipeStep,
      usesIngredient: Array.from({ length: 65 }, () => ingredient) } },
  ];
  for (const entry of malformed) {
    const qualifier = entry.qualifier as Qualifier;
    expect(() => checkedOperations([update(qualifier)], entry.profile)).toThrow(InvalidCompositionChange);
    expect(() => checkOccurrenceRecord(record(entry.role, qualifier), entry.profile)).toThrow(InvalidStructureObject);
  }
});

test('recipe updates preserve optional omissions and reject an empty change', () => {
  const qualifier: Qualifier = { type: 'ingredient-line',
    originalText: { value: 'Salt to taste', language: 'en' }, optional: false,
    scaling: 'not-scalable', substituteFor: [], parseStatus: 'unparsed' };
  expect(checkedOperations([update(qualifier)], 'recipe-composition')).toEqual([update(qualifier)]);
  expect(() => checkedOperations([{ op: 'update', occurrence }], 'recipe-composition'))
    .toThrow(InvalidCompositionChange);
});


test('same-batch forward inserts and matching-role updates resolve their ingredient IDs from the final overlay', () => {
  const line = { ...record('ingredient', ingredientLine), occurrence: ingredient,
    qualifier: { ...ingredientLine, substituteFor: [] } };
  const instruction = { ...record('step', recipeStep), occurrence };
  // Reference first, ingredient later: array order cannot change membership.
  expect(() => checkIngredientReferences([instruction, line], new Map())).not.toThrow();
  const stored = new Map([[ingredient, line]]);
  expect(() => checkIngredientReferences([instruction, { ...line,
    qualifier: { ...line.qualifier, amount: { numerator: 250, denominator: 1 } } }], stored)).not.toThrow();
});

test('candidate removals override retained membership, and references never accept missing or noningredient records', () => {
  const line = { ...record('ingredient', ingredientLine), occurrence: ingredient,
    qualifier: { ...ingredientLine, substituteFor: [] } };
  const instruction = { ...record('step', recipeStep), occurrence };
  expect(() => checkIngredientReferences([instruction], new Map())).toThrow(InvalidStructureObject);
  expect(() => checkIngredientReferences([instruction], new Map([[ingredient, {
    ...instruction, occurrence: ingredient }]]))).toThrow(InvalidStructureObject);
  expect(() => checkIngredientReferences([instruction, { ...line, state: 'removed' }],
    new Map([[ingredient, line]]))).toThrow(InvalidStructureObject);
  expect(() => checkIngredientReferences([{ ...instruction, state: 'removed' }, { ...line, state: 'removed' }],
    new Map([[ingredient, line]]))).not.toThrow();
  expect(() => checkIngredientReferences([{ ...line, qualifier: ingredientLine }],
    new Map([[ingredient, { ...line, state: 'removed' }]]))).not.toThrow();
});
