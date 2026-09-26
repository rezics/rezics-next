import type { ProfileDefinition } from '../compiler/ir.ts';

const profile = '<https://rezics.com/definition/semantic-model-generation-v1>';

export const semanticModelGenerationProfile = {
  id: 'semantic-model-generation-v1',
  comments: [
    'One immutable active model generation per dataset and its guarded control head.',
    'A generation pins the generated profile manifest, command module build, entailment and reject posture.',
    'Semantic commands guard the head; old revisions keep the exact generation they were validated under.',
  ],
  prefixes: [['sh', 'http://www.w3.org/ns/shacl#'], ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'], ['rv', 'https://rezics.com/vocab/']],
  layout: 'compact',
  shapes: [
    { iri: 'https://rezics.com/definition/semantic-model-generation-v1/generation-shape', properties: [
      { path: 'rdf:type', in: ['rv:ModelGeneration', 'rv:RevisionAnchor'], minCount: 2, maxCount: 2 },
      { path: 'rv:component', hasValue: '<urn:rezics:model:product>', maxCount: 1 },
      { path: 'rv:generationNumber', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
      { path: 'rv:predecessor', maxCount: 1, class: 'rv:ModelGeneration' },
      { path: 'rv:manifest', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:commandModuleVersion', minCount: 1, maxCount: 1, datatype: 'xsd:string', maxLength: 32 },
      { path: 'rv:entailmentProfile', minCount: 1, maxCount: 1, in: ['rv:NoEntailment'] },
      { path: 'rv:identityInference', hasValue: 'rv:Excluded', maxCount: 1 },
      { path: 'rv:validationPosture', hasValue: 'rv:RejectOnViolation', maxCount: 1 },
      { path: 'rv:operation', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:modelRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: profile, maxCount: 1 },
      { path: 'rv:datasetId', minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:dataEpoch', minCount: 1, maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1, datatype: 'xsd:integer', minInclusive: 1 },
    ] },
    { iri: 'https://rezics.com/definition/semantic-model-generation-v1/head-shape', properties: [
      { path: 'rdf:type', hasValue: 'rv:ModelComponent', maxCount: 1 },
      { path: 'rv:generationHead', minCount: 1, maxCount: 1, class: 'rv:ModelGeneration' },
    ] },
  ],
} as const satisfies ProfileDefinition;
