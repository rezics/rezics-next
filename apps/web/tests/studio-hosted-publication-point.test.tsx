import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { fromPlainText } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import type { StudioResult, StudioRevision } from '../src/studio/contract';
import type {
  HostedOwnedBook,
  HostedOutlineWindowRequest,
  HostedOutlineWindowPage,
  HostedPublicationPointRequest,
  HostedSelection,
} from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { HostedPublicationPointVisit, publicationPointReady } = await import('../src/studio/hosted-publication-point');
const { HostedPublicationPointView } = await import('../src/studio/hosted-publication-point-view');
const { HostedDraftPointVisit, draftPointReady } = await import('../src/studio/hosted-draft-points');
const { HostedDraftPicker } = await import('../src/studio/hosted-draft-picker');
const { createHostedBookNative, hostedFailure } = await import('../src/studio/hosted-native');
const { HostedReleaseReaderLinkProjection } = await import('../src/studio/hosted-release-reader-link');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const target = { threadId: id(11), postId: id(12), revisionId: id(13), sha256: 'a'.repeat(64) };
const part = {
  occurrenceId: id(20),
  parentId: null,
  position: 0,
  kind: 'part' as const,
  availability: 'available' as const,
  title: 'Private ancestor title',
  target: null,
};
const chapter = {
  ...part,
  occurrenceId: id(21),
  parentId: id(20),
  kind: 'chapter' as const,
  title: 'Saved chapter title',
  target,
};
const publicPart = { ...part, occurrenceId: id(30), title: 'Existing public part' };
const before = { ...chapter, occurrenceId: id(31), parentId: id(30), title: 'Unchanged public sibling' };
const ancestorBefore = { ...before, occurrenceId: id(32), parentId: null };
const replacement = {
  ...chapter,
  parentId: id(30),
  position: 7,
  title: 'Retained public title',
  target: { ...target, revisionId: id(14), sha256: 'b'.repeat(64) },
};
const receipt = { catalogueId: id(1), revisionId: id(9) };
function fixture() {
  let observation: HistoricalReaderObservation = {
    sourceId: 'session',
    generation: 1,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: id(10),
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
  let owner: HostedOwnedBook = {
    viewer: { accountId: id(10), authnEpoch: 2 },
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    item: {
      catalogueId: id(1),
      threadId: id(2),
      postRevisionId: id(3),
      headRevisionId: id(4),
      publicationId: id(5),
      postVisibility: 'published',
      createdAt: '2026-11-13T09:00:00Z',
    },
  };
  const revision: StudioRevision = {
    exact: target,
    title: 'Later Post title',
    body: fromPlainText('The exact saved bytes.', 'blocks'),
    mediaIds: [],
    savedAt: '2026-11-13T08:00:00Z',
  };
  const native = {
    readOwn: mock(async () => ok(owner)),
    readMetadata: mock(async (input: HostedSelection) =>
      ok({ catalogueId: id(1), revisionId: input.revisionId!, kind: input.kind, sourceRevisionId: id(4) }),
    ),
    readOutlineWindow: mock(
      async ({
        revision: metadata,
        cursor,
      }: HostedOutlineWindowRequest): Promise<StudioResult<HostedOutlineWindowPage>> =>
        ok({
          ...metadata,
          items: cursor
            ? []
            : metadata.kind === 'structure'
              ? [part, chapter]
              : [publicPart, before, ancestorBefore, replacement],
          nextCursor: cursor ? null : 'opaque+/=next',
        }),
    ),
    writePublicationPoint: mock(async (_input: HostedPublicationPointRequest, _signal: AbortSignal, _csrf?: string) =>
      ok(receipt),
    ),
  };
  const readVersion = mock(async () => ok(revision));
  const admit = mock(async () => true);
  const visit = new HostedPublicationPointVisit({
    owner,
    source,
    locale: 'en',
    csrfToken: 'original-csrf',
    native,
    readVersion,
    admit,
  });
  const state = () => {
    const state = visit.snapshot();
    if (state.kind !== 'active') throw new Error('Expected active visit');
    return state;
  };
  return {
    visit,
    state,
    native,
    source,
    owner,
    revision,
    readVersion,
    admit,
    changeOwner: (head: string, publication: string) => {
      owner = { ...owner, item: { ...owner.item, headRevisionId: head, publicationId: publication } };
    },
    retire: () => {
      observation = { ...observation, generation: observation.generation + 1 };
      listeners.forEach((fn) => fn());
    },
  };
}
async function prepare(f: ReturnType<typeof fixture>) {
  await f.visit.refresh();
  f.visit.observeDraft(part.occurrenceId);
  f.visit.observeDraft(chapter.occurrenceId);
  f.visit.includeAncestor(part.occurrenceId, true);
  f.visit.destination(part.occurrenceId);
  f.visit.observePublic(ancestorBefore.occurrenceId, 'before');
  f.visit.observePublic(publicPart.occurrenceId, 'parent');
  f.visit.observePublic(before.occurrenceId, 'before');
  await f.visit.readVersion();
  expect(publicationPointReady(f.state())).toBe(true);
  f.visit.review();
}

test('add review freezes exact saved target, public anchors and explicitly reviewed ancestor titles', async () => {
  const f = fixture();
  await prepare(f);
  const request = f.state().intent!.request;
  expect(request.kind).toBe('publish');
  expect(request.body).toEqual({
    expectedRevisionId: id(4),
    expectedPublicationId: id(5),
    occurrenceId: id(21),
    target,
    parentId: id(30),
    beforeOccurrenceId: id(31),
    selectedAncestors: [{ occurrenceId: id(20), beforeOccurrenceId: id(32) }],
  });
  expect(f.readVersion.mock.calls).toHaveLength(1);
  expect(f.state().version!.body).toEqual(f.revision.body);
  expect(f.native.readOutlineWindow.mock.calls).toHaveLength(2);
  f.visit.observeDraft(id(32)); // A public-only row cannot be observed through a draft page.
  expect(f.state().intent!.request).toEqual(request);
  f.visit.dispose();
});

test('replace reviews matching public occurrence and freezes no placement, title or sibling operands', async () => {
  const f = fixture();
  await f.visit.refresh();
  f.visit.observeDraft(chapter.occurrenceId);
  f.visit.observePublic(chapter.occurrenceId, 'replacement');
  await f.visit.readVersion();
  f.visit.review();
  expect(f.state().intent!.request).toMatchObject({
    kind: 'replace',
    body: {
      expectedRevisionId: id(4),
      expectedPublicationId: id(5),
      occurrenceId: chapter.occurrenceId,
      target,
    },
  });
  expect(Object.keys(f.state().intent!.request.body).sort()).toEqual([
    'expectedPublicationId',
    'expectedRevisionId',
    'occurrenceId',
    'target',
  ]);
  expect(f.state().replacement!.item).toEqual(replacement);
  f.visit.dispose();
});

test('412 keeps choices but requires owner/snapshot/anchor and exact version observations again, including same pointers', async () => {
  const f = fixture();
  await prepare(f);
  const original = f.state().intent!.request.idempotencyKey;
  f.native.writePublicationPoint.mockImplementationOnce(async () => hostedFailure('stale', 'Changed'));
  await f.visit.submit();
  expect(f.state().phase).toBe('stale');
  await f.visit.refresh();
  expect(f.state().chapter!.item).toEqual(chapter);
  expect(publicationPointReady(f.state())).toBe(false);
  f.visit.review();
  expect(f.state().intent).toBeNull();
  f.visit.observeDraft(part.occurrenceId);
  f.visit.observeDraft(chapter.occurrenceId);
  f.visit.includeAncestor(part.occurrenceId, true);
  f.visit.observePublic(publicPart.occurrenceId, 'parent');
  f.visit.observePublic(before.occurrenceId, 'before');
  expect(publicationPointReady(f.state())).toBe(false);
  await f.visit.readVersion();
  f.visit.review();
  expect(f.state().intent!.request.idempotencyKey).not.toBe(original);
  f.visit.dispose();
});

test('unknown retry keeps original key, operands and CSRF after later heads; historical receipt has no current reader link', async () => {
  const f = fixture();
  await prepare(f);
  const intent = f.state().intent!;
  f.native.writePublicationPoint.mockImplementationOnce(async () => hostedFailure('uncertain', 'Unknown'));
  await f.visit.submit();
  f.changeOwner(id(6), id(7));
  await f.visit.refresh();
  expect(f.state().phase).toBe('uncertain');
  await f.visit.submit();
  expect(f.native.writePublicationPoint.mock.calls.map((call) => [call[0], call[2]])).toEqual([
    [intent.request, 'original-csrf'],
    [intent.request, 'original-csrf'],
  ]);
  expect(f.state().receipt).toEqual(receipt);
  expect(f.state().phase).toBe('acknowledged');
  expect(f.visit.readerLink.snapshot()).toBeNull();
  expect(f.admit.mock.calls).toHaveLength(0);
  f.visit.dispose();
});

test('receipt survives failed metadata and one-window readback; reading retries never publish again', async () => {
  const f = fixture();
  await prepare(f);
  f.native.readMetadata.mockImplementationOnce(async () => hostedFailure('unavailable', 'Read unavailable'));
  await f.visit.submit();
  expect(f.state().receipt).toEqual(receipt);
  expect(f.state().readbackError).not.toBeNull();
  f.changeOwner(id(4), receipt.revisionId);
  f.native.readOutlineWindow.mockImplementationOnce(async () => hostedFailure('unavailable', 'Page unavailable'));
  await f.visit.readback();
  expect(f.state().publication!.snapshot().kind).toBe('failed');
  expect(f.visit.readerLink.snapshot()).toBeNull();
  await f.visit.readback();
  expect(f.native.writePublicationPoint.mock.calls).toHaveLength(1);
  expect(f.native.readMetadata.mock.calls.map((call) => call[0].revisionId)).toEqual([id(5), id(9), id(9)]);
  expect(f.admit.mock.calls).toHaveLength(1);
  expect(f.visit.readerLink.snapshot()).toEqual({ catalogueId: id(1), releaseRevisionId: id(9) });
  const window = f.state().publication!;
  await window.next();
  expect(f.native.readOutlineWindow.mock.calls.at(-1)![0]).toMatchObject({
    revision: { revisionId: id(9) },
    cursor: 'opaque+/=next',
  });
  f.retire();
  expect(f.visit.snapshot().kind).toBe('ended');
  expect(window.snapshot().kind).toBe('ended');
  expect(f.visit.readerLink.snapshot()).toBeNull();
  f.visit.dispose();
});

test('retirement fences late exact bodies, anonymous admissions and pending focus effects', async () => {
  const f = fixture();
  await prepare(f);
  let resolve!: (value: boolean) => void;
  let began!: () => void;
  const started = new Promise<void>((done) => {
    began = done;
  });
  f.admit.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
        began();
      }),
  );
  f.changeOwner(id(4), receipt.revisionId);
  const pending = f.visit.submit();
  await started;
  f.retire();
  resolve(true);
  await pending;
  expect(f.visit.snapshot().kind).toBe('ended');
  expect(f.visit.readerLink.snapshot()).toBeNull();
  f.visit.dispose();
  const late = fixture();
  await late.visit.refresh();
  late.visit.observeDraft(chapter.occurrenceId);
  let finish!: (result: StudioResult<StudioRevision>) => void;
  late.readVersion.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const reading = late.visit.readVersion();
  late.retire();
  finish(ok(late.revision));
  await reading;
  expect(late.visit.snapshot().kind).toBe('ended');
  late.visit.dispose();
});

test('draft update preserves kind and Post, pins exact title/target, and invalidates anchors after same-pointer 412', async () => {
  const f = fixture();
  const picker = new HostedDraftPicker({
    viewer: f.owner.viewer,
    source: f.source,
    locale: 'en',
    isCurrent: () => true,
    reader: {
      list: async () => ({ state: 'ready', viewer: f.owner.viewer, drafts: [], next: null }),
      resume: async () => 'unavailable',
    },
    readDocument: async () => hostedFailure('unavailable', 'Unused'),
  });
  const write = mock(async () => hostedFailure('stale', 'Changed'));
  const visit = new HostedDraftPointVisit({
    owner: f.owner,
    source: f.source,
    locale: 'en',
    csrfToken: 'csrf',
    picker,
    native: { ...f.native, writeDraftPoint: write },
    readVersion: async () => ok(f.revision),
    readTarget: async () => ok(f.revision),
  });
  const state = () => {
    const state = visit.snapshot();
    if (state.kind !== 'active') throw new Error('Expected active draft');
    return state;
  };
  await state().outline.load();
  visit.observe(chapter.occurrenceId, 'update');
  await visit.readUpdateVersion();
  visit.setTitle('Reviewed outline title');
  expect(draftPointReady(state())).toBe(true);
  await visit.review();
  expect(state().intent!.request).toMatchObject({
    kind: 'update',
    body: { expectedRevisionId: id(4), occurrenceId: id(21), title: 'Reviewed outline title', target },
  });
  await visit.submit();
  await visit.refreshHead();
  expect(draftPointReady(state())).toBe(false);
  visit.observe(part.occurrenceId, 'update');
  visit.setTitle('Renamed part');
  await visit.review();
  expect(state().intent!.request).toMatchObject({
    kind: 'update',
    body: { occurrenceId: id(20), title: 'Renamed part', target: null },
  });
  visit.dispose();
  f.visit.dispose();
});

test('generated point transports POST receipt-only commands and metadata never drain outline pages', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const native = createHostedBookNative(
    createKernelClient('https://kernel.invalid', {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return Response.json(
          init?.method === 'POST'
            ? receipt
            : { catalogueId: id(1), revisionId: id(5), kind: 'publication', sourceRevisionId: id(4) },
        );
      }) as typeof fetch,
    }),
  );
  const f = fixture();
  await prepare(f);
  const request = f.state().intent!.request;
  await native.writePublicationPoint(request, new AbortController().signal);
  await native.writePublicationPoint(
    {
      ...request,
      kind: 'replace',
      body: { expectedRevisionId: id(4), expectedPublicationId: id(5), occurrenceId: id(21), target },
    },
    new AbortController().signal,
  );
  await native.writeDraftPoint(
    {
      catalogueId: id(1),
      expectedViewer: f.owner.viewer,
      idempotencyKey: crypto.randomUUID(),
      kind: 'update',
      body: { expectedRevisionId: id(4), occurrenceId: id(21), title: 'Exact', target },
    },
    new AbortController().signal,
  );
  await native.readMetadata(
    { catalogueId: id(1), kind: 'publication', revisionId: id(5) },
    new AbortController().signal,
  );
  expect(calls.map((call) => call.url.pathname)).toEqual([
    `/v1/hostedCatalogues/${id(1)}:publishChapter`,
    `/v1/hostedCatalogues/${id(1)}:replacePublishedChapter`,
    `/v1/hostedCatalogues/${id(1)}:updateDraftPoint`,
    `/v1/hostedCatalogues/${id(1)}`,
  ]);
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(request.body);
  expect(calls.every((call) => call.init?.cache === 'no-store')).toBe(true);
  f.visit.dispose();
});

test('review shows saved bytes and public title/placement, focuses feedback, then exposes the anonymously admitted exact link', async () => {
  const f = fixture();
  await f.visit.refresh();
  f.visit.observeDraft(chapter.occurrenceId);
  f.visit.observePublic(chapter.occurrenceId, 'replacement');
  await f.visit.readVersion();
  f.visit.review();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<HostedPublicationPointView visit={f.visit} locale="en" />));
    expect(host.textContent).toContain('The exact saved bytes.');
    expect(host.textContent).toContain('Retained public title');
    expect(host.textContent).toContain(target.sha256);
    expect(host.textContent).toContain('2026-11-13T08:00:00Z');
    expect(document.activeElement).toBe(getByRole(host, 'heading', { name: 'Review edit' }));
    expect(queryByRole(host, 'link', { name: /View published Book/ })).toBeNull();
    f.changeOwner(id(4), receipt.revisionId);
    await act(async () => f.visit.submit());
    expect(getByRole(host, 'link', { name: /View published Book/ }).getAttribute('href')).toContain(`release=${id(9)}`);
    await act(async () => f.retire());
    expect(queryByRole(host, 'link', { name: /View published Book/ })).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    f.visit.dispose();
  }
});

test('clearing a reader-link confirmation fences a late anonymous response in the same visit', async () => {
  let resolve!: (value: boolean) => void;
  const projection = new HostedReleaseReaderLinkProjection(
    id(1),
    () => true,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const f = fixture();
  const pending = projection.confirmBounded(
    f.owner.item,
    { catalogueId: id(1), revisionId: id(5), nonempty: true },
    new AbortController().signal,
  );
  projection.clear();
  resolve(true);
  await pending;
  expect(projection.snapshot()).toBeNull();
  f.visit.dispose();
});
