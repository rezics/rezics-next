import type { ProfileDefinition } from '../compiler/ir.ts';

/** A Work can carry several descriptive RDF types while retaining one Work
 * identity and one MainVersion. The command admits only its reviewed type set. */
export const workKindProfile = {
  id: 'work-kind-v1', layout: 'compact',
  comments: ['Native catalogue Work types share the metadata Work and MainVersion identity.',
    'Hub SkillPackage and PromptTemplate use the same RDF types as hub-item-v1.',
    'The owning command rejects unknown and duplicate types before graph mutation.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  shapes: [{ iri: 'https://rezics.com/definition/work-kind-v1/work-shape', properties: [
    { path: 'rdf:type', minCount: 1, maxCount: 4, hasValue: 'schema:CreativeWork',
      in: ['schema:CreativeWork', 'schema:Book', 'schema:BookSeries', 'schema:DigitalDocument',
        'schema:Recipe', 'schema:SoftwareApplication', 'schema:SoftwareSourceCode',
        'rv:ModPackage', 'rv:SkillPackage', 'rv:PromptTemplate', 'schema:Movie',
        'schema:TVSeries', 'schema:VideoObject', 'schema:AudioObject',
        'schema:MusicRecording', 'schema:MusicAlbum'] },
    { path: 'rv:mainVersion', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:MainVersion' },
  ] }],
} as const satisfies ProfileDefinition;
