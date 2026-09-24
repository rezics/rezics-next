import type { ProfileDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term) => ({ path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true });
const requiredIri = (path: `rv:${string}` | `skos:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const classificationPropositionProfile = {
  id: 'classification-proposition-v1',
  comments: [
    'First immutable, shared classification proposition: one Concept path and one Sense.',
    'Later path profiles may add ordered typed relations without reinterpreting this path.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['skos', 'http://www.w3.org/2004/02/skos/core#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/classification-proposition-v1/scheme-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'skos:ConceptScheme' },
        fixed('rv:schemeState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v1/concept-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'skos:Concept' },
        requiredIri('skos:inScheme'),
        { path: 'skos:prefLabel', minCount: 1, maxCount: 1, datatype: 'rdf:langString',
          languageIn: ['en'], uniqueLang: true, lineBreaks: [{ after: 3, indent: 18 }] },
        fixed('rv:conceptState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v1/path-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ConceptPath' },
        fixed('rv:pathKind', 'rv:SingleConcept'),
        fixed('rv:pathLength', '1'),
        requiredIri('rv:terminalConcept'),
        fixed('rv:pathState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v1/expression-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationExpression' },
        requiredIri('rv:path'),
        fixed('rv:propositionKind', 'rv:ConceptAssertion'),
        requiredIri('rv:assertedConcept'),
        fixed('rv:expressionState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/classification-proposition-v1/sense-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ClassificationSense' },
        requiredIri('rv:path'),
        requiredIri('rv:expression'),
        { ...fixed('rv:interpretationScope', '<urn:rezics:classification-context:global>'),
          lineBreaks: [{ after: 1, indent: 18 }] },
        fixed('rv:senseState', 'rv:Active'),
      ],
    },
  ],
} as const satisfies ProfileDefinition;
