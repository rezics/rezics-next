import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import type { StudioResult } from '../src/studio/contract';
import { StudioController } from '../src/studio/controller';
import type { HostedBook, HostedBookNative, HostedOwnedBook } from '../src/studio/hosted-contract';
import { HostedReleaseReaderLink } from '../src/studio/hosted-release-reader-link-action';
import { publicHostedReleaseAdmission } from '../src/studio/hosted-release-reader-link-admission';
import { openHostedStudio, type StudioDocumentPort } from '../src/studio/hosted-workspace';
import { StudioWorkspace } from '../src/studio/workspace';
import { setLocale, type Locale } from '../src/paraglide/runtime.js';

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const [catalogueId, structureId, releaseId, nextId, occurrenceId] = [id(1), id(2), id(3), id(4), id(5)] as const;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const fail = (kind: 'unavailable' | 'uncertain' | 'stale' = 'unavailable'): StudioResult<never> => ({
  ok: false,
  error: { kind, message: kind },
});
const structure: HostedBook = {
  revision: { catalogueId, revisionId: structureId, kind: 'structure', sourceRevisionId: null },
  placements: [
    {
      occurrenceId,
      parentId: null,
      position: 0,
      title: 'Opening',
      kind: 'chapter',
      target: { threadId: id(6), postId: id(7), revisionId: id(8), sha256: 'a'.repeat(64) },
    },
  ],
};
const release: HostedBook = {
  ...structure,
  revision: { catalogueId, revisionId: releaseId, kind: 'publication', sourceRevisionId: structureId },
};

async function fixture(
  initial: HostedBook | null = release,
  visibility: 'published' | 'draft' | 'protected' = 'published',
  publicStatus = 200,
) {
  const state = {
    current: true,
    live: initial,
    failure: null as 'uncertain' | 'stale' | null,
    beforePublic: undefined as (() => Promise<void>) | undefined,
  };
  const publicRequests: Request[] = [];
  const commands: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      publicRequests.push(new Request(input, init));
      await state.beforePublic?.();
      return Response.json(state.live?.revision, { status: publicStatus });
    },
  });
  const owned = (): HostedOwnedBook => ({
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    viewer: { accountId: catalogueId, authnEpoch: 1 },
    item: {
      catalogueId,
      threadId: id(6),
      createdAt: '2026-11-13T01:02:03Z',
      postRevisionId: id(9),
      postVisibility: visibility,
      headRevisionId: structureId,
      publicationId: state.live?.revision.revisionId ?? null,
    },
  });
  const native: HostedBookNative = {
    listHistory: async () => fail(),
    listOwn: async () => fail(),
    readOwn: async () => ok(owned()),
    read: async (selection) => ok(selection.kind === 'structure' ? structure : state.live!),
    create: async () => fail(),
    revise: async () => fail(),
    publish: async (_id, body, key) => {
      commands.push(key);
      if (state.failure === 'stale') return fail('stale');
      state.live = {
        revision: { ...release.revision, revisionId: nextId },
        placements: body.occurrenceIds.length ? structure.placements : [],
      };
      return state.failure ? fail(state.failure) : ok(state.live);
    },
  };
  const documents: StudioDocumentPort = {
    isCurrent: () => state.current,
    documents: async () => ok({ items: [], nextCursor: null }),
    open: async () => fail(),
    createDraft: async () => fail(),
    saveDraft: async () => fail(),
    versions: async () => ok({ items: [], nextCursor: null }),
    revision: async () => fail(),
  };
  const opened = await openHostedStudio(
    {
      catalogueId,
      accountId: catalogueId,
      native,
      documents,
      resolveTarget: async () => fail(),
      isCurrent: () => state.current,
      admitPublicRelease: (address, signal) => publicHostedReleaseAdmission(client, address, signal),
      input: {
        visitKey: 'release-reader',
        projectId: catalogueId,
        title: 'Book Studio',
        documents: { items: [], nextCursor: null },
        publications: { items: [], nextCursor: null },
        canCreateDraft: false,
      },
    },
    new AbortController().signal,
  );
  if (!opened.ok) throw new Error(opened.error.message);
  const workspace = opened.value.workspace;
  const controller = new StudioController(workspace.input, workspace.port, workspace.bookPort);
  controller.connect();
  const html = (locale: Locale = 'en') =>
    renderToStaticMarkup(createElement(HostedReleaseReaderLink, { binding: workspace.hostedReleaseReader!, locale }));
  return { state, workspace, controller, html, commands, publicRequests };
}

test('Studio exposes one localized exact release link, preserving draft structure and selection with metadata-only admission', async () => {
  const f = await fixture();
  setLocale('en', { reload: false });
  const mounted = renderToStaticMarkup(createElement(StudioWorkspace, f.workspace));
  expect(mounted.match(/View published Book/g)).toHaveLength(1);
  expect(f.html()).toContain('target="_blank" rel="noopener"');
  expect(mounted).toContain(`href="/en/books/${catalogueId}/read?release=${releaseId}"`);
  expect(f.html('zh-Hant')).toContain(`href="/zh-Hant/books/${catalogueId}/read?release=${releaseId}"`);
  expect(f.html('zh-Hant')).toContain('閱讀已發布的書籍');
  expect(f.commands).toEqual([]);
  expect(f.publicRequests).toHaveLength(1);
  const request = f.publicRequests[0]!;
  expect(new URL(request.url).pathname).toBe(`/v1/hostedCatalogues/${catalogueId}`);
  expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ kind: 'publication', revisionId: releaseId });
  expect(request.headers.has('authorization')).toBe(false);
  expect(request.cache).toBe('no-store');
});

test('owner-only reads, missing publications and empty withdrawal manifests do not expose the action', async () => {
  for (const status of [403, 404, 503]) expect((await fixture(release, 'published', status)).html()).toBe('');
  for (const [initial, visibility] of [
    [null, 'published'],
    [release, 'draft'],
    [release, 'protected'],
    [{ ...release, placements: [] }, 'published'],
  ] as const) {
    const f = await fixture(initial, visibility);
    expect(f.html()).toBe('');
    expect(f.publicRequests).toHaveLength(0);
  }
});

test('a confirmed replacement advances the exact href; failed and uncertain commands withhold it until reconfirmed', async () => {
  for (const failure of ['stale', 'uncertain', null] as const) {
    const f = await fixture();
    f.controller.toggleOccurrence(occurrenceId, true);
    expect(await f.controller.reviewPublication()).toBe(true);
    f.state.failure = failure;
    expect(await f.controller.publish()).toBe(failure === null);
    if (failure === null) expect(f.html()).toContain(`?release=${nextId}`);
    else expect(f.html()).toBe('');
    if (failure === 'uncertain') {
      f.state.failure = null;
      expect(await f.controller.publish()).toBe(true);
      expect(f.commands[1]).toBe(f.commands[0]);
      expect(f.html()).toContain(`?release=${nextId}`);
    }
    expect([...f.controller.snapshot().selectedOccurrences]).toEqual([occurrenceId]);
    expect(f.controller.snapshot().structure?.revision).toBe(structureId);
  }
});

test('withdrawal removes the action while preserving the draft', async () => {
  const f = await fixture();
  expect(await f.controller.reviewWithdrawal()).toBe(true);
  expect(await f.controller.publish()).toBe(true);
  expect(f.html()).toBe('');
  expect(f.controller.snapshot().structure?.placements).toHaveLength(1);
});

test('late anonymous admission cannot expose a release after the author visit retires', async () => {
  const f = await fixture();
  f.controller.toggleOccurrence(occurrenceId, true);
  expect(await f.controller.reviewPublication()).toBe(true);
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  f.state.beforePublic = () => {
    started.resolve();
    return finish.promise;
  };
  const pending = f.controller.publish();
  await started.promise;
  expect(f.html()).toBe('');
  f.state.current = false;
  finish.resolve();
  expect(await pending).toBe(false);
  expect(f.html()).toBe('');
  f.state.current = true;
  expect(f.html()).toBe('');
});
