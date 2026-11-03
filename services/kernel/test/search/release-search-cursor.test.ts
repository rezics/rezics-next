import { expect, test } from 'bun:test';
import type { KeyRing } from '../../src/tokens/seal.ts';
import {
  readReleaseChildrenPage,
  readReleaseGroupsPage,
  ReleaseSearchCursorInvalid,
} from '../../src/search/release-search-cursor.ts';
import {
  ReleaseGroupingRestartRequired,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
} from '../../src/search/release-search-grouping.ts';

const now = 1_800_000_000_000;
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const physical = { generation: 7, incarnation: 'source-incarnation', indexUuid: 'physical-index' };
const request: ReleaseGroupingRequest = {
  releaseDigest: 'active-release',
  filter: { type: { in: ['release'] } },
  sort: 'name',
  languages: ['ja', 'en'],
  spoilerThreshold: 0,
  groupLimit: 1,
  childLimit: 2,
  previewLimit: 1,
};

function fixture() {
  let basis: ReleaseGroupingBasis = {
    releaseDigest: request.releaseDigest,
    physical,
    epoch: 'source-epoch-secret',
    calendarReadyFor: null,
  };
  let groupAfter: string | null = null;
  let childAfter: string | null = null;
  const source: ReleaseGroupingSource<{ id: string }, { id: string }> = {
    observe: async () => basis,
    groups: async (_request, after) => {
      groupAfter = after;
      return after === null
        ? { keys: [{ kind: 'work', id: 'work-secret' }], after: 'group-position-secret', exhausted: false }
        : { keys: [], after: 'group-position-final', exhausted: true };
    },
    children: async (_request, _work, after) => {
      childAfter = after;
      return after === null
        ? { keys: ['release-child'], after: 'child-position-secret', exhausted: false }
        : { keys: [], after: 'child-position-final', exhausted: true };
    },
    works: async (_request, ids) => new Map(ids.map((id) => [id, { id }])),
    releases: async (_request, ids) =>
      new Map(ids.map((id) => [id, { card: { id }, link: { kind: 'missing' as const } }])),
  };
  return {
    source,
    groupAfter: () => groupAfter,
    childAfter: () => childAfter,
    changeEpoch(value: string) {
      basis = { ...basis, epoch: value };
    },
  };
}

test('group and child cursors encrypt native positions and resume independently', async () => {
  const native = fixture();
  const first = await readReleaseGroupsPage({
    source: native.source,
    request,
    principal: 'account:reader',
    cursors,
    now,
  });
  expect(first.groups).toHaveLength(1);
  expect(typeof first.next).toBe('string');
  const group = first.groups[0];
  expect(group?.kind).toBe('work');
  if (group?.kind !== 'work') throw new Error('Expected a work group');
  expect(typeof group.next).toBe('string');
  for (const token of [first.next!, group.next!])
    for (const secret of ['work-secret', 'group-position-secret', 'child-position-secret', 'source-epoch-secret'])
      expect(token).not.toContain(secret);

  const nextGroups = await readReleaseGroupsPage({
    source: native.source,
    request,
    principal: 'account:reader',
    cursors,
    cursor: first.next!,
    now,
  });
  expect(native.groupAfter()).toBe('group-position-secret');
  expect(nextGroups.next).toBeNull();

  const nextChildren = await readReleaseChildrenPage({
    source: native.source,
    request,
    principal: 'account:reader',
    work: group.id,
    cursors,
    cursor: group.next!,
    now,
  });
  expect(native.childAfter()).toBe('child-position-secret');
  expect(nextChildren.children).toEqual([]);
  expect(nextChildren.next).toBeNull();
});

test('private continuations bind the viewer and the complete ordered request', async () => {
  const native = fixture();
  const first = await readReleaseGroupsPage({
    source: native.source,
    request,
    principal: 'account:reader',
    cursors,
    now,
  });
  await expect(
    readReleaseGroupsPage({
      source: native.source,
      request,
      principal: 'account:other',
      cursors,
      cursor: first.next!,
      now,
    }),
  ).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
  await expect(
    readReleaseGroupsPage({
      source: native.source,
      request: { ...request, languages: ['en', 'ja'] },
      principal: 'account:reader',
      cursors,
      cursor: first.next!,
      now,
    }),
  ).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
});

test('a source epoch change invalidates both continuations', async () => {
  const native = fixture();
  const first = await readReleaseGroupsPage({
    source: native.source,
    request,
    principal: 'account:reader',
    cursors,
    now,
  });
  native.changeEpoch('changed-source-epoch');
  await expect(
    readReleaseGroupsPage({
      source: native.source,
      request,
      principal: 'account:reader',
      cursors,
      cursor: first.next!,
      now,
    }),
  ).rejects.toBeInstanceOf(ReleaseGroupingRestartRequired);
});
