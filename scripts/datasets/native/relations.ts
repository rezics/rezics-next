import type { DatasetMappingContext, DatasetNativeMapper } from '../types.ts';
import {
  associationCandidate,
  associationObject,
  associationParticipant,
  CLASSIFICATION_EDGE_KINDS,
  disposeAssociation,
  mapDatasetClassifications,
  type DatasetAssociationCandidate,
} from './classifications.ts';
import { mapDatasetCompositions } from './compositions.ts';

const delegatedEdge = (kind: string) =>
  kind.startsWith('credit:') ||
  kind.startsWith('staff:') ||
  ['voice', 'voice-actor', 'producer', 'release', 'release-of', 'supersedes'].includes(kind);

/** Direction/role/official codes remain source values until an exact native DefinitionRef
 * and source-support adapter admit them. In particular a protagonist code supplies no gender. */
export function datasetRelationCandidates(
  context: DatasetMappingContext,
): DatasetAssociationCandidate[] {
  const candidates: DatasetAssociationCandidate[] = [];
  context.snapshot.sources.forEach((source, sourceIndex) =>
    source.edges.forEach((edge, index) => {
      if (
        !context.selected.has(edge.from) ||
        CLASSIFICATION_EDGE_KINDS.has(edge.kind) ||
        delegatedEdge(edge.kind) ||
        ['track', 'episode'].includes(edge.kind)
      )
        return;
      candidates.push(
        associationCandidate(
          context,
          { record: edge.from, kind: 'edge', path: `/sources/${sourceIndex}/edges/${index}` },
          edge,
          {
            kind: edge.kind,
            participants: [
              associationParticipant(context, 'from', edge.from),
              associationParticipant(context, 'to', edge.to),
              ...(edge.kind === 'appearance' && typeof edge.data.rid === 'string'
                ? [associationParticipant(context, 'release', `vndb:release:${edge.data.rid}`)]
                : []),
            ],
            native: {
              owner: 'relation',
              operation: '/v1/relations/changes',
              grain: 'relation-occurrence',
              missing: edge.kind.startsWith('reference:')
                ? [
                    'reference frontier is not an independent relation; resolve its exact retained data.path',
                  ]
                : [
                    'exact relation DefinitionRef and declared roles for source kind/direction/official status',
                    'source relation conversion/adoption/support adapter',
                    'interpretation/revelation mapping for spoiler/lie/uncertain qualification and applicability',
                  ],
            },
          },
          edge.data,
        ),
      );
    }),
  );
  for (const record of context.records.values()) {
    if (!context.selected.has(record.key)) continue;
    const tables = associationObject(record.data.tables);
    if (record.provider === 'vndb' && tables)
      for (const name of ['vn_relations', 'chars_vns', 'producers_relations']) {
        if (!Object.hasOwn(tables, name)) continue;
        const rows = tables[name],
          values = Array.isArray(rows) && rows.length ? rows : [rows];
        values.forEach((value, index) => {
          const row = associationObject(value);
          const target = name === 'producers_relations' ? row?.pid : row?.vid;
          const targetKey =
            typeof target === 'string'
              ? `vndb:${name === 'producers_relations' ? 'producer' : 'vn'}:${target}`
              : null;
          candidates.push(
            associationCandidate(
              context,
              {
                record: record.key,
                kind: 'field',
                path: `/data/tables/${name}${Array.isArray(rows) && rows.length ? `/${index}` : ''}`,
              },
              value,
              {
                kind: name === 'chars_vns' ? 'appearance' : name,
                participants: [
                  associationParticipant(context, 'from', record.key),
                  ...(targetKey ? [associationParticipant(context, 'to', targetKey)] : []),
                  ...(typeof row?.rid === 'string'
                    ? [associationParticipant(context, 'release', `vndb:release:${row.rid}`)]
                    : []),
                ],
                native: {
                  owner: 'relation',
                  operation: '/v1/relations/changes',
                  grain: 'relation-occurrence',
                  missing: [
                    'exact relation DefinitionRef for source role/direction/official status',
                    'source relation conversion/adoption/support adapter; same-participant release/spoiler applicability',
                  ],
                },
              },
              row ?? { value },
            ),
          );
        });
      }
    if (record.provider !== 'musicbrainz' || !Object.hasOwn(record.data, 'relations')) continue;
    const relations = record.data.relations;
    const rows = Array.isArray(relations) && relations.length ? relations : [relations];
    rows.forEach((value, index) => {
      const row = associationObject(value),
        targetType = row?.['target-type'];
      const target = typeof targetType === 'string' ? associationObject(row?.[targetType]) : null;
      const targetKey =
        target && typeof target.id === 'string' ? `musicbrainz:${targetType}:${target.id}` : null;
      candidates.push(
        associationCandidate(
          context,
          {
            record: record.key,
            kind: 'field',
            path: `/data/relations${Array.isArray(relations) && relations.length ? `/${index}` : ''}`,
          },
          value,
          {
            kind:
              row?.type === 'performance' && targetType === 'work'
                ? 'recording-composition'
                : 'musicbrainz-relation',
            participants: [
              associationParticipant(context, 'from', record.key),
              ...(targetKey ? [associationParticipant(context, 'to', targetKey)] : []),
            ],
            native: {
              owner: 'relation',
              operation: '/v1/relations/changes',
              grain:
                record.kind === 'recording' && targetType === 'work'
                  ? 'recording-composition-relation'
                  : 'relation-occurrence',
              missing: [
                'exact relation DefinitionRef for MusicBrainz type-id, direction, attributes and dates',
                'source relation conversion/adoption/support adapter',
              ],
            },
          },
          row ?? { value },
        ),
      );
    });
  }
  return candidates;
}

/** The shared context has one relations mapper identity; the subordinate owners do
 * not need new importer IDs or a second source/occurrence store. */
export function datasetRelationMapper(): DatasetNativeMapper {
  return {
    id: 'relations',
    revision: 'source-associations-v1',
    async map(context) {
      for (const candidate of datasetRelationCandidates(context))
        disposeAssociation(context, candidate);
      await mapDatasetClassifications(context);
      await mapDatasetCompositions(context);
    },
  };
}
