import { afterAll, expect, mock, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type { StudioResult, StudioSelection } from '../src/studio/contract';
import type { HostedBook, HostedBookNative, HostedOwnedBook, HostedRevise } from '../src/studio/hosted-contract';
import type { OwnDraftPageData, OwnDraftReader } from '../src/threads/own-drafts/model';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { accountId, row, selected } from './own-drafts-fixture';
import { installPostReadingDom } from './post-reading-dom';
import { chooseSelect, selectTrigger } from './support/select';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole } = await import('@testing-library/dom');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { StudioController } = await import('../src/studio/controller');
const { HostedDraftPicker } = await import('../src/studio/hosted-draft-picker');
const { HostedDraftPickerView } = await import('../src/studio/hosted-draft-picker-view');
const { BookOrganizer } = await import('../src/studio/book-organizer');
const { openHostedStudio } = await import('../src/studio/hosted-workspace');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const catalogueId = id(1),
  partId = id(2);
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const unused = async (): Promise<StudioResult<never>> => {
  throw new Error('Unexpected write or publication');
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const entry = row({ title: 'Independent chapter' });
  const resume = selected(entry);
  const selection: StudioSelection = {
    revision: {
      exact: { postId: entry.id, revisionId: entry.revisionId, sha256: await editionDocumentDigest(resume.post.body) },
      title: entry.title!,
      body: resume.post.body,
      mediaIds: [],
      savedAt: entry.savedAt,
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const viewer = { accountId, authnEpoch: 2 };
  const page: OwnDraftPageData = { state: 'ready', viewer, drafts: [entry], next: null };
  const reader: OwnDraftReader = { list: mock(async () => page), resume: mock(async () => resume) };
  let book: HostedBook = {
    revision: { catalogueId, revisionId: id(3), kind: 'structure', sourceRevisionId: null },
    placements: [{ occurrenceId: partId, parentId: null, position: 0, title: 'Part One', kind: 'part' }],
  };
  const owner: HostedOwnedBook = {
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    viewer,
    item: {
      catalogueId,
      threadId: id(4),
      postRevisionId: id(5),
      headRevisionId: id(3),
      postVisibility: 'draft',
      publicationId: null,
      createdAt: entry.savedAt,
    },
  };
  const writes: HostedRevise[] = [];
  const native: HostedBookNative = {
    readOwn: async () => ok(owner),
    read: async () => ok(book),
    revise: async (_catalogue, command) => {
      writes.push(structuredClone(command));
      book = { ...book, revision: { ...book.revision, revisionId: id(6) }, placements: command.placements };
      return ok(book);
    },
    create: unused,
    listOwn: unused,
    listHistory: unused,
    publish: unused,
  };
  const readDocument = mock(async (post: string, _signal: AbortSignal): Promise<StudioResult<StudioSelection>> => {
    expect(picker.admitsPost(post)).toBe(true);
    return ok(selection);
  });
  const picker = new HostedDraftPicker({ viewer, reader, source, locale: 'en', isCurrent: () => true, readDocument });
  const bound = await openHostedStudio(
    {
      catalogueId,
      accountId,
      owner,
      native,
      isCurrent: () => picker.isCurrent(),
      input: {
        visitKey: 'saved-draft-picker',
        projectId: catalogueId,
        title: 'Existing Book',
        documents: { items: [], nextCursor: null },
        publications: { items: [], nextCursor: null },
        canCreateDraft: false,
      },
      documents: {
        isCurrent: () => picker.isCurrent(),
        documents: unused,
        createDraft: unused,
        saveDraft: unused,
        versions: unused,
        revision: unused,
        open: ({ postId }, signal) => picker.openDocument(postId, signal),
      },
      resolveTarget: async (document) => {
        const target = picker.target(document);
        return target ? ok(target) : { ok: false, error: { kind: 'denied', message: 'Not admitted' } };
      },
    },
    new AbortController().signal,
  );
  if (!bound.ok) throw new Error(bound.error.message);
  const controller = new StudioController(
    bound.value.workspace.input,
    bound.value.workspace.port,
    bound.value.book,
    true,
  );
  const disconnect = controller.connect(),
    stopPicker = picker.connect();
  return {
    entry,
    resume,
    selection,
    page,
    reader,
    picker,
    readDocument,
    controller,
    writes,
    book: () => book,
    replace: () => {
      observation = { ...observation, generation: observation.generation + 1 };
      for (const listener of listeners) listener();
    },
    close: () => {
      disconnect();
      stopPicker();
      picker.dispose();
    },
  };
}

async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  let opening: Promise<boolean> | undefined;
  function View() {
    const state = useSyncExternalStore(f.controller.subscribe, f.controller.snapshot);
    const disabled = Boolean(
      state.busy || state.selected?.dirty || state.selected?.snapshotPending || state.selected?.uploading,
    );
    return (
      <>
        <HostedDraftPickerView
          picker={f.picker}
          disabled={disabled}
          onSelect={(post) => {
            opening = f.controller.open(post);
          }}
        />
        <BookOrganizer controller={f.controller} state={state} onOpen={(post) => void f.controller.open(post)} />
      </>
    );
  }
  await act(async () => root.render(<View />));
  return {
    host,
    button: (name: string) => getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement,
    click: async (name: string) =>
      act(async () => {
        (getByRole(host, 'button', { name, exact: true }) as HTMLButtonElement).click();
        await opening;
      }),
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      f.close();
    },
  };
}

test('mounted picker opens an independently saved exact draft; only explicit nested placement revises the Book', async () => {
  const f = await fixture(),
    ui = await mount(f);
  const before = structuredClone(f.book());
  try {
    expect(f.reader.list).not.toHaveBeenCalled();
    await ui.click('Open a saved account draft');
    expect(f.reader.resume).not.toHaveBeenCalled();
    expect(f.readDocument).not.toHaveBeenCalled();
    expect(f.reader.list).toHaveBeenCalledWith(f.page.viewer, expect.any(AbortSignal));
    await ui.click('Independent chapter');
    expect(f.reader.resume).toHaveBeenCalledWith(
      { ...f.page.viewer, id: f.entry.id, threadId: f.entry.threadId },
      expect.any(AbortSignal),
    );
    expect(f.controller.snapshot().selected?.source.revision.exact).toEqual(f.selection.revision.exact);
    expect(f.picker.snapshot().kind).toBe('closed');
    expect(f.book()).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.controller.snapshot().currentBookPublication).toBeNull();
    const disclosure = ui.host.querySelector<HTMLDetailsElement>('.studio-placement-form')!;
    disclosure.open = true;
    const form = disclosure.querySelector('form')!;
    expect(form.textContent).toContain('Independent chapter');
    await chooseSelect(selectTrigger(form, 1), partId);
    await act(async () => {
      const title = form.querySelector<HTMLInputElement>('input[required]')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'Chapter One');
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await ui.click('Add chapter');
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      expectedRevisionId: before.revision.revisionId,
      placements: [
        before.placements[0],
        {
          kind: 'chapter',
          parentId: partId,
          position: 0,
          title: 'Chapter One',
          target: { ...f.selection.revision.exact, threadId: f.entry.threadId },
        },
      ],
    });
    expect(f.controller.snapshot().currentBookPublication).toBeNull();
  } finally {
    await ui.close();
  }
});

test('one replacing picker page preserves sparse continuation and exact retry, retires late rows and returns focus', async () => {
  const f = await fixture(),
    ui = await mount(f);
  const pending = deferred<OwnDraftPageData>();
  const calls: Array<string | undefined> = [];
  let requests = 0;
  f.reader.list = async (request) => {
    calls.push(request.cursor);
    if (++requests === 1) return { ...f.page, drafts: [], state: 'preparing', next: 'opaque+/=' };
    if (requests === 2) return 'unavailable';
    if (requests === 3) return f.page;
    return pending.promise;
  };
  try {
    await ui.click('Open a saved account draft');
    expect(ui.host.textContent).toContain('still preparing');
    await ui.click('Next drafts');
    expect(ui.host.textContent).not.toContain('Independent chapter');
    await ui.click('Retry this page');
    expect(calls).toEqual([undefined, 'opaque+/=', 'opaque+/=']);
    expect(ui.host.textContent).toContain('Independent chapter');
    await ui.click('Restart inventory');
    expect(ui.host.textContent).not.toContain('Independent chapter');
    await ui.click('Cancel');
    expect(document.activeElement).toBe(ui.button('Open a saved account draft'));
    await act(async () => pending.resolve(f.page));
    expect(f.picker.snapshot().kind).toBe('closed');
    expect(ui.host.textContent).not.toContain('Independent chapter');
    expect(f.reader.resume).not.toHaveBeenCalled();
  } finally {
    await ui.close();
  }
});

test('foreign rows, changed revisions, mismatched exact heads and dirty editor text never become placed candidates', async () => {
  for (const change of ['foreign', 'reply', 'revision', 'thread', 'digest', 'head', 'denied', 'epoch'] as const) {
    const f = await fixture();
    try {
      if (change === 'foreign') f.reader.list = async () => ({ ...f.page, drafts: [{ ...f.entry, authorId: id(99) }] });
      if (change === 'reply')
        f.reader.list = async () => ({ ...f.page, drafts: [{ ...f.entry, documentKind: 'reply' }] });
      if (change === 'epoch') f.reader.list = async () => ({ ...f.page, viewer: { ...f.page.viewer, authnEpoch: 3 } });
      if (change === 'revision') f.reader.resume = async () => ({ ...f.resume, revision: id(99) });
      if (change === 'thread')
        f.reader.resume = async () => ({ ...f.resume, post: { ...f.resume.post, threadId: id(99) } });
      if (change === 'denied') f.reader.resume = async () => 'denied';
      if (change === 'head')
        f.readDocument.mockImplementation(async () =>
          ok({ ...f.selection, native: { ...f.selection.native!, boardId: id(99) } }),
        );
      if (change === 'digest')
        f.readDocument.mockImplementation(async () =>
          ok({
            ...f.selection,
            revision: { ...f.selection.revision, exact: { ...f.selection.revision.exact, sha256: '0'.repeat(64) } },
          }),
        );
      await f.picker.open();
      expect(await f.controller.open(f.entry.id)).toBe(false);
      expect(f.controller.snapshot().selected).toBeNull();
      expect(f.writes).toEqual([]);
      f.picker.retainSelection(f.controller.snapshot().selected?.source ?? null);
      expect(f.picker.target(f.selection.revision.exact)).toBeNull();
    } finally {
      f.close();
    }
  }
  const f = await fixture(),
    ui = await mount(f);
  try {
    await ui.click('Open a saved account draft');
    await ui.click('Independent chapter');
    await act(async () => f.controller.changeTitle('Unsaved title'));
    expect(ui.button('Open a saved account draft').disabled).toBe(true);
    expect(await f.controller.open(id(99))).toBe(false);
    expect(f.controller.snapshot().selected?.title).toBe('Unsaved title');
    expect(f.writes).toEqual([]);
  } finally {
    await ui.close();
  }
});

test('same-account replacement, cancellation and departure abort selected reads and fence late pages or bodies', async () => {
  for (const phase of ['page', 'resume', 'head', 'close', 'departure'] as const) {
    const f = await fixture();
    const page = deferred<OwnDraftPageData>();
    const resume = deferred<typeof f.resume>();
    const head = deferred<StudioResult<StudioSelection>>();
    let signal: AbortSignal | undefined;
    let running: Promise<unknown>;
    try {
      if (phase === 'page') {
        f.reader.list = async (_request, abort) => {
          signal = abort;
          return page.promise;
        };
        running = f.picker.open();
      } else {
        await f.picker.open();
        if (phase === 'head')
          f.readDocument.mockImplementation(async (_post, abort) => {
            signal = abort;
            return head.promise;
          });
        else
          f.reader.resume = async (_request, abort) => {
            signal = abort;
            return resume.promise;
          };
        running = f.controller.open(f.entry.id);
        await new Promise((done) => setTimeout(done, 0));
      }
      if (phase === 'close') f.picker.close();
      else if (phase === 'departure') f.picker.dispose();
      else f.replace();
      expect(signal?.aborted).toBe(true);
      page.resolve(f.page);
      resume.resolve(f.resume);
      head.resolve(ok(f.selection));
      await running;
      expect(f.controller.snapshot().selected).toBeNull();
      expect(f.picker.admitsPost(f.entry.id)).toBe(false);
      expect(f.picker.snapshot().kind).toBe(phase === 'close' ? 'closed' : 'ended');
      expect(f.writes).toEqual([]);
    } finally {
      f.close();
    }
  }
});

test('only the selected unplaced candidate and attached document summaries survive later choices', async () => {
  const f = await fixture();
  try {
    await f.picker.open();
    expect(await f.controller.open(f.entry.id)).toBe(true);
    expect(
      await f.controller.organize({
        kind: 'insert',
        parentOccurrenceId: null,
        beforeOccurrenceId: null,
        title: 'Root chapter',
        target: { kind: 'chapter', document: f.selection.revision.exact },
      }),
    ).toBe(true);
    for (const number of [20, 30]) {
      const entry = row({
        id: id(number),
        firstPostId: id(number),
        threadId: id(number + 1),
        title: `Draft ${number}`,
        actions: {
          ...f.entry.actions,
          resume: `/v1/accounts/${accountId}/drafts/${id(number)}?threadId=${id(number + 1)}`,
        },
      });
      f.reader.list = async () => ({ ...f.page, drafts: [entry] });
      f.reader.resume = async () => selected(entry);
      f.readDocument.mockImplementation(async () =>
        ok({
          ...f.selection,
          revision: {
            ...f.selection.revision,
            title: entry.title!,
            exact: { ...f.selection.revision.exact, postId: entry.id },
          },
          native: { ...f.selection.native!, threadId: entry.threadId },
        }),
      );
      await f.picker.open();
      expect(await f.controller.open(entry.id)).toBe(true);
      expect(f.controller.snapshot().documents.items.map((item) => item.postId)).toEqual([entry.id, f.entry.id]);
      expect(f.picker.target(f.selection.revision.exact)).toBeNull();
    }
    expect(f.picker.admitsPost(id(20))).toBe(false);
    const chapter = f.controller
      .snapshot()
      .structure!.placements.find((placement) => placement.target.kind === 'chapter')!;
    expect(await f.controller.organize({ kind: 'remove', occurrenceId: chapter.occurrenceId })).toBe(true);
    expect(f.controller.snapshot().documents.items.map((item) => item.postId)).toEqual([id(30)]);
  } finally {
    f.close();
  }
});
