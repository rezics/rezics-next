import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term) => ({
  path,
  hasValue,
  maxCount: 1,
  hasValueBeforeMaxCount: true,
});
const iri = (path: `rv:${string}` | `skos:${string}`) => ({
  path,
  minCount: 1,
  maxCount: 1,
  nodeKind: 'sh:IRI' as const,
});

/** A scheme and a Concept each keep their own head; an added Concept advances the scheme head. */
export const classificationPropositionV2Profile = {
  id: 'classification-proposition-v2',
  layout: 'compact',
  comments: [
    'A shared, revisioned ConceptScheme with one Concept per admitted proposition.',
    'Preferred labels are unique per language; hierarchy links stay within the scheme.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['skos', 'http://www.w3.org/2004/02/skos/core#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  binding: {
    required: ['scheme', 'concept', 'path', 'expression', 'sense'],
    roles: ['scheme', 'concept', 'path', 'expression', 'sense'],
    demandedBy: ['rv:VocabularyDefinition'],
  },
  shapes: [
    {
      iri: 'https://rezics.com/definition/classification-proposition-v2/scheme-shape',
      canonical: {
        types: ['skos:ConceptScheme'],
        when: [
          {
            path: 'rv:definitionProfile',
            value: '<https://rezics.com/definition/classification-proposition-v2>',
          },
        ],
      },
      properties: [
        { path: 'rdf:type', hasValue: 'skos:ConceptScheme' },
        fixed(
          'rv:definitionProfile',
          '<https://rezics.com/definition/classification-proposition-v2>',
        ),
        fixed('rv:schemeState', 'rv:Active'),
        iri('rv:schemeRevisionHead'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v2/concept-shape',
      canonical: {
        types: ['skos:Concept'],
        when: [
          {
            path: 'rv:definitionProfile',
            value: '<https://rezics.com/definition/classification-proposition-v2>',
          },
        ],
      },
      properties: [
        { path: 'rdf:type', hasValue: 'skos:Concept' },
        fixed(
          'rv:definitionProfile',
          '<https://rezics.com/definition/classification-proposition-v2>',
        ),
        iri('skos:inScheme'),
        {
          path: 'skos:prefLabel',
          minCount: 1,
          maxCount: 8,
          datatype: 'rdf:langString',
          uniqueLang: true,
        },
        { path: 'skos:altLabel', maxCount: 16, datatype: 'rdf:langString' },
        { path: 'skos:broader', maxCount: 8, nodeKind: 'sh:IRI' },
        { path: 'skos:narrower', maxCount: 8, nodeKind: 'sh:IRI' },
        fixed('rv:conceptState', 'rv:Active'),
        iri('rv:head'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v2/path-shape',
      canonical: {
        types: ['rv:ConceptPath'],
        when: [
          {
            path: 'rv:definitionProfile',
            value: '<https://rezics.com/definition/classification-proposition-v2>',
          },
        ],
      },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ConceptPath' },
        fixed(
          'rv:definitionProfile',
          '<https://rezics.com/definition/classification-proposition-v2>',
        ),
        fixed('rv:pathKind', 'rv:SingleConcept'),
        fixed('rv:pathLength', '1'),
        iri('rv:terminalConcept'),
        fixed('rv:pathState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v2/expression-shape',
      canonical: {
        types: ['rv:ClassificationExpression'],
        when: [
          {
            path: 'rv:definitionProfile',
            value: '<https://rezics.com/definition/classification-proposition-v2>',
          },
        ],
      },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationExpression' },
        fixed(
          'rv:definitionProfile',
          '<https://rezics.com/definition/classification-proposition-v2>',
        ),
        iri('rv:path'),
        fixed('rv:propositionKind', 'rv:ConceptAssertion'),
        iri('rv:assertedConcept'),
        fixed('rv:expressionState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v2/sense-shape',
      canonical: {
        types: ['rv:ClassificationSense'],
        when: [
          {
            path: 'rv:definitionProfile',
            value: '<https://rezics.com/definition/classification-proposition-v2>',
          },
        ],
      },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationSense' },
        fixed(
          'rv:definitionProfile',
          '<https://rezics.com/definition/classification-proposition-v2>',
        ),
        iri('rv:path'),
        iri('rv:expression'),
        fixed('rv:interpretationScope', '<urn:rezics:classification-context:global>'),
        fixed('rv:senseState', 'rv:Active'),
        iri('rv:head'),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
