import type { ProfileDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const realmPolicySelectionProfile = {
  id: 'realm-policy-selection-v1',
  comments: ['Exact automatic Realm adoption under an immutable unified policy revision.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/realm-policy-selection-v1/selection-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:PublicationSelection' },
      requiredIri('rv:context'),
      requiredIri('rv:slot'),
      requiredIri('rv:work'),
      requiredIri('rv:mainVersion'),
      requiredIri('rv:contribution'),
      requiredIri('rv:publicationDecision'),
      requiredIri('rv:selectedDraft'),
      { path: 'rv:mediaVariant', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:mediaPublicationDecision', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:mediaRevision', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:mediaDigest', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:selectionBasis', hasValue: 'rv:RealmPolicy' },
      { path: 'rv:selectionMode', hasValue: 'rv:Fixed' },
      requiredIri('rv:reviewPolicy'),
      requiredIri('rv:realmPolicyHead'),
    ],
  }],
} as const satisfies ProfileDefinition;
