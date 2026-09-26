import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/hub-item-v1>' as const;

export const hubItemProfile = {
  id: 'hub-item-v1',
  comments: [
    'A Skill package or Prompt is a Work typed with exactly one Hub kind and a MainVersion.',
    'Exact revisions stay in Content; publication pins them through content-publication-v1.',
    'The kind never grants execution, tool access or network authority.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['schema', 'https://schema.org/'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: (['skill-package', 'prompt-template'] as const).map(role => ({
    iri: `https://rezics.com/definition/hub-item-v1/${role}-shape`,
    properties: [
      { path: 'rdf:type', minCount: 2, maxCount: 2,
        in: ['schema:CreativeWork', role === 'skill-package' ? 'rv:SkillPackage' : 'rv:PromptTemplate'] },
      { path: 'rv:mainVersion', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI', class: 'rv:MainVersion' },
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
    ],
  })),
} as const satisfies ProfileDefinition;
