import type { ProfileDefinition, PropertyDefinition } from '../compiler/ir.ts';

const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });
const count = (path: `rv:${string}`, minInclusive: number) => ({ path, minCount: 1, maxCount: 1,
  datatype: 'xsd:integer' as const, minInclusive, maxInclusive: 1_000_000_000_000 });
const scaling = { path: 'rv:scaling', minCount: 1, maxCount: 1,
  in: ['rv:LinearScaling', 'rv:NonLinearScaling', 'rv:NotScalable'] } as const;
const quantityKinds = ['rv:Yield', 'rv:Servings', 'rv:PreparationDuration', 'rv:CookingDuration',
  'rv:TotalDuration'] as const;
const noUpper: readonly PropertyDefinition[] = [
  { path: 'rv:amountUpperNumerator', maxCount: 0 },
  { path: 'rv:amountUpperDenominator', maxCount: 0 },
];

export const recipeStructureProfile = {
  id: 'recipe-structure-v1',
  comments: [
    'A Recipe variant is a Structure: stages and groups, ingredient lines, steps and equipment are occurrences.',
    'Quantities are exact non-negative rationals with their source lexical form; ambiguous units stay unresolved text.',
    'Measures state their unit, basis, coverage and provenance; per-serving and whole-recipe values differ.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/recipe-structure-v1/ingredient-line-shape',
      canonical: { types: ['rv:IngredientLine'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:IngredientLine', maxCount: 1 },
        { path: 'rv:originalText', minCount: 1, maxCount: 1, datatype: 'rdf:langString',
          minLength: 1, maxLength: 1000 },
        { path: 'rv:amountLexical', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 100 },
        { path: 'rv:amountNumerator', maxCount: 1, datatype: 'xsd:integer', minInclusive: 0 },
        { path: 'rv:amountDenominator', maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
        { path: 'rv:amountUpperNumerator', maxCount: 1, datatype: 'xsd:integer', minInclusive: 0 },
        { path: 'rv:amountUpperDenominator', maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
        { path: 'rv:unit', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:unitText', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 100 },
        { path: 'rv:preparation', maxCount: 1, datatype: 'rdf:langString', minLength: 1, maxLength: 500 },
        { path: 'rv:optionality', minCount: 1, maxCount: 1, in: ['rv:Required', 'rv:Optional'] },
        scaling,
        { path: 'rv:substituteFor', class: 'schema:ListItem' },
        { path: 'rv:parseStatus', minCount: 1, maxCount: 1,
          in: ['rv:Parsed', 'rv:PartiallyParsed', 'rv:Unparsed'] },
        { path: 'rv:residual', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
      or: [
        [
          count('rv:amountNumerator', 0),
          count('rv:amountDenominator', 1),
          ...noUpper,
        ],
        [
          count('rv:amountNumerator', 0),
          count('rv:amountDenominator', 1),
          count('rv:amountUpperNumerator', 0),
          count('rv:amountUpperDenominator', 1),
        ],
        [
          { path: 'rv:amountNumerator', maxCount: 0 },
          { path: 'rv:amountDenominator', maxCount: 0 },
          ...noUpper,
        ],
      ],
    },
    {
      iri: 'https://rezics.com/definition/recipe-structure-v1/step-shape',
      canonical: { types: ['rv:RecipeStep'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RecipeStep', maxCount: 1 },
        { path: 'rv:instructionText', minCount: 1, maxCount: 1, datatype: 'rdf:langString',
          minLength: 1, maxLength: 4000 },
        { path: 'rv:usesIngredient', class: 'schema:ListItem' },
        { path: 'rv:media', nodeKind: 'sh:IRI' },
        scaling,
      ],
    },
    {
      iri: 'https://rezics.com/definition/recipe-structure-v1/measure-shape',
      canonical: { types: ['rv:RecipeMeasure'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RecipeMeasure', maxCount: 1 },
        { path: 'rv:generation', minCount: 1, maxCount: 1, class: 'rv:StructureGeneration' },
        { path: 'rv:measureKind', minCount: 1, maxCount: 1, in: [...quantityKinds, 'rv:Nutrient'] },
        { path: 'rv:nutrient', maxCount: 1, nodeKind: 'sh:IRI' },
        count('rv:valueNumerator', 0),
        count('rv:valueDenominator', 1),
        { path: 'rv:valueLexical', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 100 },
        { path: 'rv:unit', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:unitText', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 100 },
        { path: 'rv:basis', minCount: 1, maxCount: 1, in: ['rv:PerServing', 'rv:WholeRecipe'] },
        { path: 'rv:coverage', minCount: 1, maxCount: 1, in: ['rv:Complete', 'rv:Partial', 'rv:Unknown'] },
        { path: 'rv:provenance', minCount: 1, maxCount: 1,
          in: ['rv:Declared', 'rv:SourceStated', 'rv:Computed'] },
        { path: 'rv:evidence', maxCount: 1, nodeKind: 'sh:IRI' },
      ],
      or: [
        [
          { path: 'rv:measureKind', hasValue: 'rv:Nutrient' },
          oneIri('rv:nutrient'),
          { path: 'rv:provenance', hasValue: 'rv:Computed' },
          oneIri('rv:evidence'),
        ],
        [
          { path: 'rv:measureKind', hasValue: 'rv:Nutrient' },
          oneIri('rv:nutrient'),
          { path: 'rv:provenance', minCount: 1, maxCount: 1, in: ['rv:Declared', 'rv:SourceStated'] },
        ],
        [
          { path: 'rv:measureKind', minCount: 1, maxCount: 1, in: quantityKinds },
          { path: 'rv:nutrient', maxCount: 0 },
          { path: 'rv:provenance', hasValue: 'rv:Computed' },
          oneIri('rv:evidence'),
        ],
        [
          { path: 'rv:measureKind', minCount: 1, maxCount: 1, in: quantityKinds },
          { path: 'rv:nutrient', maxCount: 0 },
          { path: 'rv:provenance', minCount: 1, maxCount: 1, in: ['rv:Declared', 'rv:SourceStated'] },
        ],
      ],
    },
  ],
} as const satisfies ProfileDefinition;
