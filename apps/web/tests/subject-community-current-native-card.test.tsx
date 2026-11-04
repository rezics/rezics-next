import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('installed native cards render through the generated reader and original action owners, then retire with their opening revision', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/one/reviews' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { readSubjectCommunity, composedCommunityRegion } = await import('../src/features/pages/subject-community');
  const {
    SubjectCommunityRegion,
    SubjectCommunityContext,
    SubjectCommunityRefreshContext,
    SubjectCommunityVerificationContext,
  } = await import('../src/features/pages/subject-community-view');
  const { communitySubject, communityThread, communityThreadPage } =
    await import('../src/kernel/fake/subject-community');
  const { GLOBAL } = await import('../src/features/pages/subject-ratings');
  const { m } = await import('../src/paraglide/messages.js');
  const row = structuredClone(communityThread('review'));
  if (row.firstPost.availability !== 'available') throw new Error('Expected opening post');
  const post = row.firstPost;
  const imageId = '01a1a000-0000-7000-8000-000000000098';
  post.mediaIds = [imageId];
  post.body.doc.content!.push({ type: 'image', attrs: { src: imageId, alt: 'Original document image', id: 'image' } });
  // The populated/covered variants of Content's subject-threads-http example, without a historical extension.
  const card = {
    state: 'current',
    authors: { thread: { state: 'withheld' }, openingPost: { state: 'withheld' } },
    presentation: { state: 'current', language: 'fr', spoiler: true },
    parentContext: { kind: 'opening' },
    media: {
      state: 'available',
      images: [
        {
          id: imageId,
          containerId: post.id,
          digest: 'a'.repeat(64),
          width: 100,
          height: 80,
          variants: [{ format: 'webp', width: 100, height: 80 }],
          placeholder: null,
          focalPoint: null,
          credit: null,
        },
      ],
    },
    comments: {
      state: 'current',
      cohort: 'public',
      count: { kind: 'exact', value: 0 },
      lastActivityAt: null,
      source: { epoch: 1, position: '1' },
    },
    actions: {
      state: 'current',
      retryable: false,
      references: [
        {
          type: 'content.thread',
          id: row.id,
          sourceRevisionId: post.revisionId,
          state: 'current',
          operations: [
            { action: 'post:create', operationId: 'post.create', state: 'available' },
            { action: 'reaction:set', operationId: 'thread.set_reaction', state: 'available' },
            { action: 'reaction:set', operationId: 'thread.clear_reaction', state: 'available' },
            { action: 'thread:watch', operationId: 'thread.watch', state: 'available' },
            { action: 'thread:watch', operationId: 'thread.unwatch', state: 'available' },
            { action: 'report:create', operationId: 'report.create', state: 'available' },
          ],
        },
      ],
    },
    reply: { state: 'available' },
    watch: { state: 'current', watching: false },
    currentness: {
      source: 'current',
      place: 'current',
      authors: 'unavailable',
      reactions: 'current',
      actions: 'current',
      watch: 'current',
      media: 'current',
      comments: 'current',
    },
  };
  const native = {
    ...row,
    card,
    reviewContext: { citation: { state: 'available', units: 5, question: { scale: { min: 1, max: 5 } } } },
  };
  const requests: URL[] = [];
  const kernel = createKernelClient('https://kernel.invalid', {
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      return Response.json(
        communityThreadPage(
          'review',
          communitySubject,
          [native],
          'native-next',
          url.searchParams.get('place') ?? GLOBAL,
        ),
      );
    },
  });
  const expected = {
    kind: 'subjectThreads',
    id: communitySubject.id,
    place: GLOBAL,
    threadKind: 'review',
    limit: 20,
  } as const;
  const project = () =>
    composedCommunityRegion(
      { status: 200, body: communityThreadPage('review', communitySubject, [native], 'native-next') },
      expected,
      true,
    );
  let data = await readSubjectCommunity(kernel, communitySubject.id, ['review'], true, undefined, 'reader');
  expect(requests).toHaveLength(1); // Native identities require no fallback batch or row hydration.
  expect(data.regions.review).toMatchObject({
    state: 'ready',
    threads: [
      {
        postRevisionId: post.revisionId,
        card: undefined,
        nativeCard: { author: null, comments: { count: { value: 0 } } },
      },
    ],
  });
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let actionCalls = 0;
  let refreshCompletion: Promise<void> = Promise.resolve();
  let refreshCurrentAdvice = async () => {};
  const show = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SubjectCommunityVerificationContext.Provider
            value={{ sitekey: '', scriptUrl: 'https://verification.invalid' }}
          >
            <SubjectCommunityContext.Provider value={data}>
            <SubjectCommunityRefreshContext.Provider value={refreshCurrentAdvice}>
              <SubjectCommunityRegion
                id="native"
                kind="review"
                region={data.regions.review!}
                authors={{}}
                now={data.now}
                subject={communitySubject}
                locale="en"
                href="/en/subjects/one/reviews?cursor=original"
                paged
                preparedTransport={{
                  change: async () => {
                    actionCalls++;
                    return { ok: false, reason: 'unavailable' };
                  },
                  read: async () => {
                    actionCalls++;
                    return { ok: false, reason: 'unavailable' };
                  },
                }}
                preparedWatch={{
                  set: async () => {
                    actionCalls++;
                    return { kind: 'confirmed' };
                  },
                  read: async () => {
                    actionCalls++;
                    return { kind: 'unavailable' };
                  },
                }}
              />
            </SubjectCommunityRefreshContext.Provider>
            </SubjectCommunityContext.Provider>
          </SubjectCommunityVerificationContext.Provider>
        </QueryClientProvider>,
      ),
    );
  try {
    await show();
    expect(actionCalls).toBe(0);
    expect(host.querySelector('[data-content-item-slot="preview"], img')).toBeNull();
    expect(host.querySelector('[data-slot="community-native-author"]')?.textContent).toContain(
      m.thread_author_unknown(),
    );
    expect(host.querySelector('[data-slot="community-activity"]')?.textContent).toContain('0');
    expect(host.querySelector('[data-slot="community-activity"] time')).toBeNull();
    expect(host.querySelector('[data-slot="review-citation"]')?.getAttribute('data-state')).toBe('unavailable');
    expect(host.querySelector('a[href$="#reply"]')?.getAttribute('href')).toContain(row.id);
    expect(host.querySelector('[data-slot="reaction-chip"]')).not.toBeNull();
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.getAttribute('aria-label') === m.report_more(),
      ),
    ).toBe(true);
    const reveal = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(m.subject_spoiler_show()),
    )!;
    await act(async () => reveal.click());
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('Original document image');
    expect(host.querySelector('[lang="fr"] [data-content-item-slot="preview"]')).not.toBeNull();
    const watch = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === m.thread_watch_watch());
    expect(watch).toBeDefined();
    await act(async () => watch!.click());
    expect(host.textContent).toContain(m.thread_watch_confirm_started());
    const refresh = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === m.thread_watch_refresh_advice(),
    );
    expect(refresh).toBeDefined();
    refreshCurrentAdvice = () => {
      refreshCompletion = (async () => {
        card.watch.watching = true;
        data = await readSubjectCommunity(kernel, communitySubject.id, ['review'], true, undefined, 'reader');
      })();
      return refreshCompletion;
    };
    await act(async () => refresh!.click());
    await refreshCompletion;
    await show();
    expect(host.querySelector('button')?.textContent).not.toBe(m.thread_watch_retry_exact());
    const stop = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === m.thread_watch_stop());
    expect(stop).toBeDefined();
    await act(async () => stop!.click());
    expect(host.textContent).toContain(m.thread_watch_confirm_stopped());
    expect(actionCalls).toBe(2);
    expect(requests).toHaveLength(2);
    (host.querySelector('h3 a') as HTMLElement).focus();
    post.revisionId = imageId;
    data = { ...data, regions: { review: project() } };
    await show();
    expect(host.querySelector('h3, img, [data-slot="community-actions"]')).toBeNull();
    expect(window.document.activeElement?.id).toBe('native-title');
    card.currentness.actions = 'unavailable';
    card.comments.count = { kind: 'lower-bound', value: 2 };
    card.media.images[0]!.containerId = row.id; // A thread is not the opening post's media container.
    data = { ...data, sourceKey: crypto.randomUUID(), regions: { review: project() } };
    await show();
    expect(host.querySelector('[data-slot="community-actions"]')).toBeNull();
    expect(host.querySelector('[data-slot="community-activity"]')?.textContent).toContain('2+');
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes(m.subject_spoiler_show()))!
        .click(),
    );
    expect(host.querySelector('img')).toBeNull();
    expect(requests).toHaveLength(2);
    expect(actionCalls).toBe(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
    await window.happyDOM.close();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
