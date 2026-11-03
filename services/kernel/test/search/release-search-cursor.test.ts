import { expect, test } from 'bun:test';
import type { KeyRing } from '../../src/tokens/seal.ts';
import {
  readReleaseChildrenPage,
  readReleaseGroupsPage,
  ReleaseSearchCursorInvalid,
  type ReleaseSearchPrincipal,
} from '../../src/search/release-search-cursor.ts';
import {
  ReleaseGroupingRestartRequired,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
} from '../../src/search/release-search-grouping.ts';

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
const options = {
  request,
  principal: 'account:00000000-0000-8000-8000-000000000001' as ReleaseSearchPrincipal,
  cursors,
  now: 1_800_000_000_000,
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
  let observations = 0;
  const source: ReleaseGroupingSource<{ id: string }, { id: string }> = {
    observe: async () => {
      observations++;
      return basis;
    },
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
      new Map(ids.map((id) => [id, { card: { id }, link: { kind: 'linked' as const, work: 'work-secret' } }])),
  };
  return {
    source,
    groupAfter: () => groupAfter,
    childAfter: () => childAfter,
    observations: () => observations,
    change: (patch: Partial<ReleaseGroupingBasis>) => {
      basis = { ...basis, ...patch };
    },
  };
}

type Native = ReturnType<typeof fixture>;
const groups = (native: Native, cursor?: string, overrides: Partial<typeof options> = {}) =>
  readReleaseGroupsPage({ ...options, ...overrides, source: native.source, cursor });
const children = (native: Native, cursor?: string, overrides: Partial<typeof options> = {}, work = 'work-secret') =>
  readReleaseChildrenPage({ ...options, ...overrides, source: native.source, cursor, work });
async function firstPage(native: Native, overrides: Partial<typeof options> = {}) {
  const page = await groups(native, undefined, overrides);
  expect(page.groups).toHaveLength(1);
  const group = page.groups[0]!;
  if (group.kind !== 'work') throw new Error('Expected a work group');
  expect(typeof page.next).toBe('string');
  expect(typeof group.next).toBe('string');
  return { page, group };
}

test('group and preview child cursors encrypt native positions and resume independently', async () => {
  const native = fixture();
  const { page, group } = await firstPage(native);
  for (const secret of ['group-position-secret', 'child-position-secret', 'source-epoch-secret'])
    expect(JSON.stringify(page)).not.toContain(secret);
  for (const token of [page.next!, group.next!]) expect(token).not.toContain('work-secret');
  expect(group.releases).toEqual([{ id: 'release-child' }]);
  const nextGroups = await groups(native, page.next!);
  expect(native.groupAfter()).toBe('group-position-secret');
  expect(nextGroups.next).toBeNull();
  const nextChildren = await children(native, group.next!);
  expect(native.childAfter()).toBe('child-position-secret');
  expect(nextChildren.children).toEqual([]);
  expect(nextChildren.next).toBeNull();
});

test('both streams authenticate viewer, ordered request, stream, work, token integrity and expiry before reads', async () => {
  const native = fixture();
  const { page, group } = await firstPage(native);
  const observed = native.observations();
  const changes: Partial<typeof options>[] = [
    { principal: 'anonymous' },
    { principal: 'account:00000000-0000-8000-8000-000000000002' },
    ...[
      { languages: ['en', 'ja'] },
      { sort: 'relevance' as const },
      { text: 'edition' },
      { filter: { statement: { property: 'schema:publisher', in: ['producer'] } } },
      { spoilerThreshold: 1 as const },
      { groupLimit: 2 },
      { childLimit: 3 },
      { previewLimit: 2 },
    ].map((patch) => ({ request: { ...request, ...patch } })),
  ];
  for (const change of changes) {
    await expect(groups(native, page.next!, change)).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
    await expect(children(native, group.next!, change)).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
  }
  await expect(groups(native, group.next!)).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
  await expect(children(native, page.next!)).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
  await expect(children(native, group.next!, {}, 'other-work')).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
  for (const read of [groups, children]) {
    const token = read === groups ? page.next! : group.next!;
    await expect(read(native, `!${token.slice(1)}`)).rejects.toBeInstanceOf(ReleaseSearchCursorInvalid);
    await expect(read(native, token, { now: options.now + 16 * 60_000 })).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
  }
  expect(native.observations()).toBe(observed);
});

test('epoch, active release, physical identity and calendar readiness changes retire both continuations', async () => {
  const changes: Partial<ReleaseGroupingBasis>[] = [
    { epoch: 'changed-disclosure-redirect-date-credit-order' },
    { releaseDigest: 'successor' },
    ...[{ generation: 8 }, { incarnation: 'successor' }, { indexUuid: 'replacement' }].map((patch) => ({
      physical: { ...physical, ...patch },
    })),
    { calendarReadyFor: physical },
  ];
  for (const change of changes) {
    const native = fixture();
    const { page, group } = await firstPage(native);
    native.change(change);
    await expect(groups(native, page.next!)).rejects.toBeInstanceOf(ReleaseGroupingRestartRequired);
    await expect(children(native, group.next!)).rejects.toBeInstanceOf(ReleaseGroupingRestartRequired);
  }
});

test('anonymous preview continuations retain confidentiality and expiry', async () => {
  const native = fixture();
  const anonymous = { principal: 'anonymous' as const };
  const { page, group } = await firstPage(native, anonymous);
  expect((await groups(native, page.next!, anonymous)).next).toBeNull();
  expect((await children(native, group.next!, anonymous)).next).toBeNull();
  await expect(children(native, group.next!, { ...anonymous, now: options.now + 16 * 60_000 })).rejects.toBeInstanceOf(
    ReleaseGroupingRestartRequired,
  );
});

test('caller mutation during either source read cannot change the request sealed into the continuation', async () => {
  for (const read of [groups, children]) {
    const native = fixture();
    const submitted = { ...structuredClone(request), childLimit: 1, languages: ['ja', 'en'] };
    const admitted = structuredClone(submitted);
    const observe = native.source.observe;
    native.source.observe = async () => {
      submitted.languages.splice(0, 2, 'en', 'ja');
      return observe();
    };
    const page = await read(native, undefined, { request: submitted });
    expect(typeof page.next).toBe('string');
    expect((await read(native, page.next!, { request: admitted })).next).toBeNull();
  }
});
