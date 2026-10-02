import { Acquisition, MissingRemote, RemoteUnavailable } from './network.ts';
import { canonical } from './store.ts';
import type { DatasetEdge, DatasetRecord, DatasetSource } from './types.ts';

type Json = Record<string, unknown>;
export const MUSIC_SELECTION = [
  { title: 'The Wall', artist: 'Pink Floyd', id: 'f2026101-945b-3d05-9ef4-aa718fc3feef' },
  { title: 'The Beatles', artist: 'The Beatles', id: '055be730-dcad-31bf-b550-45ba9c202aa3' },
  {
    title: 'The Goldberg Variations',
    artist: 'Glenn Gould',
    id: '7c8f2d45-d764-347a-9ab9-0aa771a3447d',
  },
] as const;
const API = 'https://musicbrainz.org/ws/2/';
const key = (kind: string, id: string) => `musicbrainz:${kind}:${id}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed MusicBrainz object');
  return value as Json;
};
const list = (value: unknown): Json[] => {
  if (!Array.isArray(value)) throw new Error('Malformed MusicBrainz collection');
  return value.map(object);
};
function identity(row: Json): string {
  if (typeof row.id !== 'string' || !uuid.test(row.id))
    throw new Error('Malformed MusicBrainz MBID');
  return row.id;
}
function endpoint(kind: string, id?: string, params: Record<string, string> = {}): string {
  const url = new URL(`${kind}${id ? `/${id}` : ''}`, API);
  url.search = new URLSearchParams({ fmt: 'json', ...params }).toString();
  return url.toString();
}

/** Release browse pages may contain fewer than limit entries due to the 500-track
 * bound. Advance by returned entries, check the total and reject duplicate/gapped pages.
 * https://musicbrainz.org/doc/MusicBrainz_API#Paging */
export async function browseMusicBrainz(
  acquisition: Pick<Acquisition, 'json'>,
  kind: string,
  field: string,
  params: Record<string, string>,
): Promise<Json[]> {
  const rows: Json[] = [],
    seen = new Set<string>();
  let total: number | undefined;
  for (;;) {
    const page = object(
      await acquisition.json(
        endpoint(kind, undefined, { ...params, limit: '100', offset: String(rows.length) }),
      ),
    );
    const count = page[`${kind}-count`];
    if (!Number.isSafeInteger(count) || Number(count) < 0)
      throw new Error(`Missing ${kind} browse count`);
    if (total !== undefined && total !== count)
      throw new Error(`MusicBrainz ${kind} changed during pagination; refresh the capture`);
    total = Number(count);
    const next = list(page[field]);
    if (!next.length && rows.length < total) throw new Error(`Incomplete ${kind} pagination`);
    for (const row of next) {
      const id = identity(row);
      if (seen.has(id)) throw new Error(`Duplicate MusicBrainz ${kind} on paginated capture`);
      seen.add(id);
      rows.push(row);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || rows.length > 100_000)
      throw new Error(`Invalid or excessive ${kind} count`);
  }
}

function record(kind: string, data: Json, native?: DatasetRecord['native']): DatasetRecord {
  const id = identity(data);
  const title =
    typeof data.title === 'string'
      ? data.title
      : typeof data.name === 'string'
        ? data.name
        : `${kind} ${id}`;
  return {
    key: key(kind, id),
    provider: 'musicbrainz',
    kind,
    externalId: id,
    title,
    language:
      typeof objectOrNull(data['text-representation'])?.language === 'string'
        ? String(objectOrNull(data['text-representation'])?.language)
        : 'und',
    sourceUrl: `https://musicbrainz.org/${kind}/${id}`,
    data,
    native:
      native ??
      (['release-group', 'recording', 'work'].includes(kind)
        ? 'work'
        : kind === 'release'
          ? 'release'
          : kind === 'artist'
            ? data.type === 'Person'
              ? 'person'
              : 'organization'
            : 'source-only'),
    ...(['release-group', 'recording'].includes(kind)
      ? {
          semanticTypes: [
            kind === 'release-group'
              ? 'https://schema.org/MusicAlbum'
              : 'https://schema.org/MusicRecording',
          ],
        }
      : {}),
  };
}
const objectOrNull = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

export async function fetchMusicBrainz(acquisition: Acquisition): Promise<DatasetSource> {
  const records = new Map<string, DatasetRecord>(),
    edges: DatasetEdge[] = [];
  const roots: string[] = [];
  const selected: Json[] = [];
  // Pinned source IDs distinguish originals from same-title compilations/bootlegs.
  // This pins source selection only; REZICS IDs are allocated by existing APIs.
  for (const selection of MUSIC_SELECTION) {
    const group = object(
      await acquisition.json(
        endpoint('release-group', selection.id, {
          inc: 'artist-credits+aliases+annotation+tags+genres+artist-rels+work-rels+url-rels+release-group-rels',
        }),
      ),
    );
    if (
      identity(group) !== selection.id ||
      group.title !== selection.title ||
      !list(group['artist-credit']).some(
        (credit) => objectOrNull(credit.artist)?.name === selection.artist,
      )
    ) {
      throw new Error(`MusicBrainz elected root identity changed: ${selection.title}`);
    }
    selected.push(group);
    roots.push(key('release-group', identity(group)));
    records.set(key('release-group', identity(group)), record('release-group', group));
  }
  for (const group of selected) {
    const releases = await browseMusicBrainz(acquisition, 'release', 'releases', {
      'release-group': identity(group),
      inc: 'artist-credits+labels+recordings+release-groups+media+discids+isrcs+aliases+annotation+tags+genres+artist-rels+work-rels+recording-rels+url-rels+recording-level-rels+work-level-rels',
    });
    if (!releases.length) throw new Error(`Empty MusicBrainz release group: ${group.title}`);
    for (const release of releases) {
      const releaseKey = key('release', identity(release));
      records.set(releaseKey, record('release', release));
      edges.push({
        from: key('release-group', identity(group)),
        to: releaseKey,
        kind: 'release',
        data: {},
      });
      for (const medium of list(release.media ?? []))
        for (const track of list(medium.tracks ?? [])) {
          const recording = object(track.recording);
          const recordingKey = key('recording', identity(recording));
          if (!records.has(recordingKey)) records.set(recordingKey, record('recording', recording));
          // Track identity and order belong to this release/medium, not to a recording.
          edges.push({
            from: releaseKey,
            to: recordingKey,
            kind: 'track',
            data: { ...track, medium: { ...medium, tracks: undefined } },
          });
        }
    }
    console.log(`MusicBrainz ${String(group.title)}: ${releases.length} complete releases`);
  }

  // Expand elected recording credits/composition targets. Do not expand artists'
  // unrelated discographies or works' unrelated recordings into the selected albums.
  const related = new Map<string, { kind: string; id: string }>();
  function retainReferences(owner: DatasetRecord, value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => retainReferences(owner, item, `${path}/${index}`));
      return;
    }
    const obj = objectOrNull(value);
    if (!obj) return;
    for (const [field, nested] of Object.entries(obj)) {
      if (['artist', 'work', 'label', 'area', 'place', 'url'].includes(field)) {
        const ref = objectOrNull(nested);
        if (ref && typeof ref.id === 'string' && uuid.test(ref.id)) {
          const target = key(field, ref.id);
          if (!records.has(target)) records.set(target, record(field, ref, 'source-only'));
          if (['artist', 'work', 'label'].includes(field))
            related.set(target, { kind: field, id: ref.id });
          edges.push({
            from: owner.key,
            to: target,
            kind: `reference:${field}`,
            data: { path: `${path}/${field}` },
          });
        }
      }
      retainReferences(owner, nested, `${path}/${field}`);
    }
  }
  // Preserve the full recording lookup, not only the release browse's embedded summary.
  for (const recording of [...records.values()].filter((item) => item.kind === 'recording')) {
    const full = object(
      await acquisition.json(
        endpoint('recording', recording.externalId, {
          inc: 'artist-credits+isrcs+aliases+annotation+tags+genres+artist-rels+work-rels+url-rels',
        }),
      ),
    );
    records.set(recording.key, record('recording', full));
  }
  for (const item of [...records.values()]) retainReferences(item, item.data, '');
  for (const [target, ref] of related) {
    const inc =
      ref.kind === 'artist'
        ? 'aliases+annotation+tags+genres+artist-rels+url-rels'
        : ref.kind === 'work'
          ? 'aliases+annotation+tags+genres+artist-rels+work-rels+url-rels'
          : 'aliases+annotation+tags+genres+url-rels';
    const full = object(await acquisition.json(endpoint(ref.kind, ref.id, { inc })));
    records.set(target, record(ref.kind, full));
  }
  // Leaf refs retain their captured summaries and explicitly stop traversal here.
  for (const item of [...records.values()]) retainReferences(item, item.data, '');
  const images: DatasetSource['images'] = [];
  const unavailableArtwork: { record: string; url: string; status: number }[] = [];
  for (const release of [...records.values()].filter((item) => item.kind === 'release')) {
    if (objectOrNull(release.data['cover-art-archive'])?.artwork !== true) continue;
    try {
      const art = object(
        await acquisition.json(`https://coverartarchive.org/release/${release.externalId}`),
      );
      release.data['cover-art-archive-capture'] = art;
      for (const image of list(art.images ?? [])) {
        const thumbnails = objectOrNull(image.thumbnails);
        const url = thumbnails?.['500'] ?? image.image;
        if (typeof url === 'string')
          images.push({
            record: release.key,
            role: listTypes(image.types).join(',') || 'cover',
            url: url.replace(/^http:/, 'https:'),
          });
      }
    } catch (error) {
      if (error instanceof MissingRemote) {
        // Metadata may lag removal; retain the actual 404 instead of inventing an image.
        release.data['cover-art-archive-capture'] = { missing: true };
      } else if (error instanceof RemoteUnavailable) {
        // Artwork is independently hosted and optional. A failed art service is
        // not evidence that the complete MusicBrainz catalogue capture is empty.
        release.data['cover-art-archive-capture'] = { unavailable: true, status: error.status };
        unavailableArtwork.push({ record: release.key, url: error.url, status: error.status });
        images.push({
          record: release.key,
          role: 'cover',
          url: `https://coverartarchive.org/release/${release.externalId}/front-500`,
        });
      } else throw error;
    }
  }
  const uniqueEdges = new Map(edges.map((edge) => [canonical(edge), edge]));
  return {
    provider: 'musicbrainz',
    roots,
    records: [...records.values()],
    edges: [...uniqueEdges.values()],
    images,
    scope: {
      selection: MUSIC_SELECTION,
      consistency: 'cached API acquisition interval',
      releaseEnumeration: 'all releases of each elected release-group, count-checked pagination',
      recordingEnumeration: 'every track of every release; full recording lookup',
      relatedEnumeration:
        'full first-order artists, composers/works and labels; retained leaf references',
      excluded: [
        'unrelated artist discographies',
        'unrelated recordings of a composition',
        'user collections',
      ],
      missingCoverArt: [...records.values()]
        .filter((row) => objectOrNull(row.data['cover-art-archive-capture'])?.missing)
        .map((row) => row.key),
      unavailableArtwork,
    },
  };
}
function listTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error('Malformed cover art types');
  return value;
}
