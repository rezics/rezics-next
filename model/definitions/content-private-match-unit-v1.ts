import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/content-private-match-unit-v1>' as const;
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const revision = '^urn:rezics:content:revision:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' as const });
const oneString = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1, datatype: 'xsd:string' as const });

export const contentPrivateMatchUnitProfile = {
  id: 'content-private-match-unit-v1',
  comments: [
    'A private Content draft has one exact revision-bound text unit in the private field.',
    'The Access read lease is checked before the private byte read and before delivery.',
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
      iri: 'https://rezics.com/definition/content-private-match-unit-v1/state-shape',
      canonical: { types: ['rv:ContentPrivateSearchState'] },
      properties: [
        { path: 'rdf:type', hasValue: 'rv:ContentPrivateSearchState', maxCount: 1 },
        oneIri('rv:resource'), oneIri('rv:variant'), oneIri('rv:privateSearchHead'),
      ],
    },
    {
      iri: 'https://rezics.com/definition/content-private-match-unit-v1/projection-shape',
      canonical: { types: ['rv:ContentPrivateProjection'] },
      properties: [
        { path: 'rdf:type', minCount: 2, maxCount: 2,
          in: ['rv:ContentPrivateProjection', 'rv:RevisionAnchor'] },
        oneIri('rv:component'), oneIri('rv:resource'), oneIri('rv:variant'),
        { ...oneIri('rv:contentRevision'), pattern: revision },
        oneIri('rv:matchUnit'),
        { ...oneString('rv:byteDigest'), pattern: '^[0-9a-f]{64}$' },
        { ...oneString('rv:ownerDataEpoch'), pattern: uuid },
        { ...oneString('rv:ownerSequence'), pattern: '^(0|[1-9][0-9]*)$' },
        { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      ],
    },
    {
      iri: 'https://rezics.com/definition/content-private-match-unit-v1/unit-shape',
      properties: [
        { path: 'rdf:type', hasValue: 'rv:MatchUnit', maxCount: 1 },
        oneIri('rv:resource'), oneIri('rv:variant'),
        { ...oneIri('rv:revision'), pattern: revision },
        oneIri('rv:projection'),
        { ...oneString('rv:language'), pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' },
        { path: 'rv:field', hasValue: 'rv:Body', maxCount: 1 },
        { path: 'rv:disclosure', hasValue: 'rv:Private', maxCount: 1 },
        { path: 'rv:privateSearchBody', minCount: 1, maxCount: 1,
          datatype: 'rdf:langString', minLength: 1, maxLength: 65_536 },
      ],
    },
  ],
} as const satisfies ProfileDefinition;
