import type { ProfileDefinition } from '../compiler/ir.ts';

/** The JSON layout is validated at the Zone configuration boundary. */
export const zonePresentationProfile = {
  id: 'zone-presentation-v2',
  comments: [
    'A Zone publication layout has bounded modules, sources, navigation, layered campaign slides and theme tokens.',
    'The immutable JSON document is stored with its Zone revision; this profile IRI marks a typed layout.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/zone-presentation-v2/zone-shape',
    properties: [
      { path: 'rdf:type', hasValue: 'rv:Zone', maxCount: 1 },
      { path: 'rv:presentation', hasValue: '<https://rezics.com/definition/zone-presentation-v2>',
        maxCount: 1 },
    ],
  }],
} as const satisfies ProfileDefinition;
