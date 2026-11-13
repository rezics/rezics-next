import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { historicalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioResult } from './contract';
import type {
  HostedHistoryEntry,
  HostedHistoryPage,
  HostedOutlineWindowNative,
  HostedOutlineWindowPage,
} from './hosted-contract';
import { createHostedBookNative, hostedFailure } from './hosted-native';
import { HostedHistoryVisit, type HostedHistoryBinding } from './hosted-history';
import { HostedHistoryDisclosure, HostedHistoryPanel } from './hosted-history-view';

const id = (value: number) => `00000000-0000-8000-8000-${(200000000 + value).toString().padStart(12, '0')}`;
const catalogueId = id(1);
const accountId = id(2);
const structure: HostedHistoryEntry = {
  catalogueId,
  revisionId: id(3),
  kind: 'structure',
  sourceRevisionId: null,
  createdAt: '2026-11-12T12:34:56.123456Z',
  isCurrentDraft: true,
  isCurrentRelease: false,
};
const release: HostedHistoryEntry = {
  ...structure,
  revisionId: id(4),
  kind: 'publication',
  sourceRevisionId: structure.revisionId,
  isCurrentDraft: false,
  isCurrentRelease: true,
};
const page = (items = [release, structure], nextCursor: string | null = null): HostedHistoryPage => ({
  catalogueId,
  items,
  nextCursor,
});
const outline = (entry = structure): HostedOutlineWindowPage => ({
  catalogueId,
  revisionId: entry.revisionId,
  kind: entry.kind,
  sourceRevisionId: entry.sourceRevisionId,
  items: [
    {
      occurrenceId: id(6),
      parentId: null,
      position: 0,
      title: 'Part one',
      kind: 'part',
      availability: 'available',
      target: null,
    },
    {
      occurrenceId: id(7),
      parentId: id(6),
      position: 0,
      title: 'First chapter',
      kind: 'chapter',
      availability: 'available',
      target: { threadId: id(8), postId: id(9), revisionId: id(10), sha256: 'a'.repeat(64) },
    },
    {
      occurrenceId: id(11),
      parentId: id(6),
      position: 1,
      title: 'Second chapter',
      kind: 'chapter',
      availability: 'available',
      target: { threadId: id(12), postId: id(13), revisionId: id(14), sha256: 'b'.repeat(64) },
    },
  ],
  nextCursor: null,
});
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const signal = () => new AbortController().signal;
function nativeResponse(data: unknown, status = 200) {
  const calls: URL[] = [];
  const native = createHostedBookNative(
    createKernelClient('https://kernel.test', {
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          calls.push(new URL(input instanceof Request ? input.url : String(input)));
          return Response.json(data, { status });
        },
        { preconnect: () => {} },
      ),
    }),
  );
  return { native, calls };
}
function mounted(native: HostedHistoryBinding['native'] & HostedOutlineWindowNative) {
  const client = new QueryClient();
  const session = { state: 'signed-in', subject: accountId, csrfToken: 'test' };
  client.setQueryData(['session'], session);
  const visit = new HostedHistoryVisit(
    { native, catalogueId, accountId, isCurrent: () => true },
    historicalReaderSource(client),
    native,
  );
  return {
    visit,
    replace: (subject = accountId) => client.setQueryData(['session'], { ...session, subject }),
    html: () => renderToStaticMarkup(createElement(HostedHistoryPanel, { visit })),
    dispose: () => {
      visit.dispose();
      client.clear();
    },
  };
}
const noDetail = async () => {
  throw new Error('Listing history must not fetch exact details');
};

test('native directory uses one metadata request, preserving opaque cursors, microseconds and native flags', async () => {
  const value = page(undefined, 'opaque+cursor/=');
  const { native, calls } = nativeResponse(value);
  expect(await native.listHistory(catalogueId, null, signal())).toEqual(ok(value));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.pathname).toBe(`/v1/hostedCatalogues/${catalogueId}/history`);
  expect([...calls[0]!.searchParams]).toEqual([['limit', '20']]);
  await native.listHistory(catalogueId, value.nextCursor, signal());
  expect(calls[1]!.searchParams.get('cursor')).toBe('opaque+cursor/=');
});

test('external metadata rejects mixed catalogues, duplicate IDs, invalid kinds, dates and source/current flags', async () => {
  for (const value of [
    { ...page(), catalogueId: id(20) },
    page([{ ...structure, catalogueId: id(20) }]),
    page([structure, structure]),
    page([{ ...structure, kind: 'chapter' } as unknown as HostedHistoryEntry]),
    page([{ ...structure, createdAt: 'yesterday' }]),
    page([{ ...structure, sourceRevisionId: id(20) }]),
    page([{ ...release, sourceRevisionId: null }]),
    page([{ ...release, isCurrentDraft: true }]),
    page([{ ...structure, isCurrentRelease: true }]),
    { ...page(), items: Array(21).fill(structure) },
    { ...page(), nextCursor: '' },
  ]) {
    const { native } = nativeResponse(value);
    expect(await native.listHistory(catalogueId, null, signal())).toMatchObject({
      ok: false,
      error: { kind: 'unavailable' },
    });
  }
  for (const [status, kind] of [
    [400, 'stale'],
    [409, 'stale'],
    [401, 'denied'],
    [403, 'denied'],
    [404, 'unavailable'],
    [503, 'unavailable'],
  ] as const) {
    const { native } = nativeResponse({}, status);
    expect(await native.listHistory(catalogueId, 'retained', signal())).toMatchObject({ ok: false, error: { kind } });
  }
});

test('paging retries the failed cursor, removes prior rows, and never converts errors to empty history', async () => {
  const calls: (string | null)[] = [];
  let count = 0;
  const screen = mounted({
    listHistory: async (_id, cursor) => {
      calls.push(cursor);
      return ++count === 1
        ? ok(page(undefined, 'next'))
        : count === 2
          ? hostedFailure('unavailable', 'Retry history')
          : ok(page([], null));
    },
    readOutlineWindow: noDetail,
  });
  await screen.visit.load();
  expect(screen.html()).toContain('Current draft');
  expect(screen.html()).toContain('Current release');
  expect(screen.html()).toContain(structure.createdAt);
  await screen.visit.next();
  expect(screen.html()).toContain('Retry this page');
  expect(screen.html()).not.toContain('Saved book versions');
  expect(screen.html()).not.toContain('No saved book versions');
  await screen.visit.load();
  expect(calls).toEqual([null, 'next', 'next']);
  expect(screen.html()).toContain('No versions on this page.');
  screen.dispose();
});

test('empty, sparse, denied and stale directories have different recovery and no retained outline', async () => {
  for (const [result, expected, absent] of [
    [ok(page([])), 'No saved book versions yet.', 'Retry this page'],
    [ok(page([], 'sparse')), 'Older versions', 'No saved book versions yet.'],
    [hostedFailure('denied', 'Author access denied'), 'Author access denied', 'Retry this page'],
    [hostedFailure('stale', 'Expired continuation'), 'Restart history', 'No saved book versions yet.'],
  ] as const) {
    const screen = mounted({ listHistory: async () => result, readOutlineWindow: noDetail });
    await screen.visit.load();
    expect(screen.html()).toContain(expected);
    expect(screen.html()).not.toContain(absent);
    screen.dispose();
  }
  const cursors: (string | null)[] = [];
  const screen = mounted({
    listHistory: async (_id, cursor) => {
      cursors.push(cursor);
      return ok(page([], 'repeat'));
    },
    readOutlineWindow: noDetail,
  });
  await screen.visit.load();
  await screen.visit.next();
  expect(screen.visit.snapshot()).toMatchObject({ kind: 'failed', error: { kind: 'stale' } });
  await screen.visit.restart();
  expect(cursors).toEqual([null, 'repeat', null]);
  screen.dispose();
});

test('inspection reads only an admitted exact selection, preserves chapter order and cannot write draft or release state', async () => {
  const selections: unknown[] = [];
  const draft = outline();
  const frozen = structuredClone(draft);
  const screen = mounted({
    listHistory: async () => ok(page()),
    readOutlineWindow: async (selection) => {
      selections.push(selection);
      return ok(selection.revision.kind === 'structure' ? draft : { ...outline(release), items: [] });
    },
  });
  await screen.visit.load();
  expect(selections).toHaveLength(0);
  await screen.visit.inspect(id(99));
  expect(selections).toHaveLength(0);
  await screen.visit.inspect(structure.revisionId);
  expect(selections).toEqual([
    {
      revision: { catalogueId, kind: 'structure', revisionId: structure.revisionId, sourceRevisionId: null },
      cursor: null,
    },
  ]);
  const html = screen.html();
  expect(html).toContain('Read-only');
  expect(html).toContain('Exact chapter order');
  expect(html.indexOf('First chapter')).toBeLessThan(html.indexOf('Second chapter'));
  expect(html).toContain(id(10));
  expect(html).not.toContain('checkbox');
  expect(html).not.toContain('Rename');
  expect(html).not.toContain('Use saved version');
  await screen.visit.inspect(release.revisionId);
  expect(screen.html()).toContain('This release contains no chapters (withdrawn).');
  expect(screen.html()).toContain('Source structure');
  expect(draft).toEqual(frozen);
  screen.visit.closeSelection();
  expect(screen.html()).not.toContain('Read-only');
  screen.dispose();
});

test('failed exact reads remain unavailable and revoked author access clears the entire history', async () => {
  for (const kind of ['unavailable', 'denied'] as const) {
    let readable = true;
    const screen = mounted({
      listHistory: async () => ok(page()),
      readOutlineWindow: async () => (readable ? ok(outline()) : hostedFailure(kind, 'Exact version access failed')),
    });
    await screen.visit.load();
    await screen.visit.inspect(structure.revisionId);
    expect(screen.html()).toContain('First chapter');
    readable = false;
    await screen.visit.inspect(structure.revisionId);
    expect(screen.html()).not.toContain('First chapter');
    expect(screen.html()).not.toContain('This structure has no parts');
    expect(screen.html()).toContain('Exact version access failed');
    expect(screen.visit.snapshot().kind).toBe(kind === 'denied' ? 'failed' : 'ready');
    screen.dispose();
  }
});

test('a substituted catalogue, kind, revision or source cannot be shown as the selected version', async () => {
  for (const change of [
    { catalogueId: id(20) },
    { kind: 'publication' as const },
    { revisionId: id(20) },
    { sourceRevisionId: id(20) },
  ]) {
    const screen = mounted({
      listHistory: async () => ok(page()),
      readOutlineWindow: nativeResponse({ ...outline(), ...change }).native.readOutlineWindow,
    });
    await screen.visit.load();
    await screen.visit.inspect(structure.revisionId);
    expect(screen.visit.snapshot()).toMatchObject({ kind: 'ready', selection: { kind: 'failed' } });
    expect(screen.html()).not.toContain('First chapter');
    screen.dispose();
  }
});

test('same-account replacement, account switch and unmount abort pending reads and permanently discard late results', async () => {
  for (const phase of ['page', 'detail'] as const) {
    for (const replacement of [accountId, id(20), 'dispose']) {
      let finish!: () => void;
      let requestSignal!: AbortSignal;
      const screen = mounted({
        listHistory: async (_id, _cursor, request) =>
          phase === 'page'
            ? new Promise((resolve) => {
                requestSignal = request;
                finish = () => resolve(ok(page()));
              })
            : ok(page()),
        readOutlineWindow: async (_selection, request) =>
          new Promise((resolve) => {
            requestSignal = request;
            finish = () => resolve(ok(outline()));
          }),
      });
      let pending = screen.visit.load();
      if (phase === 'detail') {
        await pending;
        pending = screen.visit.inspect(structure.revisionId);
      }
      if (replacement === 'dispose') screen.visit.dispose();
      else screen.replace(replacement);
      expect(requestSignal.aborted).toBe(true);
      expect(screen.visit.snapshot()).toEqual({ kind: 'ended' });
      finish();
      await pending;
      expect(screen.visit.snapshot()).toEqual({ kind: 'ended' });
      screen.dispose();
    }
  }
});

test('later selection and page navigation discard older pending outlines; closed disclosure mounts no history', async () => {
  let finish!: (value: StudioResult<HostedOutlineWindowPage>) => void;
  let oldSignal!: AbortSignal;
  const screen = mounted({
    listHistory: async (_id, cursor) => ok(page(undefined, cursor === null ? 'older' : null)),
    readOutlineWindow: async (selection, request) =>
      selection.revision.revisionId === structure.revisionId
        ? new Promise((resolve) => {
            finish = resolve;
            oldSignal = request;
          })
        : ok({ ...outline(release), items: [] }),
  });
  await screen.visit.load();
  const old = screen.visit.inspect(structure.revisionId);
  await screen.visit.inspect(release.revisionId);
  expect(oldSignal.aborted).toBe(true);
  finish(ok(outline()));
  await old;
  expect(screen.visit.snapshot()).toMatchObject({ selection: { kind: 'ready', entry: release } });
  const next = screen.visit.inspect(structure.revisionId);
  await screen.visit.next();
  expect(oldSignal.aborted).toBe(true);
  finish(ok(outline()));
  await next;
  expect(screen.visit.snapshot()).toMatchObject({ kind: 'ready', selection: { kind: 'none' } });
  const closed = screen.visit.inspect(structure.revisionId);
  screen.visit.closeSelection();
  expect(oldSignal.aborted).toBe(true);
  finish(ok(outline()));
  await closed;
  expect(screen.visit.snapshot()).toMatchObject({ selection: { kind: 'none' } });
  const html = renderToStaticMarkup(
    createElement(HostedHistoryDisclosure, {
      binding: { catalogueId, accountId, isCurrent: () => true, native: { listHistory: noDetail } },
    }),
  );
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Loading book history');
  screen.dispose();
});

test('exact pages preserve orphan preorder, withheld addresses and sparse continuations with explicit next and retry', async () => {
  const calls: URL[] = [];
  let continuationAttempts = 0;
  const first: HostedOutlineWindowPage = {
    ...outline(release),
    // Native order is authoritative even when parent parts are absent and sibling positions differ.
    items: [
      { ...outline().items[1]!, position: Number.MAX_SAFE_INTEGER },
      { ...outline().items[2]!, position: 512 },
      { occurrenceId: id(15), parentId: id(16), position: 900, kind: 'chapter', availability: 'unavailable' },
      { occurrenceId: id(17), parentId: null, position: 600, kind: 'part', availability: 'unavailable' },
    ],
    nextCursor: 'opaque+/=',
  };
  const native = createHostedBookNative(
    createKernelClient('https://kernel.test', {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url);
        if (url.pathname.endsWith('/history')) return Response.json(page());
        const cursor = url.searchParams.get('cursor');
        if (cursor === null) return Response.json(first);
        if (cursor === 'opaque+/=' && ++continuationAttempts === 1) return Response.json({}, { status: 503 });
        return Response.json({ ...outline(release), items: [], nextCursor: cursor === 'opaque+/=' ? 'last' : null });
      },
    }),
  );
  const screen = mounted(native);
  try {
    await screen.visit.load();
    expect(calls).toHaveLength(1);
    await screen.visit.inspect(release.revisionId);
    expect(calls).toHaveLength(2);
    const html = screen.html();
    expect(html).toContain('Next outline page');
    expect(html.indexOf('First chapter')).toBeLessThan(html.indexOf('Second chapter'));
    expect(html).toContain(String(Number.MAX_SAFE_INTEGER));
    expect(html).toContain('512');
    expect(html).toContain('Chapter unavailable');
    expect(html).toContain('Part unavailable');
    expect(html).not.toContain('Part one');
    expect(html.match(/Pinned version/g)).toHaveLength(2);
    expect(html.match(/<ol/g)).toHaveLength(2); // Directory and one flat outline; no invented ancestry.
    expect(screen.visit.snapshot()).toMatchObject({ selection: { page: first } });
    await screen.visit.nextOutline();
    expect(calls).toHaveLength(3);
    expect(screen.html()).toContain('Retry this outline page');
    expect(screen.html()).not.toContain('First chapter');
    expect(screen.html()).not.toContain('withdrawn');
    await screen.visit.retryOutline();
    expect(calls).toHaveLength(4);
    expect(screen.html()).toContain('No entries on this outline page.');
    expect(screen.html()).toContain('Next outline page');
    expect(screen.html()).not.toContain('withdrawn');
    await screen.visit.nextOutline();
    expect(calls).toHaveLength(5);
    expect(screen.html()).toContain('End of outline.');
    expect(screen.html()).not.toContain('Next outline page');
    expect(screen.html()).not.toContain('withdrawn');
    expect(calls.slice(1).map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      'opaque+/=',
      'opaque+/=',
      'last',
    ]);
    for (const url of calls.slice(1)) {
      expect(url.pathname).toBe(`/v1/hostedCatalogues/${catalogueId}/outline`);
      expect(url.searchParams.get('kind')).toBe('publication');
      expect(url.searchParams.get('revisionId')).toBe(release.revisionId);
      expect(url.searchParams.get('limit')).toBe('20');
    }
  } finally {
    screen.dispose();
  }
});

test('more than 512 native entries remain browsable while only one requested page is retained', async () => {
  let requests = 0;
  const screen = mounted({
    listHistory: async () => ok(page()),
    readOutlineWindow: async ({ revision, cursor }) => {
      requests++;
      const start = cursor === null ? 0 : Number(cursor);
      return ok({
        ...revision,
        items: Array.from({ length: 20 }, (_, offset) => ({
          occurrenceId: id(start + offset + 100),
          parentId: id(99),
          position: start + offset,
          kind: 'part' as const,
          availability: 'available' as const,
          title: `Entry ${start + offset}`,
          target: null,
        })),
        nextCursor: start === 520 ? null : String(start + 20),
      });
    },
  });
  try {
    await screen.visit.load();
    await screen.visit.inspect(structure.revisionId);
    expect(requests).toBe(1);
    for (let index = 1; index < 27; index++) await screen.visit.nextOutline();
    expect(requests).toBe(27);
    expect(screen.visit.snapshot()).toMatchObject({
      selection: { kind: 'ready', cursor: '520', page: { nextCursor: null } },
    });
    const html = screen.html();
    expect(html).toContain('Entry 539');
    expect(html).not.toContain('Entry 519');
    expect(html.match(/Sibling position/g)).toHaveLength(20);
  } finally {
    screen.dispose();
  }
});
