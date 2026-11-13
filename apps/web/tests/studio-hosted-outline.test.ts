import { expect, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { createHostedBookNative } from '../src/studio/hosted-native';
import { hostedBookStructure } from '../src/studio/hosted-structure';

const id = (n: number) => `00000000-0000-8000-8000-${n.toString(16).padStart(12, '0')}`;
const catalogueId = id(1),
  revisionId = id(2),
  releaseId = id(3);
const revision = { catalogueId, revisionId, kind: 'structure' as const, sourceRevisionId: null };
const part = (n: number, parentId: string | null, position = 0) => ({
  occurrenceId: id(n),
  parentId,
  position,
  kind: 'part' as const,
  title: `Part ${n}`,
  availability: 'available' as const,
  target: null,
});
const chapter = {
  ...part(13, id(12)),
  kind: 'chapter' as const,
  target: { threadId: id(80), postId: id(81), revisionId: id(82), sha256: 'a'.repeat(64) },
};
const rows = [
  part(10, null),
  part(11, id(10)),
  part(12, id(10), 1),
  chapter,
  ...Array.from({ length: 18 }, (_, i) => part(20 + i, null, i + 1)),
];
const page = (items: readonly unknown[], nextCursor: unknown = null, selected = revision) => ({
  ...selected,
  items,
  nextCursor,
});
const signal = () => new AbortController().signal;
function transport(pages: unknown[], selected: unknown = revision, statuses: number[] = [], abort?: AbortController) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = createKernelClient('https://kernel.test', {
    headers: { authorization: 'Bearer author-session' },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init });
      const isPage = url.pathname.endsWith('/outline');
      const data =
        init?.method === 'POST'
          ? { catalogueId, revisionId: (selected as typeof revision).revisionId }
          : isPage
            ? pages.shift()
            : selected;
      if (isPage) abort?.abort();
      return Response.json(data, {
        status: isPage ? (statuses.shift() ?? 200) : 200,
        headers: { [SESSION_HEADER]: 'native-anchor' },
      });
    },
  });
  return { native: createHostedBookNative(client), calls };
}

test('native preorder pages retain nested and empty parts and exact targets without parent or body reads', async () => {
  const { native, calls } = transport([page(rows.slice(0, 20), 'opaque+/='), page(rows.slice(20))]);
  const result = await native.read({ catalogueId, kind: 'structure' }, signal());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.placements.map((p) => p.occurrenceId)).toEqual(rows.map((p) => p.occurrenceId));
  expect(hostedBookStructure(result.value).placements.map((p) => p.occurrenceId)).toEqual(
    rows.map((p) => p.occurrenceId),
  );
  expect(result.value.placements[3]).toMatchObject({ target: chapter.target });
  expect(calls.map((c) => c.url.pathname)).toEqual([
    `/v1/hostedCatalogues/${catalogueId}`,
    `/v1/hostedCatalogues/${catalogueId}/outline`,
    `/v1/hostedCatalogues/${catalogueId}/outline`,
  ]);
  expect(calls[0]!.url.searchParams.has('revisionId')).toBe(false);
  for (const [i, call] of calls.slice(1).entries()) {
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      kind: 'structure',
      revisionId,
      limit: '20',
      ...(i ? { cursor: 'opaque+/=' } : {}),
    });
    expect(new Headers(call.init?.headers).get(SESSION_HEADER)).toBe('native-anchor');
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer author-session');
    expect(call.init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  }
});

test('a malformed, withheld or incomplete stream never materializes a tree', async () => {
  const deep = Array.from({ length: 17 }, (_, i) => part(100 + i, i ? id(99 + i) : null));
  for (const pages of [
    [page([rows[0], rows[0]])],
    [page([part(10, id(999))])],
    [page([part(12, null), chapter, part(14, id(13))])],
    [page([part(10, null, 1)])],
    [page([rows[0], rows[2], rows[1]])],
    [page(deep)],
    [page([rows[0], part(20, null, 1), rows[1]])],
    [page([rows[0]], 'a'), page([rows[0]])],
    [page([rows[0]], 'a'), page([rows[1]], 'a')],
    [page([], 'a')],
    [page([], '')],
    [page([], 7)],
    [page(rows)],
    [
      page([rows[0]], 'a'),
      page([{ occurrenceId: id(11), parentId: id(10), position: 0, kind: 'chapter', availability: 'unavailable' }]),
    ],
    [page([rows[0]], 'a'), { ...page([rows[1]]), revisionId: id(99) }],
    [{ ...page([]), catalogueId: id(99) }],
    [{ ...page([]), kind: 'publication' }],
    [{ ...page([]), sourceRevisionId: id(99) }],
    [page([{ ...rows[0], document: 'forbidden body' }])],
  ]) {
    const maxCalls = pages.length + 1;
    const { native, calls } = transport(pages);
    expect((await native.read({ catalogueId, kind: 'structure' }, signal())).ok).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(maxCalls);
  }
  for (const status of [400, 401, 403, 404, 503]) {
    const { native, calls } = transport([page([rows[0]], 'a'), {}], revision, [200, status]);
    expect((await native.read({ catalogueId, kind: 'structure' }, signal())).ok).toBe(false);
    expect(calls).toHaveLength(3);
  }
  const abort = new AbortController();
  const { native } = transport([page([])], revision, [], abort);
  expect((await native.read({ catalogueId, kind: 'structure' }, abort.signal)).ok).toBe(false);
});

test('exact command readback stays separate for draft and empty withdrawal releases', async () => {
  for (const publish of [false, true]) {
    const selected = publish
      ? { ...revision, revisionId: releaseId, kind: 'publication' as const, sourceRevisionId: revisionId }
      : revision;
    const { native, calls } = transport([{ ...page([]), ...selected }], selected);
    const key = '019a8c75-4e19-8d2f-8a36-94dd410dd880';
    const result = publish
      ? await native.publish(
          catalogueId,
          { expectedRevisionId: revisionId, expectedPublicationId: null, occurrenceIds: [] },
          key,
          signal(),
        )
      : await native.revise(catalogueId, { expectedRevisionId: revisionId, placements: [] }, key, signal());
    expect(result).toEqual({ ok: true, value: { revision: selected, placements: [] } });
    expect(calls).toHaveLength(3);
    expect(new Headers(calls[0]!.init?.headers).get('idempotency-key')).toBe(JSON.stringify(key));
    expect(calls[1]!.url.searchParams.get('revisionId')).toBe(selected.revisionId);
    expect(calls[2]!.url.searchParams.get('revisionId')).toBe(selected.revisionId);
    expect(calls[2]!.url.searchParams.get('kind')).toBe(selected.kind);
  }
  const denied = transport([{}], revision, [403]);
  expect(
    await denied.native.revise(
      catalogueId,
      { expectedRevisionId: revisionId, placements: [] },
      '019a8c75-4e19-8d2f-8a36-94dd410dd880',
      signal(),
    ),
  ).toMatchObject({ ok: false, error: { kind: 'uncertain' } });
});
