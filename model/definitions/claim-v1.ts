import type { ProfileDefinition, PropertyDefinition, Term } from '../compiler/ir.ts';

const fixed = (path: `rv:${string}`, hasValue: Term) => ({ path, hasValue, maxCount: 1, hasValueBeforeMaxCount: true });
const requiredIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });

// The identity triple fixed at creation; each revision repeats it so an exact
// revision reads without the mutable current node. Equal text never merges claims.
const identity: readonly PropertyDefinition[] = [
  requiredIri('rv:referent'),
  requiredIri('rv:interpretationContext'),
  requiredIri('rv:propositionPredicate'),
];

export const claimProfile = {
  id: 'claim-v1',
  comments: [
    'An identified claim: one precise proposition about a referent in an interpretation context.',
    'Revisions are immutable; quality, review, dispute and adoption are separate records.',
    'The claim head moves by exact CAS. Evidence manifests are Content-owned (verification schema).',
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
      iri: 'https://rezics.com/definition/claim-v1/claim-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:Claim' },
        ...identity,
        { path: 'rv:claimHead', minCount: 1, maxCount: 1, class: 'rv:ClaimRevision' },
        fixed('rv:claimState', 'rv:Active'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/claim-v1/revision-shape',
      properties: [
        { path: 'rdf:type', in: ['rv:ClaimRevision', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
        { path: 'rv:component', minCount: 1, maxCount: 1, class: 'rv:Claim' },
        { path: 'rv:predecessor', maxCount: 1, class: 'rv:ClaimRevision' },
        ...identity,
        // A literal or an IRI; its meaning comes from the predicate definition.
        { path: 'rv:propositionValue', minCount: 1, maxCount: 1, nodeKind: 'sh:IRIOrLiteral' },
        { path: 'rv:valuePrecision', minCount: 1, maxCount: 1,
          in: ['rv:ExactValue', 'rv:ApproximateValue', 'rv:UncertainValue'] },
        { path: 'rv:valueQualifier', maxCount: 2, in: ['rv:DisputedAttribution', 'rv:InferredValue'] },
        { path: 'rv:validFrom', maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'rv:validUntil', maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'rv:editionScope', maxCount: 1, nodeKind: 'sh:IRI' },
        { path: 'rv:claimStatus', minCount: 1, maxCount: 1, in: ['rv:Asserted', 'rv:Withdrawn'] },
        // Present for AI/tool extraction: the Content-owned derivation activity.
        { path: 'rv:derivation', maxCount: 1, nodeKind: 'sh:IRI' },
        requiredIri('rv:statedBy'),
        { path: 'rv:recordedAt', minCount: 1, maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'rv:modelRevision', hasValue: '<https://rezics.com/definition/claim-v1>', maxCount: 1 },
        { path: 'rv:shapeRevision', hasValue: '<https://rezics.com/definition/claim-v1>', maxCount: 1 },
        { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
        { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
