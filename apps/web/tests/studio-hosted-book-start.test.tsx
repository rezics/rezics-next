import { afterAll, expect, test } from 'bun:test';
import { act, createElement, useSyncExternalStore } from 'react';
import { fromPlainText } from '@rezics/document';
import { StudioController } from '../src/studio/controller';
import type { StudioPort, StudioResult, StudioSelection } from '../src/studio/contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedBookStart, savedOpeningForBook } from '../src/studio/hosted-book-start';
import type { HostedBook, HostedBookNative, HostedCreate, HostedOwnedBook } from '../src/studio/hosted-contract';
import { HostedBookAdapter } from '../src/studio/hosted-adapter';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { HostedBookStartAction } = await import('../src/studio/hosted-book-start-action');
afterAll(() => dom.restore());
const id = (value: number) => `00000000-0000-8000-8000-${String(value).padStart(12, '0')}`;
const accountId = id(1),
  postId = id(2),
  threadId = id(3),
  revisionId = id(4),
  headId = id(5);
const key = '00000000-0000-4000-8000-000000000006';
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const fail = (kind: 'uncertain' | 'unavailable' | 'stale' | 'denied'): StudioResult<never> => ({
  ok: false,
  error: { kind, message: kind },
});
const opening: StudioSelection = {
  revision: {
    exact: { postId, revisionId, sha256: 'a'.repeat(64) },
    title: 'Opening',
    body: fromPlainText('Saved opening', 'blocks'),
    mediaIds: [],
    savedAt: '2026-11-13T00:00:00Z',
  },
  visibility: 'draft',
  permissions: { edit: true, publish: true },
  native: { threadId, boardId: id(7), licence: 'CC-BY-4.0', subjectIds: [] },
};
const empty: HostedBook = {
  revision: { catalogueId: postId, revisionId: headId, kind: 'structure', sourceRevisionId: null },
  placements: [],
};
const owner: HostedOwnedBook = {
  scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
  viewer: { accountId, authnEpoch: 9 },
  item: {
    catalogueId: postId,
    threadId,
    createdAt: '2026-11-13T00:00:00Z',
    postRevisionId: revisionId,
    postVisibility: 'draft',
    headRevisionId: headId,
    publicationId: null,
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
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
  const creates: Array<{ body: HostedCreate; key: string }> = [];
  const reads: Array<Parameters<HostedBookNative['readOwn']>> = [];
  const hrefs: string[] = [];
  const native: HostedBookNative = {
    create: async (body, key) => {
      creates.push({ body: structuredClone(body), key });
      return ok(empty);
    },
    readOwn: async (...args) => {
      reads.push(args);
      return ok(owner);
    },
    read: async () => ok(empty),
    revise: async () => fail('unavailable'),
    publish: async () => fail('unavailable'),
    listOwn: async () => fail('unavailable'),
    listHistory: async () => fail('unavailable'),
  };
  let selected: StudioSelection | null = opening;
  const binding = {
    native,
    source,
    viewer: owner.viewer,
    isCurrent: () => true,
    navigate: (href: string) => {
      hrefs.push(href);
    },
  };
  const starter = new HostedBookStart(
    binding,
    () => selected,
    () => key,
  );
  const disconnect = starter.connect();
  return {
    native,
    creates,
    reads,
    hrefs,
    starter,
    disconnect,
    select: (value: StudioSelection | null) => {
      selected = value;
    },
    replace: (patch: Partial<HistoricalReaderObservation> = {}) => {
      observation = { ...observation, generation: observation.generation + 1, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

test('only a saved clean editable native opening can offer Book start; article edits are retained', () => {
  const unused = async () => fail('unavailable');
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unused,
    open: unused,
    createDraft: unused,
    saveDraft: unused,
    versions: unused,
    revision: unused,
    reviewPublication: unused,
    publish: unused,
    publications: unused,
  };
  const input = {
    visitKey: 'account',
    projectId: accountId,
    title: 'Drafts',
    profile: { kind: 'articles' as const, seriesTitle: null },
    documents: { items: [], nextCursor: null },
    publications: { items: [], nextCursor: null },
    canCreateDraft: true,
    canPublish: true,
  };
  expect(savedOpeningForBook(new StudioController(input, port).snapshot())).toBeNull();
  const controller = new StudioController({ ...input, initialSelection: opening }, port);
  const disconnect = controller.connect();
  expect(savedOpeningForBook(controller.snapshot())).toEqual(opening);
  controller.changeTitle('Unsaved title');
  expect(savedOpeningForBook(controller.snapshot())).toBeNull();
  expect(controller.snapshot().selected?.title).toBe('Unsaved title');
  const clean = new StudioController({ ...input, initialSelection: opening }, port).snapshot();
  for (const patch of [{ snapshotPending: true }, { uploading: true }, { invalid: true }])
    expect(savedOpeningForBook({ ...clean, selected: { ...clean.selected!, ...patch } })).toBeNull();
  for (const source of [
    { ...opening, native: undefined },
    { ...opening, visibility: 'published' as const },
    { ...opening, permissions: { edit: false, publish: false } },
  ])
    expect(savedOpeningForBook({ ...clean, selected: { ...clean.selected!, source } })).toBeNull();
  disconnect();
});

test('mounted start waits for exact owner confirmation, ignores duplicate clicks and opens the viewer href', async () => {
  const f = fixture();
  const pending = deferred<StudioResult<HostedOwnedBook>>();
  f.native.readOwn = async (...args) => {
    f.reads.push(args);
    return pending.promise;
  };
  function Action() {
    const state = useSyncExternalStore(f.starter.subscribe, f.starter.snapshot);
    return createElement(HostedBookStartAction, {
      state,
      eligible: true,
      start: f.starter.start,
      retry: f.starter.retry,
    });
  }
  const host = document.body.appendChild(document.createElement('main'));
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(Action));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')!.click();
    });
    expect(f.starter.snapshot().kind).toBe('confirming');
    expect(f.hrefs).toEqual([]);
    await f.starter.start();
    expect(f.creates).toEqual([{ body: { postId, threadId, placements: [] }, key }]);
    expect(f.reads[0]?.slice(0, 2)).toEqual([accountId, postId]);
    expect(f.reads[0]?.[3]).toEqual(owner.viewer);
    await act(async () => {
      pending.resolve(ok(owner));
    });
    expect(f.hrefs).toEqual([`/studio?catalogueId=${postId}&ownerAccount=${accountId}&ownerEpoch=9`]);
    expect(opening.visibility).toBe('draft');
    expect(opening.revision.body).toEqual(fromPlainText('Saved opening', 'blocks'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    f.disconnect();
  }
});

test('uncertain retry retains the same Post, empty operands and key, even if a caller selection changes', async () => {
  const f = fixture();
  const create = f.native.create;
  let count = 0;
  f.native.create = async (...args) => {
    const result = await create(...args);
    return ++count === 1 ? fail('uncertain') : result;
  };
  try {
    await f.starter.start();
    expect(f.starter.locked()).toBe(true);
    expect(f.reads).toHaveLength(0);
    f.select({ ...opening, revision: { ...opening.revision, exact: { ...opening.revision.exact, postId: id(99) } } });
    await f.starter.start();
    await f.starter.retry();
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]).toEqual(f.creates[0]);
    expect(f.hrefs).toHaveLength(1);
  } finally {
    f.disconnect();
  }
});

test('existing catalogue conflict reopens through exact owner read; failed confirmation never repeats create', async () => {
  const f = fixture();
  let creates = 0,
    reads = 0;
  f.native.create = async () => {
    creates++;
    return fail('stale');
  };
  f.native.readOwn = async () => (++reads === 1 ? fail('unavailable') : ok(owner));
  try {
    await f.starter.start();
    expect(f.hrefs).toEqual([]);
    await f.starter.retry();
    expect({ creates, reads }).toEqual({ creates: 1, reads: 2 });
    expect(f.hrefs).toHaveLength(1);
  } finally {
    f.disconnect();
  }
});

test('different viewer, authn epoch, Post or thread in the owner response never becomes a destination', async () => {
  for (const changed of [
    { ...owner, viewer: { ...owner.viewer, accountId: id(99) } },
    { ...owner, viewer: { ...owner.viewer, authnEpoch: 10 } },
    { ...owner, item: { ...owner.item, catalogueId: id(99) } },
    { ...owner, item: { ...owner.item, threadId: id(99) } },
  ]) {
    const f = fixture();
    f.native.readOwn = async () => ok(changed);
    try {
      await f.starter.start();
      expect(f.hrefs).toEqual([]);
      expect(f.starter.snapshot().kind).toBe('ended');
    } finally {
      f.disconnect();
    }
  }
});

test('same-account generation replacement and departure abort requests and discard late success', async () => {
  for (const phase of ['create', 'owner', 'departure'] as const) {
    const f = fixture();
    let signal: AbortSignal | undefined;
    const create = deferred<StudioResult<HostedBook>>();
    const read = deferred<StudioResult<HostedOwnedBook>>();
    if (phase === 'create')
      f.native.create = async (_body, _key, abort) => {
        signal = abort;
        return create.promise;
      };
    else
      f.native.readOwn = async (_account, _post, abort) => {
        signal = abort;
        return read.promise;
      };
    const running = f.starter.start();
    await Promise.resolve();
    if (phase === 'departure') f.disconnect();
    else f.replace();
    expect(signal?.aborted).toBe(true);
    create.resolve(ok(empty));
    read.resolve(ok(owner));
    await running;
    expect(f.hrefs).toEqual([]);
    await f.starter.retry();
    expect(f.hrefs).toEqual([]);
    f.disconnect();
  }
});

test('the started empty Book accepts its first saved exact chapter through the installed replacement adapter', async () => {
  const f = fixture();
  try {
    await f.starter.start();
    const target = { threadId, ...opening.revision.exact };
    let sent: unknown;
    f.native.revise = async (_catalogue, body) => {
      sent = body;
      return ok({ ...empty, revision: { ...empty.revision, revisionId: id(20) }, placements: body.placements });
    };
    const adapter = new HostedBookAdapter(
      f.native,
      () => true,
      async () => ok(target),
    );
    const signal = new AbortController().signal;
    expect((await adapter.load(postId, signal)).ok).toBe(true);
    const result = await adapter.change(
      {
        catalogueId: postId,
        expectedRevision: headId,
        idempotencyKey: key,
        change: {
          kind: 'insert',
          parentOccurrenceId: null,
          beforeOccurrenceId: null,
          title: 'First chapter',
          target: { kind: 'chapter', document: opening.revision.exact },
        },
      },
      signal,
    );
    expect(result.ok).toBe(true);
    expect(sent).toMatchObject({ expectedRevisionId: headId, placements: [{ kind: 'chapter', position: 0, target }] });
    expect(f.creates).toHaveLength(1);
  } finally {
    f.disconnect();
  }
});
