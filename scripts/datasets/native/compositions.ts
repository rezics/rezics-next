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
      for (const list of ['tracks', 'data-tracks'] as const) {
        const tracks = medium?.[list];
        if (!Array.isArray(tracks)) continue;
        tracks.forEach((trackValue, trackIndex) => {
          const track = associationObject(trackValue),
            recording = associationObject(track?.recording);
          const recordingKey =
            typeof recording?.id === 'string' ? `musicbrainz:recording:${recording.id}` : null;
          const at = `${path}/${list}/${trackIndex}`;
          const recordingParticipant = recordingKey
            ? associationParticipant(context, 'recording', recordingKey)
            : null;
          candidates.push(
            associationCandidate(
              context,
              { record: record.key, kind: 'field', path: at },
              trackValue,
              {
                kind: list === 'data-tracks' ? 'musicbrainz-data-track' : 'musicbrainz-track',
                participants: [
                  associationParticipant(context, 'release', record.key),
                  ...(recordingParticipant ? [recordingParticipant] : []),
                ],
                native: {
                  owner: 'structure',
                  operation: '/v1/compositions',
                  grain: 'track-occurrence',
                  missing: [
                    'Structure profile/owner policy for release medium groups and track occurrences',
                    'source Structure conversion/adoption/support adapter; track ID/number/title/position qualifiers',
                    ...(!recordingParticipant?.target
                      ? [
                          `recording target unresolved: ${recordingKey ?? 'embedded recording ID absent'}; no native target is inferred or acquired`,
                        ]
                      : []),
                  ],
                },
              },
              {
                ...track,
                medium: { ...medium, tracks: undefined, 'data-tracks': undefined },
                parentCandidate: candidate.key,
              },
            ),
          );
          // The retained acquisition emits ordinary-track edges only. A data
          // track has its own frozen field pointer and cannot consume that edge.
          const matches =
            list === 'tracks'
              ? trackEdges.get(
                  canonical([
                    record.key,
                    recordingKey,
                    { ...track, medium: { ...medium, tracks: undefined } },
                  ]),
                )
              : undefined;
          const matched = matches?.shift();
          if (matched) consumedTracks.add(matched);
        });
      }
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
                    'episode-list-v1 native admission is available; exact Source binding/conversion/adoption/support receipts and source fractional sort/disc/qualified-type correspondence are required before mapping',
                    'source Structure conversion/adoption/support adapter; exact acknowledged TVEpisode resource target and Work/MainVersion owner heads',
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
