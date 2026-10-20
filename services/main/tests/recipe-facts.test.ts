import { expect, test } from 'bun:test';
import { Parser } from 'n3';
import { canonicalRecipeQualifier, hydrateRecipeFacts, projectRecipeFacts, projectRecipeMeasures, recipeNumberTerm } from '../src/modules/recipe/fact-projection.ts';
import { GRAPHS, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { PlacementState } from '../src/modules/structure/graph.ts';
import { InvalidStructureObject, type RecipeMeasure } from '../src/modules/structure/format.ts';

const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const state: PlacementState = { placement: id, occurrence: id, active: true, parent: id,
  role: 'ingredient', introducedBy: id, qualifier: {
    type: 'ingredient-line', originalText: { value: '1/3 cup chopped tomato', language: 'en' },
    name: 'tomato', amount: { numerator: 1, denominator: 3 }, amountUpper: { numerator: 2, denominator: 3 },
    unitText: 'cup', amountLexical: '1/3', textParts: { amount: { start: 0, end: 3 }, name: { start: 16, end: 22 } },
    preparation: { value: 'chopped', language: 'en' }, optional: true, scaling: 'linear', substituteFor: [id], parseStatus: 'partial' } };
const quads = (source: string) => new Parser().parse(`@prefix rv: <${RV}> . ${source}`);

test('standard ingredient facts round-trip exact ranges independently of parser evidence', async () => {
  const projection = projectRecipeFacts(state, id)!;
  const triples = quads(projection.triples.join('\n'));
  expect(triples.some(q => q.predicate.value === 'https://schema.org/recipeIngredient')).toBe(true);
  expect(triples.some(q => q.predicate.value === 'https://schema.org/requiredQuantity')).toBe(true);
  expect(triples.filter(q => q.object.value === '1/3')).toHaveLength(1);
  expect(triples.filter(q => q.object.value === '2/3')).toHaveLength(1);
  expect(triples.some(q => q.predicate.value === `${RV}amountNumerator`)).toBe(false);
  const evidence = JSON.parse(triples.find(q => q.predicate.value.endsWith('#value'))!.object.value);
  expect(Object.keys(evidence).sort()).toEqual(['amountLexical', 'parseStatus', 'textParts']);
  const env = { fuseki: { query: async () => ({ results: { bindings: triples.map(q => ({
    node: { value: q.subject.value }, p: { value: q.predicate.value },
    o: { value: q.object.value, ...(q.object.termType === 'Literal' && q.object.language ? { 'xml:lang': q.object.language } : {}) },
  })) } }) } } as unknown as WorkActivationEnvironment;
  expect(await hydrateRecipeFacts(env, { ...state, qualifier: undefined })).toEqual(state.qualifier);
  expect(projectRecipeFacts({ ...state, active: false }, id)!.triples.join('\n')).not.toContain('<https://schema.org/recipeIngredient>');
});

test('RDF comparison normalizes exact values and reference sets while retaining authored records', () => {
  expect(recipeNumberTerm({ numerator: 2, denominator: 6 })).toBe('"1/3"^^<http://www.w3.org/2002/07/owl#rational>');
  const line = state.qualifier;
  if (line?.type !== 'ingredient-line') throw new Error('fixture must be an ingredient');
  const source = { ...line, amount: { numerator: 2, denominator: 6 }, substituteFor: [id, id] };
  expect(canonicalRecipeQualifier(source)).toEqual({ ...line, substituteFor: [id] });
  expect(source.amount).toEqual({ numerator: 2, denominator: 6 });
});

test('exact revision measures use Recipe, Duration and nutrition terms with explicit coverage and basis', () => {
  const common = { value: { numerator: 1, denominator: 3 }, unitText: 'cup', basis: 'whole-recipe' as const,
    coverage: 'partial' as const, provenance: 'source-stated' as const, evidence: 'https://example.test/source' };
  const triples = quads(projectRecipeMeasures([
    { ...common, kind: 'yield' }, { ...common, kind: 'servings', unitText: 'servings' },
    { ...common, kind: 'preparation-duration', unitText: 'minutes' },
    { ...common, kind: 'cooking-duration', unitText: 'minutes' },
    { ...common, kind: 'total-duration', unitText: 'minutes' },
    { ...common, kind: 'nutrient', nutrient: 'https://example.test/energy' },
  ], id, id));
  const predicates = new Set(triples.map(q => q.predicate.value));
  for (const name of ['recipeYield', 'prepTime', 'cookTime', 'totalTime', 'nutrition', 'additionalProperty']) {
    expect(predicates.has(`https://schema.org/${name}`)).toBe(true);
  }
  expect(triples.filter(q => q.predicate.value === `${RV}coverage`)).toHaveLength(6);
  expect(triples.filter(q => q.predicate.value === `${RV}basis`)).toHaveLength(6);
  expect(triples.some(q => q.object.value === `${RV}RecipeMeasure`)).toBe(false);
  expect(GRAPHS.revisions).toBeDefined();
});

test('measure RDF preserves absolute reference identities and rejects terms that could escape an IRI', () => {
  const measure: RecipeMeasure = { kind: 'nutrient', value: { numerator: 1, denominator: 3 },
    nutrient: 'urn:recipe:nutrient/energy?panel=1#row', unit: 'qudt:KiloCAL', basis: 'per-serving',
    coverage: 'unknown', provenance: 'source-stated', evidence: 'doi:10.1000/182' };
  for (const evidence of ['doi:10.1000/182', 'mailto:author@example.test',
    'tag:example.test,2026:panel/é?part=2#row', 'https://example.test/panel%20one#row']) {
    const triples = quads(projectRecipeMeasures([{ ...measure, evidence }], id, id));
    for (const [predicate, value] of [['http://www.w3.org/ns/prov#wasDerivedFrom', evidence],
      ['https://schema.org/unitCode', measure.unit], ['https://schema.org/propertyID', measure.nutrient]]) {
      expect(triples.filter(q => q.predicate.value === predicate).map(q => ({ kind: q.object.termType, value: q.object.value })))
        .toEqual([{ kind: 'NamedNode', value }]);
    }
  }
  for (const evidence of ['relative', 'doi:10.1000/182>', 'doi:10.1000/"182',
    'doi:10.1000/\\u003e', 'doi:10.1000/\u0000', 'doi:10.1000/%ZZ', 'doi:10.1000/\ud800']) {
    expect(() => projectRecipeMeasures([{ ...measure, evidence }], id, id)).toThrow(InvalidStructureObject);
  }
});
