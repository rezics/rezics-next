import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Acquisition, RemoteUnavailable } from '../../../scripts/datasets/network.ts';
import { blobPath, canonical, repository, sha256 } from '../../../scripts/datasets/store.ts';
import {
  checkSources,
  freezeSnapshot,
  latestSnapshot,
  readSnapshot,
  verifySnapshot,
} from '../../../scripts/datasets/snapshot.ts';
import { browseMusicBrainz } from '../../../scripts/datasets/musicbrainz.ts';
import type { DatasetSource } from '../../../scripts/datasets/types.ts';
import { parseDatasetOptions } from '../../../scripts/datasets/cli.ts';

const source = (title = 'Fate/stay night'): DatasetSource => ({
  provider: 'vndb',
  roots: ['vndb:vn:v11'],
  records: [
    {
      key: 'vndb:vn:v11',
      provider: 'vndb',
      kind: 'vn',
      externalId: 'v11',
      title,
      language: 'ja',
      native: 'work',
      sourceUrl: 'https://vndb.org/v11',
      data: { titles: ['Fate/stay night', 'フェイト'], nullField: null },
    },
  ],
  edges: [],
  images: [],
  scope: { complete: true },
});
const coverRecordUrl = 'https://api.bgm.tv/v0/subjects/1';
const coverUrl = 'https://lain.bgm.tv/cover.png';
const coverSource = (recordDigest: string, sourceName = 'Bangumi'): DatasetSource => ({
  provider: 'bangumi',
  roots: ['bangumi:subject:1'],
  records: [
    {
      key: 'bangumi:subject:1',
      provider: 'bangumi',
      kind: 'subject',
      externalId: '1',
      title: 'Elected subject',
      language: 'ja',
      sourceUrl: 'https://bgm.tv/subject/1',
      data: { id: 1 },
      native: 'work',
    },
  ],
  edges: [],
  images: [
    {
      record: 'bangumi:subject:1',
      role: 'cover',
      url: coverUrl,
      sourceEvidence: {
        provider: 'bangumi',
        namespace: 'subject',
        externalId: '1',
        revision: null,
        captureUrl: coverRecordUrl,
        recordDigest,
        field: '/images/large',
        sourceName,
        sourceUrl: 'https://bgm.tv/subject/1',
        holder: null,
      },
    },
    { record: 'bangumi:subject:1', role: 'subject-poster', url: coverUrl },
  ],
  scope: { familySubjectIds: [1] },
});
const png = (marker: number) => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, marker]);
const temporary = () => {
  const parent = join(repository, '.temp/datasets');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'unit-'));
};

test('dataset: CLI rejects accidental network flags on replay and invalid/duplicate scopes', () => {
  expect(parseDatasetOptions(['fetch', '--source', 'vndb', '--images', 'all']).source).toBe('vndb');
  expect(() => parseDatasetOptions(['test', '--refresh'])).toThrow('does not apply');
  expect(() => parseDatasetOptions(['fetch', '--source', 'unknown'])).toThrow('Invalid');
  expect(() => parseDatasetOptions(['import', '--source', 'vndb', '--source', 'bangumi'])).toThrow(
    'Duplicate',
  );
  expect(() => parseDatasetOptions(['import', '--max-records', '0'])).toThrow('Invalid');
});

test('dataset: freezing preserves all values, detects drift and repoints an existing version', async () => {
  const root = temporary();
  try {
    const acquisition = new Acquisition(root, false, () => {
      throw new Error('Unexpected network');
    });
    const a = await freezeSnapshot(acquisition, [source()], 'none');
    const b = await freezeSnapshot(acquisition, [source('Fate/hollow ataraxia')], 'none');
    expect(a.id).not.toBe(b.id);
    const again = await freezeSnapshot(acquisition, [source()], 'none');
    expect(again.id).toBe(a.id);
    expect(latestSnapshot(root).id).toBe(a.id);
    expect(verifySnapshot(root, again).records).toBe(1);
    const path = join(root, 'snapshots', a.id, 'snapshot.json');
    const changed = JSON.parse(readFileSync(path, 'utf8'));
    changed.sources[0].records[0].title = 'changed';
    writeFileSync(path, JSON.stringify(changed));
    expect(() => readSnapshot(root, a.id)).toThrow('digest');
    expect(canonical({ b: null, a: [2, 1], unset: undefined })).toBe('{"a":[2,1],"b":null}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dataset: cover evidence and bytes change snapshot identity', async () => {
  const root = temporary();
  let imageBytes = png(1);
  const recordBody = JSON.stringify({ id: 1, images: { large: coverUrl } });
  const fetcher = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === coverRecordUrl)
      return new Response(recordBody, { headers: { 'content-type': 'application/json' } });
    if (url === coverUrl)
      return new Response(imageBytes, { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const acquisition = new Acquisition(root, false, fetcher, async () => {});
    const sourceCapture = await acquisition.capture(coverRecordUrl);
    const initial = coverSource(sourceCapture.digest);
    const snapshot = await freezeSnapshot(acquisition, [initial], 'covers');
    expect(snapshot.images).toHaveLength(1);
    expect(snapshot.images[0]).toMatchObject({ role: 'cover', captureRole: 'cover' });
    expect(verifySnapshot(root, snapshot).images).toBe(1);

    const changedEvidence = structuredClone(initial);
    changedEvidence.images[0]!.sourceEvidence!.sourceName = 'Bangumi public API';
    const evidenceSnapshot = await freezeSnapshot(acquisition, [changedEvidence], 'covers');
    expect(evidenceSnapshot.id).not.toBe(snapshot.id);

    const staleLocator = structuredClone(initial);
    staleLocator.images[0]!.sourceEvidence!.field = '/images/medium';
    await expect(freezeSnapshot(acquisition, [staleLocator], 'covers')).rejects.toThrow(
      'Cover field locator does not identify its image URL',
    );

    const all = await freezeSnapshot(acquisition, [initial], 'all');
    expect(all.images).toHaveLength(2);
    expect(all.images.find((image) => image.role === 'subject-poster')?.captureRole).toBe('other');

    imageBytes = png(2);
    const refreshed = new Acquisition(root, true, fetcher, async () => {});
    await refreshed.capture(coverRecordUrl);
    const bytesSnapshot = await freezeSnapshot(refreshed, [initial], 'covers');
    expect(bytesSnapshot.id).not.toBe(snapshot.id);
    expect(bytesSnapshot.images[0]?.capture?.digest).not.toBe(snapshot.images[0]?.capture?.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dataset: cover capture preserves missing unavailable corrupt oversized and unsupported outcomes', async () => {
  const parent = temporary();
  const recordBody = JSON.stringify({ id: 1, images: { large: coverUrl } });
  const noSleep = async () => {};
  const make = async (
    name: string,
    imageResponse: () => Response,
  ): Promise<{ root: string; acquisition: Acquisition; source: DatasetSource }> => {
    const root = join(parent, name);
    mkdirSync(root, { recursive: true });
    const acquisition = new Acquisition(
      root,
      false,
      async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url === coverRecordUrl
          ? new Response(recordBody, { headers: { 'content-type': 'application/json' } })
          : imageResponse();
      },
      noSleep,
    );
    const recordCapture = await acquisition.capture(coverRecordUrl);
    return { root, acquisition, source: coverSource(recordCapture.digest) };
  };
  try {
    const missing = await make('missing', () => new Response('', { status: 404 }));
    const missingSnapshot = await freezeSnapshot(missing.acquisition, [missing.source], 'covers');
    expect(missingSnapshot.images[0]).toMatchObject({
      capture: null,
      missing: true,
      captureRole: 'cover',
    });
    expect(missingSnapshot.images[0]?.unavailable).toBeUndefined();

    const unavailable = await make('unavailable', () => new Response('', { status: 503 }));
    const unavailableSnapshot = await freezeSnapshot(
      unavailable.acquisition,
      [unavailable.source],
      'covers',
    );
    expect(unavailableSnapshot.images[0]).toMatchObject({ capture: null, missing: false });
    expect(unavailableSnapshot.images[0]?.unavailable).toEqual({ status: 503 });

    let requests = 0;
    const corrupt = await make('corrupt', () => {
      requests++;
      return new Response(png(3), { headers: { 'content-type': 'image/png' } });
    });
    const cached = await corrupt.acquisition.capture(coverUrl);
    writeFileSync(blobPath(corrupt.root, cached.digest), 'corrupt bytes');
    const repaired = await freezeSnapshot(corrupt.acquisition, [corrupt.source], 'covers');
    expect(requests).toBe(2);
    expect(readFileSync(blobPath(corrupt.root, cached.digest))).toEqual(Buffer.from(png(3)));
    expect(repaired.images[0]).toMatchObject({
      capture: { digest: cached.digest },
      missing: false,
    });

    const oversized = await make(
      'oversized',
      () =>
        new Response(new Uint8Array(16 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    await expect(
      freezeSnapshot(oversized.acquisition, [oversized.source], 'covers'),
    ).rejects.toThrow('exceeded 16777216 bytes');

    const unsupported = await make(
      'unsupported',
      () => new Response('not a raster image', { headers: { 'content-type': 'image/png' } }),
    );
    await expect(
      freezeSnapshot(unsupported.acquisition, [unsupported.source], 'covers'),
    ).rejects.toThrow(`Invalid image response: ${coverUrl}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('dataset: no dangling root, edge or image can be published as a complete snapshot', () => {
  const s = source();
  s.edges.push({ from: s.roots[0]!, to: 'vndb:vn:v99', kind: 'sequel', data: {} });
  expect(() => checkSources([s])).toThrow('Dangling');
  s.edges = [];
  s.images.push({
    record: 'vndb:vn:v99',
    role: 'cover',
    url: 'https://images.example.test/cover.png',
  });
  expect(() => checkSources([s])).toThrow('Invalid dataset image');
  s.images = [];
  s.records.push(s.records[0]!);
  expect(() => checkSources([s])).toThrow('duplicate');
});

test('dataset: cached responses obey byte budgets, refetch corrupt bytes, and a restart reuses them', async () => {
  const root = temporary();
  let requests = 0;
  const body = '{"complete":true}';
  const fetcher = async () => {
    requests++;
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  };
  try {
    const acquisition = new Acquisition(root, false, fetcher);
    const url = 'https://example.test/catalogue';
    const first = await acquisition.capture(url);
    expect(first.digest).toBe(sha256(body));
    await acquisition.capture(url);
    expect(requests).toBe(1);
    await expect(acquisition.capture(url, { limit: 1 })).rejects.toThrow('cached');
    expect(requests).toBe(1);
    writeFileSync(blobPath(root, first.digest), 'corrupt');
    expect((await acquisition.capture(url)).digest).toBe(first.digest);
    expect(requests).toBe(2);
    expect(readFileSync(blobPath(root, first.digest)).toString()).toBe(body);
    await new Acquisition(root, false, fetcher).capture(url);
    expect(requests).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dataset: a 429 waits for Retry-After and stops within five attempts', async () => {
  const root = temporary();
  const sleeps: number[] = [];
  let requests = 0;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  try {
    await new Acquisition(
      root,
      false,
      async () => {
        requests++;
        return requests === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
          : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      },
      sleep,
    ).capture('https://example.test/limited');
    expect(requests).toBe(2);
    expect(sleeps).toEqual([2_000]);
    requests = 0;
    sleeps.length = 0;
    await new Acquisition(
      root,
      true,
      async () => {
        requests++;
        return requests === 1
          ? new Response('', { status: 429, headers: { 'retry-after': '1000' } })
          : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      },
      sleep,
    ).capture('https://example.test/capped');
    expect(sleeps).toEqual([120_000]);
    requests = 0;
    sleeps.length = 0;
    const exhausted = new Acquisition(
      root,
      false,
      async () => {
        requests++;
        return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      },
      sleep,
    );
    await expect(exhausted.capture('https://example.test/exhausted')).rejects.toBeInstanceOf(
      RemoteUnavailable,
    );
    expect(requests).toBe(5);
    expect(sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dataset: MusicBrainz paging advances by actual releases, detects truncation and source drift', async () => {
  const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const offsets: string[] = [];
  const records = await browseMusicBrainz(
    {
      async json(url) {
        const offset = new URL(url).searchParams.get('offset')!;
        offsets.push(offset);
        return {
          'release-count': 3,
          releases: offset === '0' ? [{ id: id(1) }, { id: id(2) }] : [{ id: id(3) }],
        };
      },
    },
    'release',
    'releases',
    {},
  );
  expect(records.length).toBe(3);
  expect(offsets).toEqual(['0', '2']);
  await expect(
    browseMusicBrainz(
      {
        async json() {
          return { 'release-count': 2, releases: [] };
        },
      },
      'release',
      'releases',
      {},
    ),
  ).rejects.toThrow('Incomplete');
  let calls = 0;
  await expect(
    browseMusicBrainz(
      {
        async json() {
          return { 'release-count': ++calls === 1 ? 2 : 3, releases: [{ id: id(calls) }] };
        },
      },
      'release',
      'releases',
      {},
    ),
  ).rejects.toThrow('changed');
});
