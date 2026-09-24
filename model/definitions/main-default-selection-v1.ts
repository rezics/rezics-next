import type { ProfileDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const mainDefaultSelectionProfile = {
  id: 'main-default-selection-v1',
  comments: ['Fixed global Main Version default selection of one eligible Contribution state.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/main-default-selection-v1/selection-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:PublicationSelection' },
      requiredIri('rv:context'),
      requiredIri('rv:work'),
      requiredIri('rv:mainVersion'),
      requiredIri('rv:contribution'),
      requiredIri('rv:publicationDecision'),
      requiredIri('rv:selectedDraft'),
      { path: 'rv:selectionBasis', hasValue: 'rv:MainMaintainer' },
      { path: 'rv:selectionMode', hasValue: 'rv:Fixed' },
    ],
  }],
} as const satisfies ProfileDefinition;
