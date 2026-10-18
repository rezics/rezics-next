import { canonical } from '../store.ts';
import type { DatasetMappingContext } from '../types.ts';
import {
  associationCandidate,
  associationObject,
  associationParticipant,
  disposeAssociation,
  type DatasetAssociationCandidate,
} from './classifications.ts';

/** Proposed uses of the existing Structure kernel. A medium, a track use, a
 * recording and a composition never share an identity, even for repeated tracks. */
export function datasetCompositionCandidates(
  context: DatasetMappingContext,
): DatasetAssociationCandidate[] {
  const candidates: DatasetAssociationCandidate[] = [];
  const consumedTracks = new Set<string>();
  const trackEdges = new Map<string, string[]>();
  context.snapshot.sources.forEach((source, sourceIndex) =>
    source.edges.forEach((edge, index) => {
      if (edge.kind !== 'track' || !context.selected.has(edge.from)) return;
      const key = canonical([edge.from, edge.to, edge.data]);
      const paths = trackEdges.get(key) ?? [];
      paths.push(`/sources/${sourceIndex}/edges/${index}`);
      trackEdges.set(key, paths);
    }),
  );
  for (const record of context.records.values()) {
    if (
      !context.selected.has(record.key) ||
      record.provider !== 'musicbrainz' ||
      record.kind !== 'release' ||
      !Object.hasOwn(record.data, 'media')
    )
      continue;
    const media = record.data.media;
    const values = Array.isArray(media) && media.length ? media : [media];
    values.forEach((value, mediumIndex) => {
      const medium = associationObject(value),
        path = `/data/media${Array.isArray(media) && media.length ? `/${mediumIndex}` : ''}`;
      const candidate = associationCandidate(
        context,
        { record: record.key, kind: 'field', path },
        value,
        {
          kind: 'musicbrainz-medium',
          participants: [associationParticipant(context, 'release', record.key)],
          native: {
            owner: 'structure',
            operation: '/v1/compositions',
            grain: 'medium-occurrence',
            missing: [
              'Structure profile/owner policy for release medium groups and track occurrences',
              'source Structure conversion/adoption/support adapter; medium position/format/count qualifiers',
            ],
          },
        },
      );
      candidates.push(candidate);
      if (!Array.isArray(medium?.tracks)) return;
      medium.tracks.forEach((trackValue, trackIndex) => {
        const track = associationObject(trackValue),
          recording = associationObject(track?.recording);
        const recordingKey =
          typeof recording?.id === 'string' ? `musicbrainz:recording:${recording.id}` : null;
        const at = `${path}/tracks/${trackIndex}`;
        candidates.push(
          associationCandidate(
            context,
            { record: record.key, kind: 'field', path: at },
            trackValue,
            {
              kind: 'musicbrainz-track',
              participants: [
                associationParticipant(context, 'release', record.key),
                ...(recordingKey
                  ? [associationParticipant(context, 'recording', recordingKey)]
                  : []),
              ],
              native: {
                owner: 'structure',
                operation: '/v1/compositions',
                grain: 'track-occurrence',
                missing: [
                  'Structure profile/owner policy for release medium groups and track occurrences',
                  'source Structure conversion/adoption/support adapter; track ID/number/title/position qualifiers',
                ],
              },
            },
            { ...track, medium: { ...medium, tracks: undefined }, parentCandidate: candidate.key },
          ),
        );
        const matches = trackEdges.get(
          canonical([
            record.key,
            recordingKey,
            { ...track, medium: { ...medium, tracks: undefined } },
          ]),
        );
        const matched = matches?.shift();
        if (matched) consumedTracks.add(matched);
      });
    });
  }
  context.snapshot.sources.forEach((source, sourceIndex) =>
    source.edges.forEach((edge, index) => {
      if (!context.selected.has(edge.from) || !['episode', 'track'].includes(edge.kind)) return;
      const path = `/sources/${sourceIndex}/edges/${index}`,
        episode = edge.kind === 'episode';
      candidates.push(
        associationCandidate(
          context,
          { record: edge.from, kind: 'edge', path },
          edge,
          {
            kind: episode ? 'bangumi-episode' : 'musicbrainz-track',
            participants: [
              associationParticipant(context, episode ? 'subject' : 'release', edge.from),
              associationParticipant(context, episode ? 'episode' : 'recording', edge.to),
            ],
            native: {
              owner: 'structure',
              operation: '/v1/compositions',
              grain: episode ? 'episode-occurrence' : 'track-occurrence',
              missing: episode
                ? [
                    'Structure profile/owner policy for Bangumi episode type/disc/fractional sort and episode targets',
                    'source Structure conversion/adoption/support adapter',
                  ]
                : [
                    consumedTracks.has(path)
                      ? 'same retained track use as the release media field; source support still required'
                      : 'exact release/medium/track occurrence correspondence required',
                    'Structure profile/owner policy and source Structure conversion/adoption/support adapter',
                  ],
            },
          },
          {
            ...edge.data,
            ...(episode ? { episode: context.records.get(edge.to)?.data ?? null } : {}),
          },
        ),
      );
    }),
  );
  return candidates;
}

export async function mapDatasetCompositions(context: DatasetMappingContext): Promise<void> {
  // A medium's retained value contains tracks. Dispose it once; track candidates
  // remain separately addressable without overwriting an acknowledged child later.
  for (const candidate of datasetCompositionCandidates(context))
    disposeAssociation(context, candidate);
}
