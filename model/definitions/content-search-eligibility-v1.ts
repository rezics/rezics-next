import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/content-search-eligibility-v1>' as const;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });
const oneString = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, datatype: 'xsd:string' as const });

export const contentSearchEligibilityProfile = {
  id: 'content-search-eligibility-v1',
  comments: [
    'Explicit public search release for one exact active Content publication.',
    'An admitted actor and original-contribution rights basis must be retained with the decision.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/content-search-eligibility-v1/decision-shape',
    properties: [
      { path: 'rdf:type', minCount: 2, maxCount: 2,
        in: ['rv:ContentSearchEligibilityDecision', 'rv:RevisionAnchor'] },
      oneIri('rv:component'),
      oneIri('rv:variant'),
      oneIri('rv:resource'),
      oneIri('rv:publicationDecision'),
      { path: 'rv:rightsBasis', hasValue: 'rv:OriginalContribution', maxCount: 1 },
      { path: 'rv:disclosure', hasValue: 'rv:Public', maxCount: 1 },
      { ...oneString('rv:admissionId'), pattern: uuid },
      { ...oneString('rv:authorityEpoch'), pattern: '^(0|[1-9][0-9]*)$' },
      { ...oneString('rv:admittedScope'), minLength: 1, maxLength: 1000 },
      oneIri('rv:actingSubject'),
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { ...oneString('rv:dataEpoch'), pattern: uuid },
      { path: 'rv:sequence', minCount: 1, maxCount: 1,
        datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }],
} as const satisfies ProfileDefinition;
