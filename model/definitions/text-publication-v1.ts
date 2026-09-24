import type { ProfileDefinition } from '../compiler/ir.ts';

export const textPublicationProfile = {
  id: 'text-publication-v1',
  comments: [
    'Fixed public eligibility decision for one exact native text draft.',
    'It does not select a Main Version or create a public search unit.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/text-publication-v1/decision-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:PublicationDecision' },
      { path: 'rv:contribution', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:work', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:author', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:selectedDraft', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:rightsBasis', hasValue: 'rv:OriginalContribution' },
      { path: 'rv:disclosure', hasValue: 'rv:Public' },
    ],
  }],
} as const satisfies ProfileDefinition;
