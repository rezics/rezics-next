import type { ProfileDefinition } from '../compiler/ir.ts';

const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

export const realmLocalRejectionProfile = {
  id: 'realm-local-rejection-v1',
  comments: ['Explicit negative publication decision for one Realm/Main Version slot.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/realm-local-rejection-v1/rejection-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:RealmPublicationRejection' },
      requiredIri('rv:context'),
      requiredIri('rv:slot'),
      requiredIri('rv:work'),
      requiredIri('rv:mainVersion'),
      { path: 'rv:decisionBasis', hasValue: 'rv:RealmManagerReview' },
      { path: 'rv:reasonCode', hasValue: 'rv:NotApproved' },
      { path: 'rv:selectionPolicy', hasValue: '<https://rezics.com/definition/realm-manager-fixed-main-fallback-v1>' },
      { path: 'rv:reviewPolicy', hasValue: '<https://rezics.com/definition/realm-manager-reviewed-v1>' },
      { path: 'rv:outcome', hasValue: 'rv:Rejected' },
    ],
  }],
} as const satisfies ProfileDefinition;
