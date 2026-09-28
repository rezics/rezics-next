import type { ProfileDefinition } from '../compiler/ir.ts';

export const realmSubmissionSelectionProfile = {
  id: 'realm-submission-selection-v1',
  comments: ['A following whole-Work adoption or a fixed Content publication under one Realm review.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'], ['xsd', 'http://www.w3.org/2001/XMLSchema#']],
  layout: 'compact', shapes: [{
    iri: 'https://rezics.com/definition/realm-submission-selection-v1/selection-shape',
    canonical: { types: ['rv:RealmSubmissionSelection'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:RealmSubmissionSelection' },
      ...['rv:component', 'rv:context', 'rv:work', 'rv:mainVersion', 'rv:workRevision',
        'rv:recordedBy', 'rv:submittingAgent', 'rv:manifest'].map(path => ({ path,
        minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const })),
      { path: 'rv:selectionMode', minCount: 1, maxCount: 1, in: ['rv:Following', 'rv:Fixed'] },
      { path: 'rv:submissionKind', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:selectionBasis', minCount: 1, maxCount: 1, in: ['rv:RealmManagerReview', 'rv:RealmPolicy'] },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ],
  }, {
    iri: 'https://rezics.com/definition/realm-submission-selection-v1/slot-shape',
    canonical: { types: ['rv:RealmResourceSlot'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:RealmResourceSlot' },
      ...['rv:realm', 'rv:work', 'rv:mainVersion', 'rv:selectionHead'].map(path => ({ path,
        minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const })),
      { path: 'rv:submissionKind', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
    ],
  }],
} as const satisfies ProfileDefinition;
