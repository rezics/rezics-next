import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import type { StudioResult, StudioSelection } from '../src/studio/contract';
import type {
  HostedDraftPointRequest,
  HostedOwnedBook,
  HostedOutlineWindowRequest,
  HostedOutlineWindowPage,
} from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { accountId, row, selected } from './own-drafts-fixture';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { HostedDraftPicker } = await import('../src/studio/hosted-draft-picker');
const { HostedDraftPointVisit, draftPointReady } = await import('../src/studio/hosted-draft-points');
const { HostedDraftPointView } = await import('../src/studio/hosted-draft-point-view');
const { createHostedBookNative, hostedFailure } = await import('../src/studio/hosted-native');
const { HostedInventoryVisit } = await import('../src/studio/hosted-inventory');
const { HostedBookInventory } = await import('../src/studio/workspace');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const receipt = { catalogueId: id(1), revisionId: id(9) };
const part = {
  occurrenceId: id(20),
  parentId: null,
  position: 0,
  kind: 'part' as const,
  availability: 'available' as const,
  title: 'Part One',
  target: null,
};
const chapter = {
  ...part,
  occurrenceId: id(22),
  parentId: part.occurrenceId,
  position: 1,
  kind: 'chapter' as const,
  title: 'Existing chapter',
  target: { threadId: id(30), postId: id(31), revisionId: id(32), sha256: 'b'.repeat(64) },
};
const sibling = { ...part, occurrenceId: id(21), parentId: part.occurrenceId, title: 'Nested sibling' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const entry = row({ title: 'Exact saved chapter' });
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
    sourceId: 'session',
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
    id: 'session',
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
  const readVersion = mock(async (_selection: StudioSelection, _signal: AbortSignal) => ok(selection.revision));
  const picker = new HostedDraftPicker({
    viewer: owner.viewer,
    source,
    reader,
    locale: 'en',
    isCurrent: () => true,
    readDocument,
  });
  const native = {
    writeDraftPoint: mock(
      async (
        _request: HostedDraftPointRequest,
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
        ok({ ...revision, items: cursor ? [] : [part, sibling, chapter], nextCursor: cursor ? null : 'opaque+/=next' }),
    ),
  };
  const visit = new HostedDraftPointVisit({
    owner,
    source,
    picker,
    locale: 'en',
    csrfToken: 'original-csrf',
    native,
    readVersion,
  });
  return {
    entry,
    selection,
    reader,
    readDocument,
    readVersion,
    owner,
    source,
    native,
    visit,
    change(change: Partial<HistoricalReaderObservation> = { generation: 2 }) {
      observation = { ...observation, ...change };
      for (const listener of listeners) listener();
    },
  };
}
function active(f: Awaited<ReturnType<typeof fixture>>) {
  const state = f.visit.snapshot();
  if (state.kind !== 'active') throw new Error('Missing visit');
  return state;
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => {
    root.render(<HostedDraftPointView visit={f.visit} locale="en" />);
    await active(f).outline.load();
  });
  return {
    host,
    click: async (name: string) =>
      act(async () => {
        (getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement).click();
      }),
    async close() {
      await act(async () => {
        root.unmount();
        f.visit.dispose();
      });
      host.remove();
    },
  };
}

test('owned entry opens bounded editing; mounted nested chapter review freezes exact body/version and stable anchors', async () => {
  const f = await fixture();
  const inventory = new HostedInventoryVisit(
    { listOwn: async () => ok({ ...f.owner, items: [f.owner.item], nextCursor: null }) },
    f.source,
    accountId,
  );
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host);
  await act(async () => {
    await inventory.load();
    root.render(<HostedBookInventory visit={inventory} locale="en" />);
  });
  expect((getByRole(host, 'link', { name: 'Edit at outline anchors' }) as HTMLAnchorElement).href).toContain(
    'points=1',
  );
  expect(f.readDocument).not.toHaveBeenCalled();
  expect(f.native.readOutlineWindow).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  inventory.dispose();
  host.remove();
  const ui = await mount(f);
  try {
    expect(queryByRole(ui.host, 'button', { name: 'Use Existing chapter as parent' })).toBeNull();
    await act(async () => f.visit.observe(chapter.occurrenceId, 'parent'));
    expect(active(f).choice.parent).toBeNull();
    await ui.click('Use Part One as parent');
    await ui.click('Insert before Nested sibling');
    await ui.click('Insert saved chapter');
    await ui.click('Open a saved account draft');
    expect(f.readDocument).not.toHaveBeenCalled();
    await ui.click('Exact saved chapter');
    expect(ui.host.textContent).toContain('Selected server body');
    expect(ui.host.textContent).toContain(f.selection.revision.exact.sha256);
    await ui.click('Review edit');
    const intent = active(f).intent!;
    expect(intent.request).toMatchObject({
      kind: 'insert',
      catalogueId: id(1),
      body: {
        expectedRevisionId: id(4),
        parentId: part.occurrenceId,
        beforeOccurrenceId: sibling.occurrenceId,
        title: 'Exact saved chapter',
        placement: { kind: 'chapter', target: { ...f.selection.revision.exact, threadId: f.entry.threadId } },
      },
    });
    expect(document.activeElement?.textContent).toBe('Review edit');
    await ui.click('Save reviewed edit');
    expect(f.native.writeDraftPoint.mock.calls[0]![0]).toBe(intent.request);
    expect(f.native.writeDraftPoint.mock.calls[0]![2]).toBe('original-csrf');
    expect(active(f).receipt).toEqual(receipt);
    expect(f.native.readOutlineWindow.mock.calls.at(-1)![0].revision.revisionId).toBe(receipt.revisionId);
  } finally {
    await ui.close();
  }
});

test('part/end insert and subtree removal use distinct exact commands; removal does not scan descendants', async () => {
  const f = await fixture();
  await active(f).outline.load();
  f.visit.observe(part.occurrenceId, 'parent');
  f.visit.setTitle('New part');
  await f.visit.review();
  expect(active(f).intent!.request).toMatchObject({
    kind: 'insert',
    body: { parentId: part.occurrenceId, beforeOccurrenceId: null, placement: { kind: 'part' } },
  });
  f.visit.cancelReview();
  f.visit.observe(part.occurrenceId, 'removal');
  const ui = await mount(f);
  try {
    expect(ui.host.textContent).toContain('everything beneath it');
    expect(ui.host.textContent).toContain('No descendant count has been loaded');
    await ui.click('Review edit');
    await ui.click('Save reviewed edit');
    expect(f.native.writeDraftPoint.mock.calls[0]![0]).toMatchObject({
      kind: 'remove',
      body: { expectedRevisionId: id(4), occurrenceId: part.occurrenceId },
    });
    expect(Object.keys(f.native.writeDraftPoint.mock.calls[0]![0].body).sort()).toEqual([
      'expectedRevisionId',
      'occurrenceId',
    ]);
    expect(f.readDocument).not.toHaveBeenCalled();
    expect(f.reader.list).not.toHaveBeenCalled();
  } finally {
    await ui.close();
  }
});

test('unknown replay keeps original key and intent; historical acknowledgement survives failed readback and retries its cursor', async () => {
  const f = await fixture();
  const ui = await mount(f);
  try {
    await act(async () => {
      f.visit.setTitle('Part');
      await f.visit.review();
    });
    const intent = active(f).intent!;
    f.native.writeDraftPoint.mockImplementationOnce(async () => hostedFailure('uncertain', 'Unknown'));
    await ui.click('Save reviewed edit');
    expect(queryByRole(ui.host, 'button', { name: 'Review edit' })).toBeNull();
    f.native.readOutlineWindow.mockImplementationOnce(async () => hostedFailure('unavailable', 'Read failed'));
    await ui.click('Recover original edit');
    expect(f.native.writeDraftPoint.mock.calls.map(([request]) => request)).toEqual([intent.request, intent.request]);
    expect(active(f).phase).toBe('acknowledged');
    expect(ui.host.textContent).toContain(receipt.revisionId);
    await ui.click('Retry this outline page');
    await ui.click('Next outline page');
    expect(active(f).outline.snapshot()).toMatchObject({ kind: 'ready', cursor: 'opaque+/=next', page: { items: [] } });
    expect(f.native.readOutlineWindow.mock.calls.at(-1)![0]).toEqual({
      revision: { ...receipt, kind: 'structure', sourceRevisionId: null },
      cursor: 'opaque+/=next',
    });
    expect(f.native.writeDraftPoint).toHaveBeenCalledTimes(2);
    expect(f.native.readOwn).not.toHaveBeenCalled();
  } finally {
    await ui.close();
  }
});

test('stale recovery preserves choices but requires fresh anchor observation and original saved-version reread before a new key', async () => {
  const f = await fixture();
  await active(f).outline.load();
  f.visit.observe(part.occurrenceId, 'parent');
  f.visit.observe(sibling.occurrenceId, 'before');
  f.visit.setKind('chapter');
  await f.visit.picker.open();
  await f.visit.select(f.entry.id);
  f.visit.setTitle('My chapter title');
  await f.visit.review();
  const first = active(f).intent!.request;
  f.native.writeDraftPoint.mockImplementationOnce(async () => hostedFailure('stale', 'Changed'));
  await f.visit.submit();
  await f.visit.refreshHead();
  expect(active(f)).toMatchObject({
    head: id(8),
    title: 'My chapter title',
    selection: f.selection,
    choice: { parent: { revisionId: id(4) }, before: { revisionId: id(4) } },
    intent: null,
  });
  expect(draftPointReady(active(f))).toBe(false);
  f.visit.observe(part.occurrenceId, 'parent');
  f.visit.observe(sibling.occurrenceId, 'before');
  expect(draftPointReady(active(f))).toBe(false);
  await f.visit.rereadVersion();
  await f.visit.review();
  const next = active(f).intent!.request;
  expect(f.readVersion.mock.calls[0]![0].revision.exact).toEqual(f.selection.revision.exact);
  expect(f.readDocument).toHaveBeenCalledTimes(1);
  expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(next.body.occurrenceId).not.toBe(first.body.occurrenceId);
  expect(next.body.expectedRevisionId).toBe(id(8));
  expect(next.kind === 'insert' && next.body.placement).toEqual(first.kind === 'insert' && first.body.placement);
  f.visit.dispose();
});

test('same-cursor retry never drains or refills sparse pages; chapters cannot parent; session and departure fence late results and focus', async () => {
  const f = await fixture();
  const ui = await mount(f);
  try {
    f.native.readOutlineWindow.mockImplementationOnce(async () => hostedFailure('unavailable', 'Read failed'));
    await ui.click('Next outline page');
    await ui.click('Retry this outline page');
    expect(f.native.readOutlineWindow.mock.calls.slice(-2).map(([r]) => r.cursor)).toEqual([
      'opaque+/=next',
      'opaque+/=next',
    ]);
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(3);
    await ui.click('Return to first outline page');
    await act(async () => {
      f.visit.observe(part.occurrenceId, 'removal');
      await f.visit.review();
    });
    const pending = deferred<StudioResult<typeof receipt>>();
    f.native.writeDraftPoint.mockImplementationOnce(() => pending.promise);
    let command!: Promise<void>;
    await act(async () => {
      command = f.visit.submit();
    });
    await act(async () => f.change());
    const focus = document.activeElement;
    await act(async () => {
      pending.resolve(ok(receipt));
      await command;
    });
    expect(f.visit.snapshot()).toEqual({ kind: 'ended' });
    expect(document.activeElement).toBe(focus);
    expect(f.visit.picker.snapshot()).toEqual({ kind: 'ended' });
    expect(ui.host.textContent).not.toContain('Part One');
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(4);
  } finally {
    await ui.close();
  }
  const g = await fixture();
  await g.visit.picker.open();
  const pending = deferred<ReturnType<typeof selected>>();
  g.reader.resume.mockImplementationOnce(() => pending.promise);
  const selecting = g.visit.select(g.entry.id);
  g.visit.dispose();
  pending.resolve(selected(g.entry));
  await selecting;
  expect(g.readDocument).not.toHaveBeenCalled();
  expect(g.visit.snapshot()).toEqual({ kind: 'ended' });
});

test('generated HTTP insert/remove/move methods send exact bounded operands and validate external receipts without outline reads', async () => {
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
  const base = {
    catalogueId: id(1),
    expectedViewer: { accountId, authnEpoch: 2 },
    idempotencyKey: crypto.randomUUID(),
  };
  const insert: HostedDraftPointRequest = {
    ...base,
    kind: 'insert',
    body: {
      expectedRevisionId: id(4),
      occurrenceId: id(5),
      parentId: id(20),
      beforeOccurrenceId: id(21),
      title: 'Exact',
      placement: {
        kind: 'chapter',
        target: { threadId: id(6), postId: id(7), revisionId: id(8), sha256: 'a'.repeat(64) },
      },
    },
  };
  const remove: HostedDraftPointRequest = {
    ...base,
    idempotencyKey: crypto.randomUUID(),
    kind: 'remove',
    body: { expectedRevisionId: id(4), occurrenceId: id(20) },
  };
  const signal = new AbortController().signal;
  const move: HostedDraftPointRequest = {
    ...base,
    idempotencyKey: crypto.randomUUID(),
    kind: 'move',
    body: {
      expectedRevisionId: id(4),
      occurrenceId: chapter.occurrenceId,
      parentId: null,
      beforeOccurrenceId: part.occurrenceId,
    },
  };
  for (const request of [insert, remove, move]) {
    expect(await native.writeDraftPoint(request, signal)).toEqual(ok(receipt));
    const call = calls.at(-1)!;
    expect(new URL(call.url).pathname).toBe(`/v1/hostedCatalogues/${id(1)}:${request.kind}DraftPoint`);
    expect(JSON.parse(call.init!.body as string)).toEqual(request.body);
    expect(new Headers(call.init?.headers).get('idempotency-key')).toBe(JSON.stringify(request.idempotencyKey));
    expect(call.init).toMatchObject({ cache: 'no-store', redirect: 'manual', signal });
  }
  expect(calls).toHaveLength(3);
  response = { ...receipt, catalogueId: id(99) };
  expect(await native.writeDraftPoint(insert, signal)).toMatchObject({ ok: false, error: { kind: 'uncertain' } });
  status = 412;
  expect(await native.writeDraftPoint(remove, signal)).toMatchObject({ ok: false, error: { kind: 'stale' } });
  status = 422;
  expect(await native.writeDraftPoint(move, signal)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
});

function movePages(f: Awaited<ReturnType<typeof fixture>>) {
  f.native.readOutlineWindow.mockImplementation(
    async ({ revision, cursor }): Promise<StudioResult<HostedOutlineWindowPage>> =>
      ok({
        ...revision,
        items:
          cursor === 'move-before+/='
            ? [{ ...sibling, position: Number.MAX_SAFE_INTEGER }]
            : cursor === 'move-parent+/='
              ? [{ ...part, parentId: id(99), position: 600_000 }]
              : [
                  { ...chapter, position: 4_294_967_296 },
                  { ...chapter, occurrenceId: id(40), title: 'Another occurrence of the same saved chapter' },
                  {
                    occurrenceId: id(41),
                    parentId: null,
                    position: 900_000,
                    kind: 'part',
                    availability: 'unavailable',
                  },
                ],
        nextCursor:
          cursor === 'move-before+/=' ? null : cursor === 'move-parent+/=' ? 'move-before+/=' : 'move-parent+/=',
      }),
  );
}

async function selectMove(f: Awaited<ReturnType<typeof fixture>>) {
  movePages(f);
  await active(f).outline.load();
  f.visit.observe(chapter.occurrenceId, 'move');
  await active(f).outline.next();
  f.visit.observe(part.occurrenceId, 'parent');
  await active(f).outline.next();
  f.visit.observe(sibling.occurrenceId, 'before');
}

test('mounted move retains exact cross-page source and destination, displays supplied nesting and large positions, and offers root/end', async () => {
  const f = await fixture();
  movePages(f);
  const ui = await mount(f);
  try {
    await act(async () => f.visit.observe(id(41), 'move'));
    expect(active(f).choice.move).toBeNull();
    await ui.click('Move Existing chapter');
    await ui.click('Next outline page');
    expect(getByRole(ui.host, 'list').textContent).not.toContain(chapter.title);
    expect(ui.host.textContent).toContain(chapter.title);
    expect(ui.host.textContent).toContain(id(99));
    await ui.click('Use Part One as parent');
    await ui.click('Next outline page');
    expect(getByRole(ui.host, 'list').textContent).not.toContain(part.title);
    expect(ui.host.textContent).toContain('9,007,199,254,740,991');
    await ui.click('Move before Nested sibling');
    expect(queryByRole(ui.host, 'textbox')).toBeNull();
    await ui.click('Review edit');
    const original = active(f).intent!.request;
    expect(original).toMatchObject({
      catalogueId: id(1),
      kind: 'move',
      expectedViewer: f.owner.viewer,
      body: {
        expectedRevisionId: id(4),
        occurrenceId: chapter.occurrenceId,
        parentId: part.occurrenceId,
        beforeOccurrenceId: sibling.occurrenceId,
      },
    });
    expect(Object.keys(original.body).sort()).toEqual([
      'beforeOccurrenceId',
      'expectedRevisionId',
      'occurrenceId',
      'parentId',
    ]);
    expect(active(f).choice.move!.item.title).toBe(chapter.title);
    expect(active(f).choice.parent!.item.title).toBe(part.title);
    expect(document.activeElement?.textContent).toBe('Review edit');
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(3);
    expect(f.native.readOwn).not.toHaveBeenCalled();
    expect(f.readDocument).not.toHaveBeenCalled();
    expect(f.reader.list).not.toHaveBeenCalled();
    await ui.click('Edit review');
    expect(document.activeElement?.textContent).toBe('Choose an edit');
    await ui.click('Book root');
    await ui.click('At parent’s end');
    await ui.click('Review edit');
    expect(active(f).intent!.request).toMatchObject({
      kind: 'move',
      body: { occurrenceId: chapter.occurrenceId, parentId: null, beforeOccurrenceId: null },
    });
    expect(active(f).intent!.request.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(3);
  } finally {
    await ui.close();
  }
});

test('stale move retains all choices even at the same head and requires each current observation and a fresh review', async () => {
  const f = await fixture();
  await selectMove(f);
  await f.visit.review();
  const original = active(f).intent!.request;
  f.native.writeDraftPoint.mockImplementationOnce(async () => hostedFailure('stale', 'Changed'));
  f.native.readOwn.mockImplementationOnce(async () => ok(f.owner));
  await f.visit.submit();
  await f.visit.refreshHead();
  expect(active(f)).toMatchObject({
    head: id(4),
    intent: null,
    choice: {
      kind: 'move',
      move: { confirmed: false, revisionId: id(4), item: { occurrenceId: chapter.occurrenceId, title: chapter.title } },
      parent: { confirmed: false, revisionId: id(4), item: { occurrenceId: part.occurrenceId, title: part.title } },
      before: {
        confirmed: false,
        revisionId: id(4),
        item: { occurrenceId: sibling.occurrenceId, title: sibling.title },
      },
    },
  });
  expect(draftPointReady(active(f))).toBe(false);
  await f.visit.review();
  expect(active(f).intent).toBeNull();
  // A hidden ID cannot become observed just because it was retained from another page.
  f.visit.observe(part.occurrenceId, 'parent');
  expect(active(f).choice.parent!.confirmed).toBe(false);
  f.visit.observe(chapter.occurrenceId, 'move');
  await active(f).outline.next();
  f.visit.observe(part.occurrenceId, 'parent');
  expect(active(f).choice.before!.item.occurrenceId).toBe(sibling.occurrenceId);
  expect(draftPointReady(active(f))).toBe(false);
  await active(f).outline.next();
  f.visit.observe(sibling.occurrenceId, 'before');
  expect(draftPointReady(active(f))).toBe(true);
  await f.visit.review();
  expect(active(f).intent!.request.body).toEqual(original.body);
  expect(active(f).intent!.request.idempotencyKey).not.toBe(original.idempotencyKey);
  expect(f.native.writeDraftPoint).toHaveBeenCalledTimes(1);
  expect(f.readVersion).not.toHaveBeenCalled();
  f.visit.dispose();
});

test('unknown move replays the frozen sender, operands, key and credential; failed exact readback retries only the read', async () => {
  const f = await fixture();
  await selectMove(f);
  await f.visit.review();
  const intent = active(f).intent!;
  const sender = f.native.writeDraftPoint;
  sender.mockImplementationOnce(async () => hostedFailure('uncertain', 'Unknown'));
  const replacement = mock(async (_request: HostedDraftPointRequest, _signal: AbortSignal, _csrf?: string) =>
    ok(receipt),
  );
  f.native.writeDraftPoint = replacement;
  await f.visit.submit();
  f.visit.root();
  f.visit.end();
  f.visit.setKind('remove');
  await f.visit.review();
  expect(active(f).intent).toBe(intent);
  f.native.readOutlineWindow.mockImplementationOnce(async () => hostedFailure('unavailable', 'Read failed'));
  await f.visit.submit();
  expect(sender.mock.calls.map(([request, , csrf]) => [request, csrf])).toEqual([
    [intent.request, 'original-csrf'],
    [intent.request, 'original-csrf'],
  ]);
  expect(sender.mock.calls[1]![0]).toBe(intent.request);
  expect(replacement).not.toHaveBeenCalled();
  expect(active(f)).toMatchObject({ phase: 'acknowledged', receipt, head: receipt.revisionId });
  expect(active(f).outline.snapshot().kind).toBe('failed');
  await active(f).outline.load();
  expect(f.native.readOutlineWindow.mock.calls.slice(-2).map(([request]) => request)).toEqual([
    { revision: { ...receipt, kind: 'structure', sourceRevisionId: null }, cursor: null },
    { revision: { ...receipt, kind: 'structure', sourceRevisionId: null }, cursor: null },
  ]);
  await f.visit.submit();
  expect(sender).toHaveBeenCalledTimes(2);
  expect(f.native.readOwn).not.toHaveBeenCalled();
  f.visit.dispose();
});

test('late move feedback respects focus elsewhere; session replacement retires a pending move and its retained anchors', async () => {
  const f = await fixture();
  const ui = await mount(f);
  const elsewhere = document.body.appendChild(document.createElement('button'));
  elsewhere.textContent = 'Elsewhere';
  try {
    await ui.click('Move Part One');
    await ui.click('Review edit');
    const pending = deferred<StudioResult<typeof receipt>>();
    f.native.writeDraftPoint.mockImplementationOnce(() => pending.promise);
    await ui.click('Save reviewed edit');
    elsewhere.focus();
    await act(async () => pending.resolve(hostedFailure('uncertain', 'Unknown')));
    expect(document.activeElement).toBe(elsewhere);
    const replay = deferred<StudioResult<typeof receipt>>();
    f.native.writeDraftPoint.mockImplementationOnce(() => replay.promise);
    await ui.click('Recover original edit');
    const signal = f.native.writeDraftPoint.mock.calls.at(-1)![1];
    await act(async () => f.change());
    expect(signal.aborted).toBe(true);
    await act(async () => replay.resolve(ok(receipt)));
    expect(document.activeElement).toBe(elsewhere);
    expect(f.visit.snapshot()).toEqual({ kind: 'ended' });
    expect(ui.host.textContent).not.toContain(part.title);
    expect(f.native.readOutlineWindow).toHaveBeenCalledTimes(1);
  } finally {
    elsewhere.remove();
    await ui.close();
  }
});
