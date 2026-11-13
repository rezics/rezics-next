import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as v from 'valibot';
import { historicalReaderSource } from '../src/threads/historical-reader-provenance';
import { hostedPage, hostedRevise, type HostedOutlineWindowPage } from '../src/studio/hosted-contract';
import { createHostedBookNative, hostedFailure } from '../src/studio/hosted-native';
import { HostedOutlineWindow } from '../src/studio/hosted-outline-window';

const id = (n: number) => `00000000-0000-8000-8000-${n.toString(16).padStart(12, '0')}`;
const revision = { catalogueId: id(1), revisionId: id(2), kind: 'structure' as const, sourceRevisionId: null };
const cursor = 'opaque+/= retained cursor';
const slot = {
  occurrenceId: id(3),
  parentId: id(99),
  position: 512,
  kind: 'chapter' as const,
  availability: 'unavailable' as const,
};
const page: HostedOutlineWindowPage = { ...revision, items: [slot], nextCursor: cursor };
const signal = () => new AbortController().signal;
function transport(data: unknown, status = 200, controller?: AbortController) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const native = createHostedBookNative(
    createKernelClient('https://kernel.test', {
      headers: { authorization: 'Bearer private-author' },
      fetch: async (input, init) => {
        calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), init });
        controller?.abort();
        return Response.json(data, { status });
      },
    }),
  );
  return { native, calls };
}

test('one exact private page preserves large sibling addresses, absent parents, withheld slots and opaque continuation', async () => {
  const part = {
    ...slot,
    occurrenceId: id(4),
    position: Number.MAX_SAFE_INTEGER,
    kind: 'part' as const,
    availability: 'available' as const,
    title: 'Native part',
    target: null,
  };
  const chapter = {
    ...part,
    occurrenceId: id(5),
    position: 513,
    kind: 'chapter' as const,
    title: 'Native chapter',
    target: { threadId: id(20), postId: id(21), revisionId: id(22), sha256: 'a'.repeat(64) },
  };
  const value = { ...page, items: [slot, part, chapter] };
  const { native, calls } = transport(value);
  expect(await native.readOutlineWindow({ revision, cursor }, signal())).toEqual({ ok: true, value });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.pathname).toBe(`/v1/hostedCatalogues/${revision.catalogueId}/outline`);
  expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
    kind: 'structure',
    revisionId: revision.revisionId,
    limit: '20',
    cursor,
  });
  expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer private-author');
  expect(calls[0]!.init).toMatchObject({ cache: 'no-store', redirect: 'manual', signal: expect.any(AbortSignal) });
  const first = transport({ ...page, items: [], nextCursor: cursor });
  expect(await first.native.readOutlineWindow({ revision, cursor: null }, signal())).toEqual({
    ok: true,
    value: { ...page, items: [] },
  });
  expect(first.calls).toHaveLength(1);
  expect(first.calls[0]!.url.searchParams.has('cursor')).toBe(false);
  const release = {
    ...revision,
    kind: 'publication' as const,
    revisionId: id(6),
    sourceRevisionId: revision.revisionId,
  };
  const published = transport({ ...value, ...release });
  expect(await published.native.readOutlineWindow({ revision: release, cursor }, signal())).toEqual({
    ok: true,
    value: { ...value, ...release },
  });
  expect(published.calls).toHaveLength(1);
  expect(published.calls[0]!.url.searchParams.get('kind')).toBe('publication');
  expect(published.calls[0]!.url.searchParams.get('revisionId')).toBe(release.revisionId);
  // The old complete-tree wire and replacement bounds remain closed at 511/512.
  expect(v.safeParse(hostedPage, value).success).toBe(false);
  const placement = { occurrenceId: id(5), parentId: null, position: 511, kind: 'part', title: 'Part' };
  expect(v.safeParse(hostedRevise, { expectedRevisionId: revision.revisionId, placements: [placement] }).success).toBe(
    true,
  );
  expect(
    v.safeParse(hostedRevise, {
      expectedRevisionId: revision.revisionId,
      placements: [{ ...placement, position: 512 }],
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(hostedRevise, { expectedRevisionId: revision.revisionId, placements: Array(513).fill(placement) })
      .success,
  ).toBe(false);
});

test('external pages are closed and exact, with safe addresses and existing failure categories', async () => {
  for (const data of [
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((position) => ({ ...page, items: [{ ...slot, position }] })),
    { ...page, items: [{ ...slot, title: 'concealed' }] },
    { ...page, items: [{ ...slot, target: null }] },
    { ...page, items: Array(21).fill(slot) },
    { ...page, nextCursor: '' },
    { ...page, total: 1 },
    ...[{ catalogueId: id(9) }, { revisionId: id(9) }, { kind: 'publication' }, { sourceRevisionId: id(9) }].map(
      (change) => ({ ...page, ...change }),
    ),
  ]) {
    const { native, calls } = transport(data);
    expect(await native.readOutlineWindow({ revision, cursor }, signal())).toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
    expect(calls).toHaveLength(1);
  }
  for (const [status, kind] of [
    [400, 'stale'],
    [409, 'stale'],
    [401, 'denied'],
    [403, 'denied'],
    [404, 'unavailable'],
    [503, 'unavailable'],
  ] as const) {
    const { native } = transport({}, status);
    expect(await native.readOutlineWindow({ revision, cursor }, signal())).toMatchObject({
      ok: false,
      error: { kind },
    });
  }
  const invalid = transport(page);
  expect(await invalid.native.readOutlineWindow({ revision, cursor: '' }, signal())).toMatchObject({
    ok: false,
    error: { kind: 'invalid' },
  });
  expect(invalid.calls).toHaveLength(0);
  const controller = new AbortController();
  const cancelled = transport(page, 200, controller);
  expect((await cancelled.native.readOutlineWindow({ revision, cursor }, controller.signal)).ok).toBe(false);
  const stopped = transport(page);
  expect((await stopped.native.readOutlineWindow({ revision, cursor }, controller.signal)).ok).toBe(false);
  expect(stopped.calls).toHaveLength(0);
});

test('a window retries the exact failed cursor and retires retained and late pages on equal-account session replacement', async () => {
  const client = new QueryClient();
  const session = { state: 'signed-in', subject: id(8), csrfToken: 'credential' };
  client.setQueryData(['session'], session);
  const calls: (string | null)[] = [];
  let finish!: (value: { ok: true; value: HostedOutlineWindowPage }) => void;
  let pendingSignal!: AbortSignal;
  const window = new HostedOutlineWindow(
    {
      readOutlineWindow: async (input, signal) => {
        calls.push(input.cursor);
        if (calls.length === 2) return hostedFailure('stale', 'Rejected continuation');
        if (calls.length === 4) {
          pendingSignal = signal;
          return await new Promise<{ ok: true; value: HostedOutlineWindowPage }>((resolve) => {
            finish = resolve;
          });
        }
        return { ok: true, value: page };
      },
    },
    historicalReaderSource(client),
    id(8),
    revision,
  );
  try {
    await window.load();
    expect(window.snapshot()).toMatchObject({ kind: 'ready', page });
    await window.next();
    expect(window.snapshot()).toMatchObject({ kind: 'failed', cursor, error: { kind: 'stale' } });
    await window.load();
    expect(calls).toEqual([null, cursor, cursor]);
    const pending = window.next();
    expect(window.snapshot()).toEqual({ kind: 'loading', cursor });
    client.setQueryData(['session'], { ...session });
    expect(pendingSignal.aborted).toBe(true);
    expect(window.snapshot()).toEqual({ kind: 'ended' });
    finish({ ok: true, value: page });
    await pending;
    await window.load();
    expect(calls).toHaveLength(4);
    expect(window.snapshot()).toEqual({ kind: 'ended' });
  } finally {
    window.dispose();
    client.clear();
  }
});
