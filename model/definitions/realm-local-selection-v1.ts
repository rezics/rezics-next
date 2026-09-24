import type { ProfileDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const realmLocalSelectionProfile = {
  id: 'realm-local-selection-v1',
  comments: ['Exact Realm adoption of one eligible public Contribution state for one Main Version.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/realm-local-selection-v1/selection-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:PublicationSelection' },
      requiredIri('rv:context'),
      requiredIri('rv:slot'),
      requiredIri('rv:work'),
      requiredIri('rv:mainVersion'),
      requiredIri('rv:contribution'),
      requiredIri('rv:publicationDecision'),
      requiredIri('rv:selectedDraft'),
      { path: 'rv:selectionBasis', hasValue: 'rv:RealmManagerReview' },
      { path: 'rv:selectionMode', hasValue: 'rv:Fixed' },
      { path: 'rv:reviewPolicy', hasValue: '<https://rezics.com/definition/realm-manager-reviewed-v1>' },
    ],
  }],
} as const satisfies ProfileDefinition;
