import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  BANGUMI_IMAGE_FIELDS,
  BANGUMI_USER_POST_FIELDS,
  bangumiFamily,
  bangumiFieldDisposition,
  bangumiMappedData,
  bangumiSourceUrl,
  bangumiStatementEvidence,
  enrichBangumiSubjects,
  fetchBangumi,
  scanBangumiArchive,
  selectBangumiSubjects,
} from '../../../scripts/datasets/bangumi.ts';
import captured from '../../../services/main/tests/bangumi-captured-subjects.json';
import { MissingRemote, type Acquisition } from '../../../scripts/datasets/network.ts';
import { canonical, putBlob, repository, sha256 } from '../../../scripts/datasets/store.ts';
import type { DatasetSource } from '../../../scripts/datasets/types.ts';

test('Bangumi discovers every named family and spin-off from titles or aliases, not staff and synopsis mentions', () => {
  for (const name of [
    'ONE PIECE (110)',
    'ワンピース アンリミテッドワールド レッド',
    '航海王 特別篇',
    '海贼王',
  ]) {
    expect(bangumiFamily({ name })).toBe('one-piece');
  }
  for (const name of [
    'Re:ゼロから始める異世界生活 短編集 3',
    'Re：从零开始的异世界生活 第三季',
    'Re:Zero EX',
  ]) {
    expect(bangumiFamily({ name })).toBe('re-zero');
  }
  for (const name of [
    'とある魔術の禁書目録 (22)',
    'とある科学の超電磁砲 T',
    'とある科学の一方通行',
    'とある科学の未元物質',
    'とある科学の心理掌握',
    'とある暗部の少女共棲',
    '魔法禁书目录',
    '某科学的超电磁炮',
  ]) {
    expect(bangumiFamily({ name })).toBe('toaru');
  }
  expect(
    bangumiFamily({
      name: 'Anonymous soundtrack',
      infobox: '{{Infobox\n|别名={\n[ONE PIECE original soundtrack]\n}\n}}',
    }),
  ).toBe('one-piece');
  expect(
    bangumiFamily({
      name: 'Unrelated anime',
      summary: 'One Piece',
      infobox: '{{Infobox\n|原作= ONE PIECE\n}}',
    }),
  ).toBeUndefined();
});

test('Bangumi narrative closure retains untitled volumes; shared songs and crossover relations do not elect unrelated franchises', () => {
  const subjects = new Map([
    [1, { id: 1, type: 1 }],
    [2, { id: 2, type: 1 }],
    [3, { id: 3, type: 1 }],
    [4, { id: 4, type: 3 }],
    [5, { id: 5, type: 2, name: 'NARUTO' }],
    [6, { id: 6, type: 4, name: 'Jump Force' }],
    [7, { id: 7, type: 2 }],
  ]);
  const relation = (from: number, to: number, type: number) => ({
    subject_id: from,
    related_subject_id: to,
    relation_type: type,
    order: 5,
  });
  const relations = [
    relation(2, 1, 1003),
    relation(3, 2, 1003),
    relation(1, 4, 3003),
    relation(5, 4, 3003),
    relation(1, 6, 1),
    relation(6, 5, 1),
    relation(5, 7, 3),
  ];
  const elected = selectBangumiSubjects(subjects, relations, {
    'one-piece': [1],
    're-zero': [],
    toaru: [],
  });
  expect([...elected.narrative].sort()).toEqual([1, 2, 3]);
  expect([...elected.family].sort()).toEqual([1, 2, 3, 4]);
  expect([...elected.references].sort()).toEqual([5, 6]);
  expect(elected.relations).toEqual(relations.slice(0, 5));
  expect(elected.family.has(7)).toBe(false);
  expect(elected.family.has(6)).toBe(false);
});

test('Bangumi ZIP scanner preserves long UTF-8 raw infobox and final lines and rejects missing/truncated/malformed tables', async () => {
  const directory = join(repository, '.temp/datasets', `bangumi-unit-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  try {
    const path = join(directory, 'archive.zip');
    const first = {
      id: 1,
      name: '海賊王',
      infobox: '{{Infobox\n|別名= ' + '航海王'.repeat(100_000) + '\n}}',
      nested: { untouched: ['a', null, 0] },
    };
    const second = { id: 2, name: 'とある科学の一方通行' };
    writeFileSync(
      path,
      zipSync({
        'subject.jsonlines': strToU8(`${JSON.stringify(first)}\n${JSON.stringify(second)}`),
        'unused.jsonlines': strToU8('not-json\n'),
      }),
    );
    const read: unknown[] = [];
    await scanBangumiArchive(path, new Set(['subject']), (table, row) => {
      expect(table).toBe('subject');
      read.push(row);
    });
    expect(read).toEqual([first, second]);
    await expect(scanBangumiArchive(path, new Set(['episode']), () => {})).rejects.toThrow(
      'lacks table',
    );
    await expect(scanBangumiArchive(path, new Set(['unused']), () => {})).rejects.toThrow();
    writeFileSync(path, zipSync({ 'subject.jsonlines': strToU8('[1,2]\n') }));
    await expect(scanBangumiArchive(path, new Set(['subject']), () => {})).rejects.toThrow(
      'expected object',
    );
    const bytes = zipSync({ 'subject.jsonlines': strToU8(' {"id":1}\n'.repeat(1_000)) });
    writeFileSync(path, bytes.slice(0, 45));
    await expect(scanBangumiArchive(path, new Set(['subject']), () => {})).rejects.toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('Bangumi acquisition keeps episodes of all types, repeat staff jobs, voice context, tag counts and upstream malformed relation evidence', async () => {
  const root = join(repository, '.temp/datasets', `bangumi-acquisition-${crypto.randomUUID()}`);
  const rows: Record<string, unknown[]> = {
    subject: [
      {
        id: 1,
        type: 2,
        name: 'ONE PIECE',
        infobox: '{{raw wiki}}',
        tags: [{ name: '冒险', count: 100 }],
        meta_tags: ['漫画改'],
      },
      { id: 2, type: 1, name: 'Re:Zero', tags: [], meta_tags: [] },
      { id: 3, type: 4, name: 'とある魔術の禁書目録', tags: [], meta_tags: [] },
    ],
    person: [
      { id: 10, type: 1, name: 'Actor', infobox: '{{exact person}}' },
      { id: 11, type: 2, name: 'Studio' },
    ],
    character: [{ id: 20, role: 1, name: 'Hero', infobox: '{{exact character}}' }],
    episode: [
      { id: 30, subject_id: 1, name: 'Episode', sort: 1, type: 0 },
      { id: 31, subject_id: 1, name: 'Trailer', sort: 0, type: 4 },
    ],
    'subject-relations': [
      { subject_id: 1, related_subject_id: 99, relation_type: 99, order: 0 },
      { subject_id: 1, related_subject_id: 100, relation_type: 99, order: 1 },
    ],
    'subject-persons': [
      { subject_id: 1, person_id: 10, position: 1001, appear_eps: '1-2' },
      { subject_id: 1, person_id: 10, position: 1002 },
    ],
    'subject-characters': [{ subject_id: 1, character_id: 20, type: 1, order: 2 }],
    'person-characters': [
      { subject_id: 1, person_id: 10, character_id: 20, summary: 'cast context' },
    ],
    'person-relations': [
      { person_type: 'prsn', person_id: 10, related_person_id: 11, relation_type: 1001 },
      { person_type: 'prsn', person_id: 10, related_person_id: 0, relation_type: 1002 },
    ],
  };
  try {
    const zip = zipSync(
      Object.fromEntries(
        Object.entries(rows).map(([table, data]) => [
          `${table}.jsonlines`,
          strToU8(data.map((row) => JSON.stringify(row)).join('\n')),
        ]),
      ),
    );
    const digest = putBlob(root, zip);
    const capture = {
      digest,
      url: 'https://example.org/archive.zip',
      bytes: zip.length,
      mediaType: 'application/zip',
      fetchedAt: '2026-01-01T00:00:00Z',
      etag: null,
      lastModified: null,
    };
    const a = {
      root,
      json: async (url: string) => {
        if (url.endsWith('/subjects/99')) throw new MissingRemote(url);
        if (url.endsWith('/subjects/100')) return rows.subject![0];
        const subject = rows.subject!.find(
          (row) => (row as { id: number }).id === Number(url.split('/').at(-1)),
        );
        if (subject && url.includes('/subjects/')) return subject;
        return { browser_download_url: capture.url, digest: `sha256:${digest}` };
      },
      capture: async () => capture,
    } as unknown as Acquisition;
    const dataset = await fetchBangumi(a);
    const {
      api_subject: apiSubject,
      api_subject_acquisition: _acquisition,
      ...archive
    } = dataset.records.find((row) => row.key === 'bangumi:subject:1')!.data;
    expect(archive).toEqual(rows.subject![0]);
    expect(apiSubject).toEqual(rows.subject![0]);
    expect(
      dataset.records.filter((row) => row.kind === 'episode').map((row) => row.externalId),
    ).toEqual(['30', '31']);
    expect(dataset.edges.filter((edge) => edge.kind.startsWith('staff:')).length).toBe(2);
    expect(dataset.edges.find((edge) => edge.kind === 'voice')?.data).toEqual(
      rows['person-characters']![0],
    );
    expect(dataset.edges.find((edge) => edge.kind === 'tag')?.data.archive_tag).toEqual({
      name: '冒险',
      count: 100,
    });
    expect(dataset.scope.sourceAnomalies).toEqual([
      {
        table: 'person-relations',
        row: rows['person-relations']![1],
        reason: 'Upstream relationship has a zero or invalid endpoint.',
      },
    ]);
    expect(dataset.records.find((row) => row.key === 'bangumi:person:11')?.native).toBe(
      'source-only',
    );
    expect(dataset.images).toEqual([]);
    expect(dataset.records.find((row) => row.key === 'bangumi:character:20')?.sourceUrl).toBe(
      'https://bgm.tv/character/20',
    );
    expect(dataset.records.find((row) => row.key === 'bangumi:subject:99')?.data.unavailable).toBe(
      true,
    );
    expect(dataset.scope.unavailableEntities).toEqual([
      {
        key: 'bangumi:subject:99',
        url: 'https://api.bgm.tv/v0/subjects/99',
        reason:
          'Referenced by archive, absent from its entity table, and official API returned 404 (deleted or inaccessible).',
      },
    ]);
    expect(dataset.records.filter((row) => row.key === 'bangumi:subject:1').length).toBe(1);
    expect(dataset.records.find((row) => row.key === 'bangumi:subject:100')?.data.redirectTo).toBe(
      'bangumi:subject:1',
    );
    expect(dataset.scope.redirects).toEqual([
      {
        from: 'bangumi:subject:100',
        to: 'bangumi:subject:1',
        url: 'https://api.bgm.tv/v0/subjects/100',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bangumi enrichment keeps licensed archive and API fields, unions tag counts, and omits images and user posts', async () => {
  const oldTagKey = `bangumi:tag:${sha256('Old')}`;
  const source: DatasetSource = {
    provider: 'bangumi',
    roots: ['bangumi:subject:1'],
    records: [
      ...[1, 2, 3].map((externalId) => ({
        key: `bangumi:subject:${externalId}`,
        provider: 'bangumi' as const,
        kind: 'subject',
        externalId: String(externalId),
        title: `Archive ${externalId}`,
        language: 'ja',
        sourceUrl: `https://bgm.tv/subject/${externalId}`,
        data: {
          id: externalId,
          infobox: '{{original wiki}}',
          tags: [{ name: 'Old', count: 2 }],
          summary: 'Original full summary',
        },
        native: 'work' as const,
      })),
      {
        key: oldTagKey,
        provider: 'bangumi',
        kind: 'tag',
        externalId: 'Old',
        title: 'Old',
        language: 'und',
        sourceUrl: 'https://bgm.tv/subject_search/Old?cat=all',
        data: { name: 'Old' },
        native: 'concept',
      },
    ],
    edges: [
      { from: 'bangumi:subject:1', to: oldTagKey, kind: 'tag', data: { name: 'Old', count: 2 } },
    ],
    images: [
      {
        record: 'bangumi:subject:1',
        role: 'cover',
        url: 'https://api.bgm.tv/v0/subjects/1/image?type=large',
      },
    ],
    scope: {
      familySubjectIds: [1, 2, 3],
      sourceLimitations: [
        'Archive exports only a subset of community tags, as documented upstream.',
      ],
    },
  };
  const original = structuredClone(source),
    calls: string[] = [];
  const api = {
    id: 1,
    name: 'Current full title',
    summary: '完整内容'.repeat(10_000),
    tags: [
      { name: 'Old', count: 8, total_count: 800 },
      { name: 'New', count: 7, total_count: 700 },
    ],
    meta_tags: ['Public taxonomy'],
    images: {
      large: 'https://lain.bgm.tv/cover-large.png',
      medium: 'https://lain.bgm.tv/cover-medium.png',
    },
    comment: 'user post',
    infobox: [{ key: 'Long field', value: '完整信息'.repeat(10_000) }],
    rating: { total: 100, count: { '10': 60 } },
    arbitrary_future_field: { retained: true },
  };
  const captures = new Map(
    [1, 2].map((externalId) => {
      const url = `https://api.bgm.tv/v0/subjects/${externalId}`;
      return [
        sha256(canonical([url, null])),
        {
          url,
          digest: 'a'.repeat(64),
          bytes: 99,
          mediaType: 'application/json',
          fetchedAt: `2026-10-02T00:00:0${externalId}Z`,
          etag: null,
          lastModified: null,
        },
      ];
    }),
  );
  const a = {
    captures,
    json: async (url: string) => {
      calls.push(url);
      if (url.endsWith('/3')) throw new MissingRemote(url);
      return api;
    },
  } as unknown as Acquisition;
  const enriched = await enrichBangumiSubjects(a, source);
  expect(source).toEqual(original);
  expect(calls).toEqual([1, 2, 3].map((value) => `https://api.bgm.tv/v0/subjects/${value}`));
  const subject = enriched.records.find((row) => row.key === 'bangumi:subject:1')!;
  expect(subject.data.infobox).toBe('{{original wiki}}');
  expect(subject.data.summary).toBe('Original full summary');
  const { images: _images, comment: _comment, ...licensed } = api;
  expect(subject.data.api_subject).toEqual(licensed);
  expect(enriched.records.find((row) => row.kind === 'tag' && row.title === 'New')?.native).toBe(
    'concept',
  );
  expect(
    enriched.edges.find((edge) => edge.from === subject.key && edge.to === oldTagKey)?.data,
  ).toEqual({
    name: 'Old',
    count: 8,
    total_count: 800,
    api_tag: api.tags[0],
    archive_tag: { name: 'Old', count: 2 },
  });
  expect(
    enriched.edges.find((edge) => edge.from === subject.key && edge.kind === 'meta-tag')?.data
      .api_tag,
  ).toEqual({ name: 'Public taxonomy' });
  expect(enriched.images).toEqual([]);
  expect(enriched.scope.subjectApiCoverage).toMatchObject({
    requested: 3,
    successful: 2,
    unavailable: 1,
    responseInterval: { from: '2026-10-02T00:00:01Z', to: '2026-10-02T00:00:02Z' },
    redirects: [
      {
        from: 'bangumi:subject:2',
        to: 'bangumi:subject:1',
        url: 'https://api.bgm.tv/v0/subjects/2',
      },
    ],
  });
  expect(
    enriched.records.find((row) => row.key === 'bangumi:subject:3')?.data.api_subject_acquisition,
  ).toMatchObject({ status: 'unavailable', httpStatus: 404 });
  const replay = await enrichBangumiSubjects(a, enriched);
  expect(replay.records).toEqual(enriched.records);
  expect(replay.edges).toEqual(enriched.edges);
  expect(replay.images).toEqual(enriched.images);
});

const omitted = new Set<string>([...BANGUMI_USER_POST_FIELDS, ...BANGUMI_IMAGE_FIELDS]);

function keyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keyNames);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keyNames(child)]);
}

test('Bangumi mapping drops user posts and images from a captured subject and cites the page', () => {
  const capturedRow = (captured as Record<string, Record<string, unknown>>)['975']!;
  const row = {
    ...capturedRow,
    summary: '草帽一伙的航海故事。',
    comment: 'a user post',
    blog: { text: 'a user blog' },
    images: { large: 'https://lain.bgm.tv/pic/cover/l/nope.jpg' },
    api_subject: {
      id: 975,
      summary: '草帽一伙的航海故事。',
      comment: 'nested user post',
      images: { medium: 'https://lain.bgm.tv/nested.jpg' },
    },
  };
  const mapped = bangumiMappedData(row);
  expect(keyNames(mapped).filter((name) => omitted.has(name))).toEqual([]);
  expect(mapped.summary).toBe('草帽一伙的航海故事。');
  expect(mapped.name).toBe(capturedRow.name);
  const skipped = bangumiFieldDisposition(row).skipped;
  expect(skipped.map((item) => item.field).sort()).toEqual([
    'api_subject.comment',
    'api_subject.images',
    'blog',
    'comment',
    'images',
  ]);
  for (const item of skipped) expect(item.reason.length).toBeGreaterThan(0);
  expect(bangumiStatementEvidence('subject', 975)).toEqual(['https://bgm.tv/subject/975']);
  expect(bangumiStatementEvidence('character', 20)).toEqual(['https://bgm.tv/character/20']);
  expect(bangumiSourceUrl('character', 20)).toBe('https://bgm.tv/character/20');
});
