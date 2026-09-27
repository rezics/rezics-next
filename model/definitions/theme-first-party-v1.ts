import type { ProfileDefinition } from '../compiler/ir.ts';

const native = '^https://rezics\\.com/id/[0-9a-f-]{36}$';
const profile = 'https://rezics.com/definition/theme-first-party-v1';
const ref = (path: string) => ({ path, minCount: 1, maxCount: 1,
  nodeKind: 'sh:IRI' as const, pattern: native });

/** Each command validates the immutable record it inserts; TypeBox validates bundle JSON. */
export const themeFirstPartyProfile = {
  id: 'theme-first-party-v1',
  comments: ['A first-party theme is bound to one public Zone and has immutable revisions, reviews, activations and controls.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [
    { iri: `${profile}/theme-shape`, canonical: { types: ['rv:FirstPartyTheme'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyTheme' },
      ref('rv:themeOwner'), ref('rv:hostZone'),
      { path: 'rv:themeRevisionHead', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:themeActivationHead', maxCount: 1, nodeKind: 'sh:IRI' },
    ] },
    { iri: `${profile}/revision-shape`, canonical: { types: ['rv:FirstPartyThemeRevision'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeRevision' },
      ref('rv:component'), ref('rv:hostZone'), ref('rv:submittedBy'),
      { path: 'rv:submittedPrincipal', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', pattern: '^[0-9a-f-]{36}$' },
      { path: 'rv:dependencyDigest', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:bundle', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', maxLength: 32768 },
    ] },
    { iri: `${profile}/review-slot-shape`, canonical: { types: ['rv:FirstPartyThemeReviewSlot'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeReviewSlot' },
      { path: 'rv:reviewHead', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    ] },
    { iri: `${profile}/review-shape`, canonical: { types: ['rv:FirstPartyThemeReview'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeReview' },
      ref('rv:component'), ref('rv:revision'), ref('rv:reviewedBy'),
      { path: 'rv:reviewerPrincipal', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', pattern: '^[0-9a-f-]{36}$' },
      { path: 'rv:decision', minCount: 1, maxCount: 1,
        in: ['rv:Approved', 'rv:Rejected'] },
      { path: 'rv:reviewEvidenceDigest', minCount: 1, maxCount: 1,
        datatype: 'xsd:string', pattern: '^[0-9a-f]{64}$' },
    ] },
    { iri: `${profile}/activation-shape`, canonical: { types: ['rv:FirstPartyThemeActivation'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeActivation' },
      ref('rv:component'), ref('rv:revision'), ref('rv:review'), ref('rv:hostZone'),
      ref('rv:approvedBy'),
      { path: 'rv:controlBasis', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:approvalExpiresAt', minCount: 1, maxCount: 1,
        datatype: 'xsd:dateTime' },
    ] },
    { iri: `${profile}/revocation-slot-shape`, canonical: { types: ['rv:FirstPartyThemeRevocationSlot'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeRevocationSlot' },
      { path: 'rv:revocation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    ] },
    { iri: `${profile}/revocation-shape`, canonical: { types: ['rv:FirstPartyThemeRevocation'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeRevocation' },
      ref('rv:component'), ref('rv:activation'), ref('rv:revokedBy'),
    ] },
    { iri: `${profile}/control-head-shape`, canonical: { types: ['rv:FirstPartyThemeControlHead'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeControlHead' },
      { path: 'rv:controlHead', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
    ] },
    { iri: `${profile}/control-shape`, canonical: { types: ['rv:FirstPartyThemeControl'] }, properties: [
      { path: 'rdf:type', hasValue: 'rv:FirstPartyThemeControl' },
      ref('rv:changedBy'),
    ] },
  ],
} as const satisfies ProfileDefinition;
