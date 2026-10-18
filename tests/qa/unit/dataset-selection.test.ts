import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  selectDatasetRoots,
  type DatasetSelectionBudget,
  type DatasetSelectionResult,
} from '../../../scripts/datasets/selection.ts';
import type { Capture } from '../../../scripts/datasets/network.ts';
import type {
  DatasetEdge,
  DatasetImage,
  DatasetRecord,
  DatasetSnapshot,
  DatasetSource,
  StoredImage,
} from '../../../scripts/datasets/types.ts';

const budget: DatasetSelectionBudget = {
  maxInputItems: 200_000,
  maxRecords: 20_000,
  maxEdges: 100_000,
  maxImages: 30_000,
  maxJsonBytes: 64 * 1024 * 1024,
  maxMediaBytes: 64 * 1024 * 1024,
};
const capture = (url: string, digest = 'a'.repeat(64), bytes = 11): Capture => ({
  url,
  digest,
  bytes,
  mediaType: 'application/json',
  fetchedAt: '2026-10-02T14:31:36.684Z',
  etag: null,
  lastModified: null,
});
function record(
  key: string,
  native: DatasetRecord['native'],
  data: Record<string, unknown> = {},
): DatasetRecord {
  const [provider, kind, externalId] = key.split(':') as [
    DatasetRecord['provider'],
    string,
    string,
  ];
  return {
    key,
    provider,
    kind,
    externalId,
    title: key,
    language: 'ja',
    sourceUrl: `https://example.org/${externalId}`,
    native,
    data,
  };
}
const edge = (
  from: string,
  to: string,
  kind: string,
  data: Record<string, unknown> = {},
): DatasetEdge => ({ from, to, kind, data });
function snapshot(
  source: DatasetSource,
  images: StoredImage[] = [],
  captures: Capture[] = [],
): DatasetSnapshot {
  return {
    format: 'rezics-local-dataset-v1',
    id: 'dataset-frozen-parent',
    digest: 'f'.repeat(64),
    sources: [source],
    images,
    captures,
    createdAt: '2026-10-02T14:31:36.684Z',
  };
}
function selected(result: DatasetSelectionResult) {
  if (result.status === 'refused') throw new Error(JSON.stringify(result.manifest.limitations));
  return result.selection;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value)) freeze(nested);
}

// These small fixtures exercise captured row shapes; the opt-in tests below compare
// the exact retained complete parents, rather than treating these as real-data proof.
const vn = 'vndb:vn:v11',
  otherVn = 'vndb:vn:v7',
  character = 'vndb:character:c15';
function vndbFixture(): DatasetSnapshot {
  const image: DatasetImage = { record: vn, role: 'cover', url: 'https://t.vndb.org/cv/1/1.jpg' };
  return snapshot(
    {
      provider: 'vndb',
      roots: [vn, otherVn],
      records: [
        record('vndb:staff:s1', 'person'), // A global lexical/positional cap would choose this unrelated person.
        record(otherVn, 'work'),
        record(vn, 'work', {
          aliases: ['Fate/stay night', 'フェイト'],
          images: [image.url],
          tables: { vn_titles: [{ title: 'Fate/stay night' }] },
        }),
        record(character, 'character', {
          tables: { chars_vns: [{ id: 'c15', vid: 'v11', role: 'main', spoil: '0' }] },
        }),
        record('vndb:staff:s999', 'person', {
          tables: { staff_alias: [{ aid: '10262', name: '声優' }] },
        }),
        record('vndb:staff:s2', 'person'),
        record('vndb:trait:i999', 'concept'),
        record('vndb:trait:i1000', 'concept'),
        record('vndb:trait:i1001', 'concept'),
        record('vndb:tag:g9', 'concept'),
        record('vndb:tag:g10', 'concept'),
        record('vndb:release:r999', 'release'),
        record('vndb:producer:p99', 'organization'),
        record('vndb:image:cv1', 'source-only'),
      ].map((item) =>
        item.kind === 'image'
          ? {
              ...item,
              sourceUrl: image.url,
              data: { width: 320, height: 240, tables: { image_votes: [{ sexual: '0' }] } },
            }
          : item,
      ),
      edges: [
        edge(otherVn, 'vndb:staff:s1', 'credit:art', { aid: '1' }),
        edge(vn, otherVn, 'vn:preq', { official: 't' }),
        edge(character, vn, 'appearance', {
          id: 'c15',
          vid: 'v11',
          rid: 'r999',
          role: 'main',
          spoil: '0',
        }),
        edge(character, 'vndb:trait:i999', 'trait', { spoil: '2', lie: 'f' }),
        edge('vndb:trait:i999', 'vndb:trait:i1000', 'parent', { main: 't' }),
        edge('vndb:trait:i1000', 'vndb:trait:i1001', 'trait-group'),
        edge(vn, 'vndb:staff:s999', 'voice-actor', {
          id: 'v11',
          cid: 'c15',
          aid: '10262',
          note: 'Realta Nua',
        }),
        edge(character, 'vndb:staff:s999', 'voice-actor', {
          id: 'v11',
          cid: 'c15',
          aid: '10262',
          note: 'Realta Nua',
        }),
        edge(character, otherVn, 'appearance', {
          id: 'c15',
          vid: 'v7',
          role: 'primary',
          spoil: '2',
        }),
        edge(character, 'vndb:staff:s2', 'voice-actor', { id: 'v7', cid: 'c15', aid: '2' }),
        edge(vn, 'vndb:staff:s999', 'credit:scenario', { aid: '10262', note: 'first' }),
        edge(vn, 'vndb:staff:s999', 'credit:scenario', { aid: '10262', note: 'second' }),
        edge('vndb:release:r999', vn, 'release-of', { rtype: 'complete' }),
        edge('vndb:release:r999', otherVn, 'release-of', { rtype: 'partial' }),
        edge('vndb:release:r999', 'vndb:producer:p99', 'producer', {
          developer: 't',
          publisher: 'f',
        }),
        edge(vn, 'vndb:tag:g9', 'tag-vote', { uid: 'u1', vote: '3', spoiler: '0' }),
        edge(vn, 'vndb:tag:g9', 'tag-vote', { uid: 'u2', vote: '2', spoiler: '2' }),
        edge('vndb:tag:g9', 'vndb:tag:g10', 'parent', { main: 't' }),
      ],
      images: [
        image,
        { record: 'vndb:staff:s1', role: 'portrait', url: 'https://t.vndb.org/sf/2.jpg' },
      ],
      scope: {
        family: ['v11', 'v7'],
        completeness: 'pinned dump; elected owned tables',
        excluded: ['user posts'],
      },
    },
    [
      {
        ...image,
        capture: capture(image.url, 'b'.repeat(64)),
        captureRole: 'cover',
        missing: false,
      },
    ],
    [capture('https://dl.vndb.org/dump/vndb-db-latest.tar.zst')],
  );
}

test('root closure keeps cast, traits/ancestors, qualified voice occurrences, repeated credits, releases and actual media', () => {
  const parent = vndbFixture(),
    source = parent.sources[0]!;
  const before = JSON.stringify(parent);
  freeze(parent);
  const result = selectDatasetRoots(parent, { roots: [vn], budget });
  expect(result.status).toBe('complete');
  const view = selected(result),
    output = view.sources[0]!;
  expect(output.records.map((item) => item.key)).toEqual(
    source.records
      .filter((item) => !['vndb:staff:s1', 'vndb:staff:s2'].includes(item.key))
      .map((item) => item.key),
  );
  expect(output.edges).toEqual(source.edges.filter((_item, index) => ![0, 8, 9].includes(index)));
  expect(output.records.find((item) => item.key === vn)).toBe(source.records[2]);
  expect(output.images).toEqual([source.images[0]!]);
  expect(view.images[0]).toBe(parent.images[0]);
  expect(view.captures).toBe(parent.captures);
  expect(output.scope).toBe(source.scope);
  expect(result.manifest.parent).toEqual({ id: parent.id, digest: parent.digest });
  expect(result.manifest.sources[0]!.edges).toEqual(
    output.edges.map((item) => source.edges.indexOf(item)),
  );
  expect(result.manifest.references).toContain(otherVn);
  expect(result.manifest.excluded).toContainEqual({
    at: '/sources/0/edges/9',
    reason: 'other-work-context',
  });
  expect(result.manifest.coverage).toEqual({ knowledge: 'complete', media: 'complete' });
  expect(JSON.stringify(parent)).toBe(before);
  expect(selectDatasetRoots(parent, { roots: [vn], budget })).toEqual(result);
});

test('related Work expansion is explicit, depth bounded and independent of root closure order', () => {
  const parent = vndbFixture();
  // Repeated incident relations and a bundle link must not accidentally promote a reference.
  parent.sources[0]!.edges.push(edge(otherVn, vn, 'vn:seq'), edge(vn, otherVn, 'vn:preq'));
  const rootOnly = selected(selectDatasetRoots(parent, { roots: [vn], budget }));
  expect(rootOnly.sources[0]!.records.some((item) => item.key === 'vndb:staff:s1')).toBe(false);
  const expanded = selectDatasetRoots(parent, { roots: [vn], relatedWorkDepth: 1, budget });
  expect(selected(expanded).sources[0]!.records.some((item) => item.key === 'vndb:staff:s1')).toBe(
    true,
  );
  expect(expanded.manifest.expandedWorks).toContain(otherVn);
  expect(
    selected(selectDatasetRoots(parent, { roots: [vn, otherVn], budget })).sources[0]!.records,
  ).toEqual(selected(expanded).sources[0]!.records);
});

test('optional depth does not leak through repeated relations, bundles or zero-step required dependencies', () => {
  const parent = vndbFixture(),
    source = parent.sources[0]!;
  const third = 'vndb:vn:v3',
    credit = 'vndb:staff:s3';
  source.records.push(record(third, 'work'), record(credit, 'person'));
  source.edges.push(
    edge(otherVn, third, 'vn:seq'),
    edge(otherVn, third, 'vn:seq'),
    edge(third, credit, 'credit:music'),
    edge('vndb:release:r999', third, 'release-of'),
  );
  const once = selectDatasetRoots(parent, { roots: [vn], relatedWorkDepth: 1, budget });
  expect(once.manifest.references).toContain(third);
  expect(once.manifest.expandedWorks).toEqual([otherVn]);
  expect(selected(once).sources[0]!.records.some((item) => item.key === credit)).toBe(false);
  const twice = selectDatasetRoots(parent, { roots: [vn], relatedWorkDepth: 2, budget });
  expect(selected(twice).sources[0]!.records.some((item) => item.key === credit)).toBe(true);
});

test('requesting optional expansion beyond captured source-only endpoints reports the source frontier', () => {
  const parent = vndbFixture(),
    source = parent.sources[0]!;
  const adaptation = 'vndb:anime:a1';
  source.records.push(record(adaptation, 'source-only'));
  source.edges.push(edge(vn, adaptation, 'anime-adaptation'));
  const reference = selectDatasetRoots(parent, { roots: [vn], budget });
  expect(reference.manifest.coverage.knowledge).toBe('complete');
  expect(reference.manifest.references).toContain(adaptation);
  const expanded = selectDatasetRoots(parent, { roots: [vn], budget, relatedWorkDepth: 1 });
  expect(expanded.manifest.coverage.knowledge).toBe('incomplete');
  expect(expanded.manifest.limitations).toContainEqual(
    expect.objectContaining({
      code: 'source-frontier',
      at: `/sources/0/edges/${source.edges.length - 1}`,
    }),
  );
});

test('an unexpanded reference retains its real media and missing byte coverage', () => {
  const parent = vndbFixture(),
    source = parent.sources[0]!;
  source.images.push({ record: otherVn, role: 'cover', url: 'https://t.vndb.org/cv/2.jpg' });
  const result = selectDatasetRoots(parent, { roots: [vn], budget });
  expect(selected(result).sources[0]!.images).toEqual([source.images[0]!, source.images[2]!]);
  expect(result.manifest.coverage).toEqual({ knowledge: 'complete', media: 'incomplete' });
  expect(result.manifest.limitations).toContainEqual(
    expect.objectContaining({
      code: 'image-not-captured',
      at: '/sources/0/images/2',
    }),
  );
});

test('multiple providers and requested roots retain their own source and occurrence indexes', () => {
  const parent = vndbFixture();
  const musicRoot = 'musicbrainz:release-group:root';
  const music: DatasetSource = {
    provider: 'musicbrainz',
    roots: [musicRoot],
    records: [record(musicRoot, 'work')],
    edges: [],
    images: [],
    scope: { consistency: 'cached API interval' },
  };
  parent.sources.unshift(music);
  const result = selectDatasetRoots(parent, { roots: [vn, musicRoot], budget });
  expect(result.status).toBe('complete');
  expect(selected(result).sources.map((item) => item.provider)).toEqual(['musicbrainz', 'vndb']);
  expect(result.manifest.sources.map((item) => [item.source, item.provider])).toEqual([
    [0, 'musicbrainz'],
    [1, 'vndb'],
  ]);
  expect(result.manifest.sources[1]!.scope).toBe(parent.sources[1]!.scope);
});

test('Bangumi inverse voice rows retain the exact subject, participant correlation and episode ordering without a global cast cap', () => {
  const root = 'bangumi:subject:975',
    other = 'bangumi:subject:1867';
  const person = 'bangumi:person:4164',
    cast = 'bangumi:character:105258';
  const episodes = ['bangumi:episode:1807', 'bangumi:episode:1808'];
  const parent = snapshot({
    provider: 'bangumi',
    roots: [root, other],
    scope: { consistency: 'archive plus API interval' },
    records: [
      record(root, 'work'),
      record(other, 'work'),
      record(cast, 'character'),
      record(person, 'person'),
      ...episodes.map((key) => record(key, 'episode', { name: '海賊王におれはなる！' })),
      record('bangumi:person:1', 'person'),
    ],
    edges: [
      edge(root, cast, 'cast:2', { character_id: 105258, order: 0, subject_id: 975, type: 2 }),
      edge(person, cast, 'voice', {
        character_id: 105258,
        person_id: 4164,
        subject_id: 975,
        summary: '',
        type: 0,
      }),
      edge('bangumi:person:1', cast, 'voice', {
        character_id: 105258,
        person_id: 1,
        subject_id: 1867,
      }),
      edge(root, episodes[1]!, 'episode', { disc: 0, sort: 2, type: 0 }),
      edge(root, episodes[0]!, 'episode', { disc: 0, sort: 1, type: 0 }),
    ],
    images: [],
  });
  freeze(parent);
  const result = selectDatasetRoots(parent, { roots: [root], budget });
  expect(result.status).toBe('complete');
  const output = selected(result).sources[0]!;
  expect(output.edges).toEqual(parent.sources[0]!.edges.filter((_item, index) => index !== 2));
  expect(output.records.map((item) => item.key)).toEqual([root, cast, person, ...episodes]);
  expect(
    output.edges.filter((item) => item.kind === 'episode').map((item) => item.data.sort),
  ).toEqual([2, 1]);
});

test('MusicBrainz release/medium/track occurrences survive repeated recordings and do not expand another album or artist discography', () => {
  const root = 'musicbrainz:release-group:root',
    other = 'musicbrainz:release-group:other';
  const release = 'musicbrainz:release:release',
    recording = 'musicbrainz:recording:recording';
  const artist = 'musicbrainz:artist:artist',
    work = 'musicbrainz:work:work';
  const repeatedTrack = edge(release, recording, 'track', {
    id: 'track-1',
    position: 1,
    medium: { position: 1, format: 'CD' },
  });
  const parent = snapshot({
    provider: 'musicbrainz',
    roots: [root, other],
    scope: {
      releaseEnumeration: 'count-checked pagination',
      excluded: ['unrelated artist discographies'],
    },
    records: [
      record(other, 'work'),
      record(root, 'work'),
      record(release, 'release'),
      record(recording, 'work'),
      record(artist, 'person'),
      record(work, 'source-only'),
      record('musicbrainz:release:unrelated', 'release'),
    ],
    edges: [
      edge(root, release, 'release'),
      repeatedTrack,
      repeatedTrack,
      edge(release, recording, 'track', {
        id: 'track-2',
        position: 1,
        medium: { position: 2, format: 'CD' },
      }),
      edge(recording, artist, 'reference:artist', { path: '/artist-credit/0/artist' }),
      edge(recording, work, 'reference:work', { path: '/relations/2/work' }),
      edge('musicbrainz:release:unrelated', recording, 'track', { position: 3 }),
      edge(other, 'musicbrainz:release:unrelated', 'release'),
    ],
    images: [{ record: release, role: 'Front', url: 'https://coverartarchive.org/cover.jpg' }],
  });
  const result = selectDatasetRoots(parent, { roots: [root], budget });
  expect(result.status).toBe('incomplete'); // Descriptor retained; this parent has no captured bytes.
  const output = selected(result).sources[0]!;
  expect(output.edges).toEqual(parent.sources[0]!.edges.slice(0, 6));
  expect(output.edges[1]).toBe(output.edges[2]);
  expect(result.manifest.sources[0]!.edges).toEqual([0, 1, 2, 3, 4, 5]);
  expect(output.records.some((item) => item.externalId === 'unrelated')).toBe(false);
  expect(output.images).toEqual(parent.sources[0]!.images);
});

test('missing captures, acquisition failures and absent source evidence remain explicit without erasing image arrays', () => {
  const parent = vndbFixture(),
    source = parent.sources[0]!;
  source.images.push({
    ...source.images[0]!,
    role: 'screenshot',
    sourceEvidence: {
      provider: 'vndb',
      namespace: 'vn',
      externalId: 'v11',
      revision: null,
      captureUrl: 'https://example.org/absent.json',
      recordDigest: 'c'.repeat(64),
      field: '/image',
      sourceName: 'VNDB',
      sourceUrl: 'https://vndb.org/v11',
      holder: null,
    },
  });
  parent.images[0] = {
    ...parent.images[0]!,
    capture: null,
    missing: false,
    unavailable: { status: 503 },
  };
  const result = selectDatasetRoots(parent, { roots: [vn], budget });
  expect(result.status).toBe('incomplete');
  expect(selected(result).sources[0]!.images).toHaveLength(2);
  expect(selected(result).images).toEqual(parent.images);
  expect(result.manifest.coverage).toEqual({ knowledge: 'complete', media: 'incomplete' });
  expect(result.manifest.limitations.map((item) => item.code)).toEqual([
    'image-unavailable',
    'missing-evidence-capture',
    'image-not-captured',
  ]);
});

test('unknown outgoing and incoming relationships retain exact evidence and report unproved closure; missing targets and context are visible', () => {
  const parent = vndbFixture(),
    source = parent.sources[0]!;
  source.records.push(record('vndb:producer:p1', 'organization'));
  source.edges.push(
    edge(vn, 'vndb:producer:p1', 'unmapped-outgoing'),
    edge('vndb:producer:p1', vn, 'unmapped-incoming'),
    edge(vn, 'vndb:staff:absent', 'credit:staff'),
    edge(character, 'vndb:staff:s999', 'voice-actor'),
  );
  const result = selectDatasetRoots(parent, { roots: [vn], budget });
  expect(result.status).toBe('incomplete');
  expect(selected(result).sources[0]!.edges.slice(-4)).toEqual(source.edges.slice(-4));
  expect(new Set(result.manifest.limitations.map((item) => item.code))).toEqual(
    new Set(['unknown-relationship', 'missing-record', 'missing-context']),
  );
  expect(result.manifest.coverage.knowledge).toBe('incomplete');
});

test('a frontier Work cannot be reported as fully captured, even when its native mapping says Work', () => {
  const parent = vndbFixture();
  parent.sources[0]!.scope.referenceVns = ['v7'];
  const result = selectDatasetRoots(parent, { roots: [otherVn], budget });
  expect(result.status).toBe('incomplete');
  expect(result.manifest.limitations).toContainEqual(
    expect.objectContaining({ code: 'source-frontier', affects: 'knowledge' }),
  );
});

test('each preparation budget refuses atomically rather than taking the first or lexically smallest records', () => {
  const parent = vndbFixture();
  for (const name of Object.keys(budget) as (keyof DatasetSelectionBudget)[]) {
    const result = selectDatasetRoots(parent, { roots: [vn], budget: { ...budget, [name]: 0 } });
    expect(result.status).toBe('refused');
    expect(result.selection).toBeNull();
    expect(result.manifest.limitations).toContainEqual(
      expect.objectContaining({ code: 'budget-exceeded', budget: name, maximum: 0 }),
    );
  }
  const complete = selectDatasetRoots(parent, { roots: [vn], budget });
  const exact = {
    ...budget,
    maxInputItems: complete.manifest.inputItems,
    maxRecords: complete.manifest.selected.records,
    maxEdges: complete.manifest.selected.edges,
    maxImages: complete.manifest.selected.images + complete.manifest.selected.storedImages,
    maxJsonBytes: complete.manifest.selected.jsonBytes,
    maxMediaBytes: complete.manifest.selected.mediaBytes,
  };
  expect(selectDatasetRoots(parent, { roots: [vn], budget: exact }).status).toBe('complete');
});

test('frozen media byte accounting shares blobs without deduplicating media occurrences', () => {
  const parent = vndbFixture();
  parent.images.push(parent.images[0]!);
  const result = selectDatasetRoots(parent, { roots: [vn], budget });
  expect(result.manifest.selected.mediaBytes).toBe(parent.images[0]!.capture!.bytes);
  expect(selected(result).images).toHaveLength(2);
  expect(result.manifest.storedImages).toEqual([0, 1]);
});

test('invalid budgets, roots and duplicate identities cannot yield a partial success', () => {
  const parent = vndbFixture();
  for (const roots of [[], ['vndb:vn:absent'], [character], [vn, 'vndb:vn:absent']])
    expect(selectDatasetRoots(parent, { roots, budget }).status).toBe('refused');
  for (const value of [-1, NaN, Infinity, 1.5]) {
    expect(
      selectDatasetRoots(parent, { roots: [vn], budget: { ...budget, maxRecords: value } }).status,
    ).toBe('refused');
    expect(
      selectDatasetRoots(parent, { roots: [vn], budget, relatedWorkDepth: value }).status,
    ).toBe('refused');
  }
  parent.sources[0]!.records.push(parent.sources[0]!.records[0]!);
  expect(selectDatasetRoots(parent, { roots: [vn], budget }).status).toBe('refused');
});

const retained = [
  {
    id: 'dataset-904aa4496a525e699074',
    root: vn,
    fileHash: 'e32b3489a7a178fba54aa6d9dcbe93aeb57fb3f5ca0deecb2e0d035a2e31a5bd',
    digest: '904aa4496a525e699074365819fd4f5682755645980c3ef11c220b8df155a7de',
  },
  {
    id: 'dataset-424753e973cbd3609613',
    root: 'bangumi:subject:975',
    fileHash: '89ba2f7bb2b874ec77886bae97007d959c0e3409af1d8581fa7d05a7f9911625',
    digest: '424753e973cbd3609613c7ef373d214c9d1576bce1d05da4fe21b23826eef88d',
  },
];
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const fixture of retained) {
  test.skipIf(!process.env.REZICS_DATASET_ROOT)(
    `retained complete parent ${fixture.id}: source-faithful ${fixture.root} closure and frozen identity`,
    () => {
      const path = join(process.env.REZICS_DATASET_ROOT!, 'snapshots', fixture.id, 'snapshot.json');
      const bytes = readFileSync(path);
      expect(sha256(bytes)).toBe(fixture.fileHash);
      const parent = JSON.parse(bytes.toString('utf8')) as DatasetSnapshot;
      expect(parent.digest).toBe(fixture.digest);
      const original = sha256(JSON.stringify(parent));
      freeze(parent);
      const result = selectDatasetRoots(parent, { roots: [fixture.root], budget });
      const view = selected(result),
        source = parent.sources[0]!,
        output = view.sources[0]!;
      const keys = new Set(output.records.map((item) => item.key));
      const edgeIndexes = new Set(result.manifest.sources[0]!.edges);
      expect(result.manifest.coverage.knowledge).toBe('complete');
      expect(result.manifest.coverage.media).toBe('incomplete');
      expect(view.captures).toBe(parent.captures);
      expect(output.scope).toBe(source.scope);
      expect(output.images).toEqual(source.images.filter((image) => keys.has(image.record)));
      expect(view.images).toEqual(parent.images.filter((image) => keys.has(image.record)));
      for (const [index, record] of output.records.entries())
        expect(record).toBe(source.records[result.manifest.sources[0]!.records[index]!]);
      for (const [index, item] of output.edges.entries())
        expect(item).toBe(source.edges[result.manifest.sources[0]!.edges[index]!]);
      // Every direct root occurrence survives, regardless of the parent's lexical record order.
      for (const [index, item] of source.edges.entries())
        if (item.from === fixture.root || item.to === fixture.root)
          expect(edgeIndexes.has(index)).toBe(true);
      if (source.provider === 'vndb') {
        const cast = new Set(
          source.edges
            .filter((item) => item.kind === 'appearance' && item.to === fixture.root)
            .map((item) => item.from),
        );
        for (const [index, item] of source.edges.entries())
          if (
            (item.kind === 'trait' && cast.has(item.from)) ||
            (item.kind === 'voice-actor' && item.data.id === 'v11')
          )
            expect(edgeIndexes.has(index)).toBe(true);
        expect(output.records.some((item) => item.kind === 'image')).toBe(true);
        expect(output.records.filter((item) => item.native === 'work').length).toBeLessThan(
          source.records.filter((item) => item.native === 'work').length,
        );
      } else {
        const episodes = output.edges.filter((item) => item.kind === 'episode');
        expect(episodes.length).toBeGreaterThan(1000);
        expect(episodes).toEqual(
          source.edges.filter((item) => item.from === fixture.root && item.kind === 'episode'),
        );
        expect(output.edges.filter((item) => item.kind === 'voice')).toEqual(
          source.edges.filter((item) => item.kind === 'voice' && item.data.subject_id === 975),
        );
      }
      expect(sha256(JSON.stringify(parent))).toBe(original);
      expect(sha256(readFileSync(path))).toBe(fixture.fileHash);
    },
    20_000,
  );
}
