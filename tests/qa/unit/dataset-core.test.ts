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

test('dataset: no dangling root, edge or image can be published as a complete snapshot', () => {
  const s = source();
  s.edges.push({ from: s.roots[0]!, to: 'vndb:vn:v99', kind: 'sequel', data: {} });
  expect(() => checkSources([s])).toThrow('Dangling');
  s.edges = [];
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
