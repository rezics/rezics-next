import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioResult, StudioSelection } from '../src/studio/contract';
import type {
  HostedOwnedBook,
  HostedOutlineWindowPage,
  HostedOutlineWindowRequest,
  HostedRootAppendRequest,
} from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { accountId, row, selected } from './own-drafts-fixture';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { HostedDraftPicker } = await import('../src/studio/hosted-draft-picker');
const { HostedRootAppendVisit } = await import('../src/studio/hosted-root-append');
const { HostedRootAppendView } = await import('../src/studio/hosted-root-append-view');
const { HostedBookInventory } = await import('../src/studio/workspace');
const { HostedInventoryVisit } = await import('../src/studio/hosted-inventory');
const { createHostedBookNative, hostedFailure } = await import('../src/studio/hosted-native');
const { hostedPage, hostedRevise } = await import('../src/studio/hosted-contract');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const receipt = { catalogueId: id(1), revisionId: id(9) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const entry = row({ title: 'Independent chapter' });
  const resumed = selected(entry);
  const selection: StudioSelection = {
    revision: {
      exact: { postId: entry.id, revisionId: entry.revisionId, sha256: await editionDocumentDigest(resumed.post.body) },
      title: entry.title!,
      body: resumed.post.body,
      savedAt: entry.savedAt,
      mediaIds: [],
    },
    visibility: 'draft',
    permissions: { edit: true, publish: false },
    native: { threadId: entry.threadId, boardId: entry.board.id, licence: entry.licence, subjectIds: [] },
  };
  let observation: HistoricalReaderObservation = {
    sourceId: 'private-session',
    generation: 1,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: accountId,
    credentialMode: 'session',
    healthy: true,
    csrfReady: true,
  };
  const listeners = new Set<() => void>();
  const source: HistoricalReaderSource = {
    id: 'private-session',
    read: () => observation,
    revision: () => observation.generation,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const owner: HostedOwnedBook = {
    viewer: { accountId, authnEpoch: 2 },
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    item: {
      catalogueId: id(1),
      threadId: id(2),
      postRevisionId: id(3),
      headRevisionId: id(4),
      title: 'Owned Book',
      publicationId: null,
      postVisibility: 'draft',
      createdAt: entry.savedAt,
    },
  };
  const reader = {
    list: mock(async () => ({ state: 'ready' as const, viewer: owner.viewer, drafts: [entry], next: null })),
    resume: mock(async () => resumed),
  };
  const readDocument = mock(async () => ok(selection));
  const picker = new HostedDraftPicker({
    viewer: owner.viewer,
    source,
    reader,
    locale: 'en',
    isCurrent: () => true,
    readDocument,
  });
  const native = {
    appendRootChapter: mock(
      async (
        _input: HostedRootAppendRequest,
        _signal: AbortSignal,
        _csrf?: string,
      ): Promise<StudioResult<typeof receipt>> => ok(receipt),
    ),
    readOwn: mock(async () => ok({ ...owner, item: { ...owner.item, headRevisionId: id(8) } })),
    readOutlineWindow: mock(
      async (
        { revision, cursor }: HostedOutlineWindowRequest,
        _signal: AbortSignal,
      ): Promise<StudioResult<HostedOutlineWindowPage>> =>
        ok({
          ...revision,
          items: cursor
            ? [
                {
                  occurrenceId: id(7),
                  parentId: id(99),
                  position: Number.MAX_SAFE_INTEGER,
                  kind: 'chapter' as const,
                  availability: 'unavailable' as const,
                },
              ]
            : [],
          nextCursor: cursor ? null : 'opaque+/= next',
        }),
    ),
  };
  const visit = new HostedRootAppendVisit({ owner, source, picker, locale: 'en', csrfToken: 'captured-csrf', native });
  return {
    entry,
    reader,
    readDocument,
    selection,
    source,
    native,
    owner,
    visit,
    change(change: Partial<HistoricalReaderObservation> = { generation: 2 }) {
      observation = { ...observation, ...change };
      for (const listener of listeners) listener();
    },
  };
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => {
    root.render(<HostedRootAppendView visit={f.visit} locale="en" />);
    const state = f.visit.snapshot();
    if (state.kind === 'active') await state.outline.load();
  });
  return {
    host,
    click: async (name: string) =>
      act(async () => {
        (getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement).click();
      }),
    async select() {
      await this.click('Open a saved account draft');
      await this.click('Independent chapter');
    },
    close: async () => {
      await act(async () => {
        root.unmount();
        f.visit.dispose();
      });
      host.remove();
    },
  };
}

test('owned Book inventory offers append before any complete outline or document load', async () => {
  const f = await fixture();
  const inventory = new HostedInventoryVisit(
    { listOwn: async () => ok({ ...f.owner, items: [f.owner.item], nextCursor: null }) },
    f.source,
    accountId,
  );
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host);
  try {
    await act(async () => {
      await inventory.load();
      root.render(<HostedBookInventory visit={inventory} locale="en" />);
    });
    const link = getByRole(host, 'link', { name: 'Append a saved chapter' }) as HTMLAnchorElement;
    expect(Object.fromEntries(new URL(link.href).searchParams)).toEqual({
      catalogueId: id(1),
      ownerAccount: accountId,
      ownerEpoch: '2',
      append: '1',
    });
    expect(f.native.readOutlineWindow).not.toHaveBeenCalled();
    expect(f.reader.list).not.toHaveBeenCalled();
    expect(f.readDocument).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    inventory.dispose();
    f.visit.dispose();
    host.remove();
  }
});

test('mounted exact review freezes the saved target, title, owner head and same-key unknown replay; failed readback never resubmits', async () => {
  const f = await fixture(),
    ui = await mount(f);
  f.native.appendRootChapter.mockImplementationOnce(async () => hostedFailure('uncertain', 'Unknown result'));
  try {
    expect(f.reader.list).not.toHaveBeenCalled();
    await ui.select();
    expect(f.readDocument).toHaveBeenCalledTimes(1);
    expect(f.reader.resume).toHaveBeenCalledTimes(1);
    expect(ui.host.textContent).toContain('Selected server body');
    expect(ui.host.textContent).toContain(f.selection.revision.exact.sha256);
    await act(async () => f.visit.setTitle('Root chapter title'));
    await ui.click('Review append');
    expect(document.activeElement?.textContent).toBe('Review append');
    expect(f.native.appendRootChapter).not.toHaveBeenCalled();
    await ui.click('Append this saved chapter');
    const first = f.native.appendRootChapter.mock.calls[0]!;
    expect(first[0]).toEqual({
      catalogueId: id(1),
      expectedViewer: f.owner.viewer,
      idempotencyKey: expect.any(String),
      body: {
        expectedRevisionId: id(4),
        occurrenceId: expect.stringMatching(/^[a-f0-9-]{14}8/),
        title: 'Root chapter title',
        target: { ...f.selection.revision.exact, threadId: f.entry.threadId },
      },
    });
    expect(first[2]).toBe('captured-csrf');
    await act(async () => {
      f.visit.setTitle('Must not replace uncertain operands');
      await f.visit.review();
    });
    f.native.readOutlineWindow.mockImplementationOnce(async () => hostedFailure('unavailable', 'Read failed'));
    await ui.click('Recover original append');
    expect(f.native.appendRootChapter.mock.calls[1]![0]).toEqual(first[0]);
    expect(f.native.appendRootChapter.mock.calls[1]![2]).toBe(first[2]);
    expect(ui.host.textContent).toContain('Chapter append acknowledged');
    expect(f.native.readOutlineWindow.mock.calls.at(-1)![0].revision.revisionId).toBe(receipt.revisionId);
    expect(queryByRole(ui.host, 'button', { name: 'Append this saved chapter' })).toBeNull();
    await ui.click('Retry this outline page');
    await act(async () => {
      await f.visit.submit();
      await f.visit.review();
    });
    expect(f.native.appendRootChapter).toHaveBeenCalledTimes(2);
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(3);
    expect(f.readDocument).toHaveBeenCalledTimes(1);
  } finally {
    await ui.close();
  }
});

test('native stale head keeps choice and title, requires explicit refresh and new reviewed intent', async () => {
  const f = await fixture(),
    ui = await mount(f);
  f.native.appendRootChapter.mockImplementationOnce(async () => hostedFailure('stale', 'Head changed'));
  try {
    await ui.select();
    await act(async () => f.visit.setTitle('Keep this chapter title'));
    await ui.click('Review append');
    await ui.click('Append this saved chapter');
    const old = f.native.appendRootChapter.mock.calls[0]![0];
    expect(f.native.readOwn).not.toHaveBeenCalled();
    expect(queryByRole(ui.host, 'button', { name: 'Append this saved chapter' })).toBeNull();
    await ui.click('Refresh current Book head');
    expect(f.native.appendRootChapter).toHaveBeenCalledTimes(1);
    expect((getByRole(ui.host, 'textbox', { name: 'Chapter title' }) as HTMLInputElement).value).toBe(
      'Keep this chapter title',
    );
    expect(f.reader.resume).toHaveBeenCalledTimes(1);
    await ui.click('Review append');
    await ui.click('Append this saved chapter');
    const fresh = f.native.appendRootChapter.mock.calls[1]![0];
    expect(fresh.body).toMatchObject({ expectedRevisionId: id(8), title: old.body.title, target: old.body.target });
    expect(fresh.body.occurrenceId).not.toBe(old.body.occurrenceId);
    expect(fresh.idempotencyKey).not.toBe(old.idempotencyKey);
  } finally {
    await ui.close();
  }
});

test('sparse pages require explicit next, replace rows, and retry the exact failed opaque cursor beyond 511', async () => {
  const f = await fixture(),
    ui = await mount(f);
  try {
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(1);
    f.native.readOutlineWindow.mockImplementationOnce(async () => hostedFailure('unavailable', 'Failed next page'));
    await ui.click('Next outline page');
    expect(f.native.readOutlineWindow.mock.calls[1]![0].cursor).toBe('opaque+/= next');
    await ui.click('Retry this outline page');
    expect(f.native.readOutlineWindow.mock.calls[2]![0]).toEqual(f.native.readOutlineWindow.mock.calls[1]![0]);
    expect(ui.host.textContent).toContain(String(Number.MAX_SAFE_INTEGER));
    expect(ui.host.textContent).toContain('Unavailable placement');
    expect(queryByRole(ui.host, 'button', { name: 'Next outline page' })).toBeNull();
    expect(f.reader.list).not.toHaveBeenCalled();
  } finally {
    await ui.close();
  }
});

test('same-account replacement retires private selection and late command; departure fences late outline', async () => {
  const f = await fixture(),
    ui = await mount(f);
  const pending = deferred<StudioResult<typeof receipt>>();
  f.native.appendRootChapter.mockImplementationOnce(() => pending.promise);
  try {
    await ui.select();
    await ui.click('Review append');
    let command!: Promise<void>;
    await act(async () => {
      command = f.visit.submit();
    });
    await act(async () => f.change());
    expect(ui.host.textContent).toContain('This private visit has ended');
    expect(ui.host.textContent).not.toContain('Selected server body');
    const focus = document.activeElement;
    await act(async () => {
      pending.resolve(ok(receipt));
      await command;
    });
    expect(f.visit.snapshot()).toEqual({ kind: 'ended' });
    expect(f.visit.picker.snapshot()).toEqual({ kind: 'ended' });
    expect(document.activeElement).toBe(focus);
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(1);
  } finally {
    await ui.close();
  }
  const h = await fixture();
  const pendingSelection = deferred<ReturnType<typeof selected>>();
  h.reader.resume.mockImplementationOnce(() => pendingSelection.promise);
  await h.visit.picker.open();
  const selecting = h.visit.select(h.entry.id);
  h.change({ sourceId: 'replacement-source' });
  pendingSelection.resolve(selected(h.entry));
  await selecting;
  expect(h.visit.snapshot()).toEqual({ kind: 'ended' });
  expect(h.readDocument).not.toHaveBeenCalled();
  h.visit.dispose();
  const g = await fixture();
  const state = g.visit.snapshot();
  if (state.kind !== 'active') throw new Error('Missing active visit');
  const pendingPage = deferred<Awaited<ReturnType<typeof g.native.readOutlineWindow>>>();
  g.native.readOutlineWindow.mockImplementationOnce(() => pendingPage.promise);
  const loading = state.outline.load();
  g.visit.dispose();
  pendingPage.resolve(
    ok({
      catalogueId: id(1),
      revisionId: id(4),
      kind: 'structure',
      sourceRevisionId: null,
      items: [],
      nextCursor: null,
    }),
  );
  await loading;
  expect(state.outline.snapshot()).toEqual({ kind: 'ended' });
});

test('receipt-only generated transport sends exact closed body and key without any outline drain, validates external receipts', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let response: unknown = receipt;
  let status = 200;
  const native = createHostedBookNative(
    createKernelClient('https://kernel.test', {
      headers: { authorization: 'Bearer author' },
      fetch: async (input, init) => {
        calls.push({ url: input instanceof Request ? input.url : String(input), init });
        return Response.json(response, { status });
      },
    }),
  );
  const request: HostedRootAppendRequest = {
    catalogueId: id(1),
    expectedViewer: { accountId, authnEpoch: 2 },
    idempotencyKey: crypto.randomUUID(),
    body: {
      expectedRevisionId: id(4),
      occurrenceId: id(5),
      title: 'Exact title',
      target: { threadId: id(6), postId: id(7), revisionId: id(8), sha256: 'a'.repeat(64) },
    },
  };
  const signal = new AbortController().signal;
  expect(await native.appendRootChapter(request, signal)).toEqual(ok(receipt));
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/hostedCatalogues/${id(1)}:appendRootChapter`);
  expect(JSON.parse(calls[0]!.init!.body as string)).toEqual(request.body);
  expect(new Headers(calls[0]!.init?.headers).get('idempotency-key')).toBe(JSON.stringify(request.idempotencyKey));
  expect(calls[0]!.init).toMatchObject({ cache: 'no-store', redirect: 'manual', signal });
  for (response of [{ ...receipt, extra: true }, { ...receipt, catalogueId: id(99) }, { catalogueId: id(1) }])
    expect(await native.appendRootChapter(request, signal)).toMatchObject({ ok: false, error: { kind: 'uncertain' } });
  status = 412;
  expect(await native.appendRootChapter(request, signal)).toMatchObject({ ok: false, error: { kind: 'stale' } });
  const placement = { occurrenceId: id(5), parentId: null, position: 512, title: 'Large address', kind: 'part' };
  expect(v.safeParse(hostedRevise, { expectedRevisionId: id(4), placements: [placement] }).success).toBe(false);
  expect(
    v.safeParse(hostedPage, {
      catalogueId: id(1),
      revisionId: id(4),
      kind: 'structure',
      sourceRevisionId: null,
      items: [{ ...placement, availability: 'available', target: null }],
      nextCursor: null,
    }).success,
  ).toBe(false);
});
