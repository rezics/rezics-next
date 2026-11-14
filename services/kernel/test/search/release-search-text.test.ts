import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { createCurrentTextMatcher, CURRENT_TEXT_LIMITS } from '../../src/search/disclosure/current-text.ts';
import {
  createReleaseSearchCandidateStreams,
  observeReleaseSearchCandidates,
  type ReleaseSearchCandidatePool,
} from '../../src/search/release-search-native-stream.ts';
import {
  readReleaseChildren,
  readReleaseGroups,
  RELEASE_GROUPING_LIMITS,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
} from '../../src/search/release-search-grouping.ts';
import { filterReleaseSearchNameGroups, bindReleaseSearchText } from '../../src/search/release-search-text.ts';
import { subjectPartition, type IndexedSubject, type NativeWorkLinkEvidence } from '../../src/search/source.ts';
import { parseText } from '../../src/search/text.ts';

const workId = '10000000-0000-8000-8000-000000000001';
const olderId = '10000000-0000-8000-8000-000000000002';
const laterId = '10000000-0000-8000-8000-000000000003';
const finalId = '10000000-0000-8000-8000-000000000004';
const textRequest: ReleaseGroupingRequest = {
  releaseDigest: 'active',
  filter: { type: { in: ['edition'] } },
  text: 'needle',
  sort: 'name',
  languages: ['en'],
  spoilerThreshold: 0,
  groupLimit: 1,
  childLimit: 1,
  previewLimit: 1,
};
const release: FilterRelease = {
  types: {
    work: { bases: ['schema:CreativeWork'] },
    edition: { bases: ['schema:CreativeWork'], facets: ['schema:exampleOfWork'] },
  },
  properties: { 'schema:exampleOfWork': { datatype: 'wikibase-item' } },
};
const physical = { generation: 1, incarnation: 'physical-one', indexUuid: 'physical-one' };
const basis: ReleaseGroupingBasis = {
  releaseDigest: 'active',
  physical,
  calendarReadyFor: physical,
  epoch: 'current-name-and-disclosure-cut',
};

function subject(id: string, title: string, type = 'edition', aliases: string[] = []): IndexedSubject {
  return {
    id,
    type,
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: title ? [{ language: 'en', value: title }] : [],
    aliases: aliases.map((value) => ({ language: 'en', value })),
    descriptions: [],
    statements: [],
  };
}

function currentText() {
  const analyzed: string[] = [];
  const matcher = createCurrentTextMatcher(async (_analyzer, text) => {
    analyzed.push(text);
    return [...text.matchAll(/[a-z0-9]+/giu)].map((match, position) => ({
      token: match[0]!.toLowerCase(),
      position,
      startOffset: match.index,
      endOffset: match.index + match[0]!.length,
    }));
  });
  const check = bindReleaseSearchText(matcher, parseText('needle'), () => {
    throw new Error('Current text was not proven');
  })!;
  return { analyzed, check };
}

test('name order uses current work text and does not trust a retired alias', async () => {
  const { analyzed, check } = currentText();
  const older = subject(olderId, 'Earlier series', 'work');
  const restored = subject(laterId, 'Needle restored series', 'work');
  const read: string[][] = [];
  const page = await filterReleaseSearchNameGroups(
    {
      keys: [
        { kind: 'work', id: older.id },
        { kind: 'work', id: restored.id },
        { kind: 'release', id: finalId },
      ],
      after: 'name-frontier-3',
      exhausted: false,
    },
    async (ids) => {
      read.push([...ids]);
      return new Map([
        [older.id, older],
        [restored.id, restored],
      ]);
    },
    new Set(['work']),
    check,
  );
  expect(page.keys).toEqual([
    { kind: 'work', id: restored.id },
    { kind: 'release', id: finalId },
  ]);

  // The same current Subject projection can restore a match after the old indexed alias disappears.
  const work = subject(workId, 'Needle current title', 'work');
  expect(await check(older)).toBe(false);
  expect(await check(work)).toBe(true);
  const bulky = subject(finalId, '', 'work', ['x'.repeat(CURRENT_TEXT_LIMITS.scanBytes)]);
  await expect(check(bulky)).rejects.toThrow('Current text was not proven');
  expect(read).toEqual([[older.id, restored.id]]);
  expect(analyzed.filter((value) => value === 'needle')).toHaveLength(1);
  expect(analyzed).not.toContain('Needle retired alias');
  expect(page.after).toBe('name-frontier-3');
  expect(page.exhausted).toBe(false);
});

test('a stale relevance alias cannot claim a work before a later current edition matches', async () => {
  const { check } = currentText();
  const work = subject(workId, 'Series', 'work');
  const older = subject(olderId, 'Earlier edition'); // Its former Needle alias is absent from current source.
  const later = subject(laterId, 'Needle revised edition');
  const subjects = new Map([work, older, later].map((value) => [value.id, value] as const));
  const links = new Map<string, NativeWorkLinkEvidence>(
    [older, later].map((value) => [value.id, { complete: true, values: [{ kind: 'work', id: work.id }] }] as const),
  );
  const partition = subjectPartition(work.id);
  const home = { partition, generation: '1', epoch: 1, position: '0' };
  const pools: ReleaseSearchCandidatePool[] = [
    {
      id: 'semantic',
      names: {
        observe: async () => ({ generation: '1', homes: [home] }),
        read: async () => ({ home, candidates: [] }),
      },
      source: {
        read: async (selected, ids) => ({
          partition: selected,
          position: 0n,
          subjects: ids.flatMap((id) => (subjects.has(id) ? [subjects.get(id)!] : [])),
        }),
        readCompleteWorkLinks: async (_partition, ids) =>
          new Map(ids.flatMap((id) => (links.has(id) ? [[id, links.get(id)!] as const] : []))),
      },
    },
  ];
  const context = {
    deadline: Date.now() + 10_000,
    reserve: () => undefined,
    observe: async () => basis,
  };
  const cut = await observeReleaseSearchCandidates(pools, context);
  const ids = [older.id, later.id];
  const streams = createReleaseSearchCandidateStreams({
    pools,
    release,
    cut,
    context,
    relevance: async (_request, after, size) => {
      const offset = after === null ? 0 : Number(after);
      const selected = ids.slice(offset, offset + size);
      const keys = selected.map((id, index) => ({
        id,
        pool: 'semantic',
        partition,
        name: null,
        securityRevision: subjects.get(id)!.securityRevision,
        after: String(offset + index + 1),
      }));
      return { keys, after: String(offset + selected.length), exhausted: offset + selected.length === ids.length };
    },
    currentMatches: async (_request, keys) => {
      const matches = await Promise.all(keys.map(async ({ id }) => check(subjects.get(id)!)));
      return new Set(keys.flatMap(({ id }, index) => (matches[index] ? [id] : [])));
    },
  });
  expect((await streams.groups({ ...textRequest, sort: 'relevance' }, null, 2)).keys).toEqual([
    { kind: 'work', id: work.id },
  ]);
});

test('current matching releases fill previews and their own child continuation within the read bound', async () => {
  const { check } = currentText();
  const work = subject(workId, 'Series', 'work');
  const subjects = new Map([
    [work.id, work],
    [olderId, subject(olderId, 'Earlier edition')],
    [laterId, subject(laterId, 'Needle first match')],
    [finalId, subject(finalId, 'Needle next match')],
  ] as const);
  const childIds = [olderId, laterId, finalId];
  let childReads = 0;
  let releaseReads = 0;
  const source: ReleaseGroupingSource<string, string> = {
    observe: async () => basis,
    groups: async (_request, _after, _size) => ({
      keys: [{ kind: 'work', id: work.id }],
      after: 'group-end',
      exhausted: true,
    }),
    children: async (_request, _work, after, size) => {
      childReads++;
      const start = after === null ? 0 : Number(after);
      const keys = childIds.slice(start, start + size);
      return { keys, after: String(start + keys.length), exhausted: start + keys.length === childIds.length };
    },
    works: async (_request, ids) => new Map(ids.map((id) => [id, `Work ${id}`] as const)),
    releases: async (_request, ids) => {
      releaseReads++;
      const values: [string, { card: string; link: { kind: 'linked'; work: string } }][] = [];
      for (const id of ids)
        if (await check(subjects.get(id)!)) values.push([id, { card: id, link: { kind: 'linked', work: work.id } }]);
      return new Map(values);
    },
  };
  const preview = await readReleaseGroups(source, textRequest);
  const group = preview.values[0]!;
  if (group.kind !== 'work') throw new Error('Expected a work preview');
  expect(group.releases).toEqual([laterId]);
  expect(group.next).not.toBeNull();
  const continued = await readReleaseChildren(source, textRequest, work.id, group.next!);
  expect(continued.values).toEqual([finalId]);
  expect(continued.next).toBeNull();
  expect(childReads).toBe(3);
  expect(releaseReads).toBe(3);
  expect(preview.usage.seeks).toBeLessThanOrEqual(RELEASE_GROUPING_LIMITS.seeks);
  expect(continued.usage.seeks).toBeLessThanOrEqual(RELEASE_GROUPING_LIMITS.seeks);
});
