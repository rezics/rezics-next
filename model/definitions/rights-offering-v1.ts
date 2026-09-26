import type { ProfileDefinition } from '../compiler/ir.ts';

const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });
const optionalIri = (path: `rv:${string}`) => ({ path, maxCount: 1, nodeKind: 'sh:IRI' as const });
const receipt = [
  oneIri('rv:operation'),
  { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
  { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
  { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/rights-offering-v1>', maxCount: 1 },
] as const;

export const rightsOfferingProfile = {
  id: 'rights-offering-v1',
  comments: [
    'Rights declaration, license offering state and platform recognition as separate records.',
    'The slot holds at most one open offering per target/instrument key; an open offering',
    'revision has no predecessor, so ending is final and recognition cannot reopen it.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    {
      iri: 'https://rezics.com/definition/rights-offering-v1/declaration-shape',
      canonical: { types: ['rv:RightsDeclaration'] },
      properties: [
        { path: 'rdf:type', in: ['rv:RightsDeclaration', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        oneIri('rv:target'),
        oneIri('rv:declarationScope'),
        oneIri('rv:instrument'),
        { path: 'rv:grantorKnowledge', minCount: 1, maxCount: 1, in: ['rv:Known', 'rv:Unknown'] },
        optionalIri('rv:declaredBy'),
        { path: 'rv:declaredAt', maxCount: 1, datatype: 'xsd:dateTime' },
        oneIri('rv:provenance'),
        optionalIri('rv:authorityEvidence'),
        { path: 'rv:declarationOrigin', minCount: 1, maxCount: 1, in: ['rv:NativeDeclaration', 'rv:ImportedEvidence'] },
        ...receipt,
      ],
      or: [
        [{ path: 'rv:grantorKnowledge', hasValue: 'rv:Known' }, { path: 'rv:declaredBy', minCount: 1, nodeKind: 'sh:IRI' }],
        [{ path: 'rv:grantorKnowledge', hasValue: 'rv:Unknown' }, { path: 'rv:declaredBy', maxCount: 0, nodeKind: 'sh:IRI' }],
      ],
    },
    {
      iri: 'https://rezics.com/definition/rights-offering-v1/slot-shape',
      canonical: { types: ['rv:RightsOfferingSlot'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RightsOfferingSlot' },
        oneIri('rv:target'),
        oneIri('rv:instrument'),
        { path: 'rv:openOffering', maxCount: 1, class: 'rv:RightsOffering' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/rights-offering-v1/offering-shape',
      canonical: { types: ['rv:RightsOffering'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:RightsOffering' },
        { path: 'rv:slot', minCount: 1, maxCount: 1, class: 'rv:RightsOfferingSlot' },
        { path: 'rv:declaration', minCount: 1, maxCount: 1, class: 'rv:RightsDeclaration' },
        { path: 'rv:offeringHead', minCount: 1, maxCount: 1, class: 'rv:RightsOfferingRevision' },
        { path: 'rv:recognitionHead', maxCount: 1, class: 'rv:RightsRecognitionRevision' },
      ],
    },
    {
      iri: 'https://rezics.com/definition/rights-offering-v1/offering-revision-shape',
      canonical: { types: ['rv:RightsOfferingRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:RightsOfferingRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:offering', minCount: 1, maxCount: 1, class: 'rv:RightsOffering' },
        { path: 'rv:offeringState', minCount: 1, maxCount: 1, in: ['rv:Open', 'rv:Ended'] },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:RightsOfferingRevision' },
        oneIri('rv:changedBy'),
        ...receipt,
      ],
      or: [
        [{ path: 'rv:offeringState', hasValue: 'rv:Open' },
          { path: 'rv:predecessor', maxCount: 0, class: 'rv:RightsOfferingRevision' }],
        [{ path: 'rv:offeringState', hasValue: 'rv:Ended' },
          { path: 'rv:predecessor', minCount: 1, class: 'rv:RightsOfferingRevision' }],
      ],
    },
    {
      iri: 'https://rezics.com/definition/rights-offering-v1/recognition-revision-shape',
      canonical: { types: ['rv:RightsRecognitionRevision'] },
      properties: [
        { path: 'rdf:type', in: ['rv:RightsRecognitionRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:offering', minCount: 1, maxCount: 1, class: 'rv:RightsOffering' },
        { path: 'rv:recognitionState', minCount: 1, maxCount: 1, in: ['rv:Recognized', 'rv:Invalidated'] },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:RightsRecognitionRevision' },
        oneIri('rv:decidedBy'),
        { path: 'rv:reason', maxCount: 1, datatype: 'xsd:string', minLength: 1, maxLength: 4000 },
        ...receipt,
      ],
    },
  ],
} as const satisfies ProfileDefinition;
