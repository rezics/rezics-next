import type { ProfileDefinition } from '../compiler/ir.ts';

const definition = '<https://rezics.com/definition/realm-reply-placement-v1>' as const;
const oneIri = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1,
  nodeKind: 'sh:IRI' as const });
const oneString = (path: `rv:${string}`) => ({ path, minCount: 1, maxCount: 1,
  datatype: 'xsd:string' as const });

/** One immutable decision about one Content reply revision in one Realm.
 * A separate Realm/reply slot head selects the current decision. The reply's
 * author and original target are copied from its immutable Content identity;
 * neither another Realm's decision nor a later draft rewrites them. */
export const realmReplyPlacementProfile = {
  id: 'realm-reply-placement-v1',
  comments: [
    'Realm-local reply acceptance is revision-specific and independent between Realms.',
    'A rejected or revoked placement is retained as an attributable decision, not erased.',
  ],
  prefixes: [
    ['sh', 'http://www.w3.org/ns/shacl#'],
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['rv', 'https://rezics.com/vocab/'],
  ],
  layout: 'compact',
  shapes: [{
    iri: 'https://rezics.com/definition/realm-reply-placement-v1/slot-shape',
    canonical: { types: ['rv:RealmReplySlot'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:RealmReplySlot', maxCount: 1 },
      oneIri('rv:realm'), oneIri('rv:reply'), oneIri('rv:rootTarget'),
      oneIri('rv:replyPlacementHead'),
    ],
  }, {
    iri: 'https://rezics.com/definition/realm-reply-placement-v1/placement-shape',
    canonical: { types: ['rv:RealmReplyPlacement'] },
    properties: [
      { path: 'rdf:type', hasValue: 'rv:RealmReplyPlacement', maxCount: 1 },
      oneIri('rv:realm'),
      oneIri('rv:reply'),
      oneIri('rv:rootTarget'),
      oneString('rv:rootRevision'),
      oneIri('rv:author'),
      { path: 'rv:parentReply', maxCount: 1, nodeKind: 'sh:IRI' },
      { path: 'rv:parentRevision', maxCount: 1, datatype: 'xsd:string' },
      { path: 'rv:contextRevision', maxCount: 1, nodeKind: 'sh:IRI' },
      oneIri('rv:contentRevision'),
      { ...oneString('rv:contentDigest'), pattern: '^[0-9a-f]{64}$' },
      { ...oneString('rv:contentPreparation'),
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { ...oneString('rv:ownerDataEpoch'),
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:ownerSequence', minCount: 1, maxCount: 1,
        datatype: 'xsd:integer', minInclusive: 1 },
      oneIri('rv:reviewDecision'),
      { ...oneString('rv:reviewDigest'), pattern: '^[0-9a-f]{64}$' },
      { path: 'rv:placementOutcome', minCount: 1, maxCount: 1,
        in: ['rv:Accepted', 'rv:Rejected', 'rv:Revoked'] },
      { path: 'rv:previousPlacement', maxCount: 1, nodeKind: 'sh:IRI' },
      oneIri('rv:decidedBy'),
      { path: 'rv:modelRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:shapeRevision', hasValue: definition, maxCount: 1 },
      { path: 'rv:datasetId', hasValue: '<urn:rezics:dataset:product>', maxCount: 1 },
      { ...oneString('rv:dataEpoch'),
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
      { path: 'rv:sequence', minCount: 1, maxCount: 1,
        datatype: 'xsd:integer', minInclusive: 1 },
    ],
    or: [
      [{ path: 'rv:parentReply', maxCount: 0 }, { path: 'rv:parentRevision', maxCount: 0 }],
      [oneIri('rv:parentReply'), oneString('rv:parentRevision')],
    ],
  }],
  binding: {
    required: ['slot', 'placement', 'realm', 'reply', 'root', 'revision', 'review', 'author',
      'actor', 'receipt', 'scope', 'epoch'],
    roles: ['slot', 'placement'],
    demandedBy: ['rv:RealmReplyPlacement'],
  },
} as const satisfies ProfileDefinition;
