import type { ProfileDefinition } from '../compiler/ir.ts';

/** New Work creation admits games while earlier work-kind-v1 shapes remain fixed. */
export const workKindV2Profile = {
  id: 'work-kind-v2', layout: 'compact',
  comments: ['Native catalogue Works retain one metadata Work and MainVersion identity.',
    'VideoGame joins the reviewed creation types in this revision.'],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  shapes: [{ iri: 'https://rezics.com/definition/work-kind-v2/work-shape', properties: [
    { path: 'rdf:type', minCount: 1, maxCount: 4, hasValue: 'schema:CreativeWork',
      in: ['schema:CreativeWork', 'schema:Book', 'schema:BookSeries', 'schema:DigitalDocument',
        'schema:Recipe', 'schema:SoftwareApplication', 'schema:SoftwareSourceCode', 'schema:VideoGame',
        'rv:ModPackage', 'rv:SkillPackage', 'rv:PromptTemplate', 'schema:Movie',
        'schema:TVSeries', 'schema:VideoObject', 'schema:AudioObject',
        'schema:MusicRecording', 'schema:MusicAlbum'] },
    { path: 'rv:mainVersion', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:MainVersion' },
  ] }],
} as const satisfies ProfileDefinition;
