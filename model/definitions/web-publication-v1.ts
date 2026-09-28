import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = 'https://rezics.com/definition/web-publication-v1';

/** A web publication is a real release: its original URL, plus closed snapshots. */
export const webPublicationProfile = {
  id: 'web-publication-v1', layout: 'compact',
  comments: ['The release command validates this shape when the kind is web.',
    'Several stores would be several locations of one release; an unsanctioned repost is a different release.'],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['rv', 'https://rezics.com/vocab/']],
  shapes: [
    { iri: `${profile}/publication-shape`, properties: [
      { path: 'rdf:type', hasValue: 'rv:Release', maxCount: 1 },
      { path: 'rv:releaseKind', minCount: 1, maxCount: 1, hasValue: '"web"' },
      { path: 'rv:originalUrl', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 512 },
    ] },
  ],
} as const satisfies ProfileDefinition;
