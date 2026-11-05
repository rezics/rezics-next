import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import type { CommunityCard } from '../src/features/pages/subject-community-card';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/one/reviews' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
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
})) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { composedCommunityRegion, readSubjectCommunity } = await import('../src/features/pages/subject-community');
const { SubjectCommunityContext, SubjectCommunityRegion } =
  await import('../src/features/pages/subject-community-view');
const { communitySubject, communityThread, communityThreadPage } = await import('../src/kernel/fake/subject-community');
const { GLOBAL } = await import('../src/features/pages/subject-ratings');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const realm = '01a1a000-0000-7000-8000-000000000096';
const original = '01a1a000-0000-7000-8000-000000000099';
const mediaId = '01a1a000-0000-7000-8000-000000000098';
function row(index = 0, kind: 'review' | 'discussion' = 'review') {
  const thread = communityThread(kind);
  const post = thread.firstPost;
  if (post.availability !== 'available') throw new Error('Expected an available opening');
  thread.id = `01a1a000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`;
  post.threadId = thread.id;
  post.voteCitation = { questionId: original, units: 0, revision: 7 };
  post.mediaIds = [mediaId];
  post.body = {
    ...post.body,
    doc: {
      ...post.body.doc,
      content: [
        ...post.body.doc.content!,
        { type: 'image', attrs: { src: mediaId, alt: 'Native illustration', id: 'native-image' } },
      ],
    },
  };
  const card: CommunityCard = {
    version: 1,
    threadId: thread.id,
    postRevisionId: post.revisionId,
    citation: {
      state: 'available',
      postRevisionId: post.revisionId,
      recorded: post.voteCitation,
      question: {
        id: original,
        revision: 3,
        label: 'Original question',
        scale: { min: 0, max: 20, displayStep: 2 },
        lifecycle: { state: 'retired', revision: 4 },
      },
      originalTarget: { id: original, label: 'Original subject', mergedInto: communitySubject.id },
    },
    activity: { replyCount: 0, lastActivityAt: '2026-11-01T12:00:00Z' },
    media: [
      {
        alt: 'Native illustration',
        image: {
          id: mediaId,
          containerId: thread.id,
          digest: 'a'.repeat(64),
          width: 100,
          height: 80,
          variants: [{ format: 'webp', width: 100, height: 80 }],
          placeholder: null,
          focalPoint: null,
          credit: null,
        },
      },
    ],
  };
  return { ...thread, card, reviewContext: { citation: { units: 18, question: { scale: { min: 1, max: 5 } } } } };
}
const project = (rows: unknown[], place = GLOBAL, kind: 'review' | 'discussion' = 'review') =>
  composedCommunityRegion(
    { status: 200, body: communityThreadPage(kind, communitySubject, rows, 'opaque-next', place) },
    { kind: 'subjectThreads', id: communitySubject.id, place, threadKind: kind, limit: 20 },
    true,
  );

afterAll(async () => {
  setLocale('en', { reload: false });
  await window.happyDOM.close();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('one native window projects 1/5/20 cards; oversized, unbound or current-only provenance cannot supply historical facts', () => {
  for (const size of [1, 5, 20]) {
    const region = project(Array.from({ length: size }, (_, index) => row(index)));
    expect(region.state).toBe('ready');
    if (region.state !== 'ready') throw new Error('Expected native page');
    expect(region.threads).toHaveLength(size);
    expect(region.threads.every((thread) => thread.card?.media.length === 1 && thread.summary.length <= 280)).toBe(
      true,
    );
    expect(region.next).toBe('opaque-next');
  }
  for (const mutate of [
    (value: ReturnType<typeof row>) => {
      value.card.postRevisionId = original;
    },
    (value: ReturnType<typeof row>) => {
      if (value.card.citation.state === 'available')
        value.card.citation.recorded = { questionId: original, units: 2, revision: 7 };
    },
    (value: ReturnType<typeof row>) => {
      value.card.media[0]!.image.containerId = original;
    },
    (value: ReturnType<typeof row>) => {
      value.card.media[0]!.alt = 'x'.repeat(4097);
    },
    (value: ReturnType<typeof row>) => {
      value.card.media.push(...value.card.media, ...value.card.media);
    },
  ]) {
    const source = row();
    mutate(source);
    expect(project([source])).toMatchObject({ state: 'ready', threads: [{ card: undefined }] });
  }
  const source = row();
  expect(project([{ ...source, card: undefined }])).toMatchObject({ state: 'ready', threads: [{ card: undefined }] });
  expect(project([{ ...source, title: 'x'.repeat(4097) }]).state).toBe('unavailable');
});

test('mounted Global/Realm review and discussion cards preserve zero, historical scale and original target, then retire media and citations together', async () => {
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  const session = { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' };
  client.setQueryData(['session'], session);
  let source = 0;
  let region = project([row()]);
  const show = (locale: string, kind: 'review' | 'discussion') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SubjectCommunityContext.Provider
            value={{
              regions: { [kind]: region },
              authors: {},
              reader: 'reader',
              now: '2026-11-02T00:00:00Z',
              sourceKey: String(source),
            }}
          >
            <SubjectCommunityRegion
              id="community"
              kind={kind}
              region={region}
              authors={{}}
              now="2026-11-02T00:00:00Z"
              subject={communitySubject}
              locale={locale}
              href={`/${locale}/subjects/one/${kind}?cursor=exact`}
              paged
            />
          </SubjectCommunityContext.Provider>
        </QueryClientProvider>,
      ),
    );
  try {
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      setLocale(locale, { reload: false });
      for (const place of [GLOBAL, realm])
        for (const kind of ['review', 'discussion'] as const) {
          region = project([row(0, kind)], place, kind);
          source++;
          await show(locale, kind);
          expect(host.querySelector('[data-context-place-id]')?.getAttribute('data-context-place-id')).toBe(place);
          expect(host.querySelector('img')?.getAttribute('alt')).toBe('Native illustration');
          expect(host.querySelector('[data-slot="community-activity"]')?.textContent).toContain('0');
          expect(host.querySelector('[data-slot="reaction-chip"], a[href$="#reply"]')).toBeNull();
          if (kind === 'review') {
            const citation = host.querySelector('[data-slot="review-citation"]')!;
            expect(citation.getAttribute('data-state')).toBe('available');
            expect(citation.textContent).toContain(
              m.subject_community_recorded_scale({ min: '0', max: '20', step: '2' }),
            );
            expect(citation.textContent).toContain(m.discussion_provenance_details_rating_units({ units: '0' }));
            expect(citation.textContent).toContain(original);
            const summary = citation.querySelector('summary')!;
            summary.click();
            expect(citation.querySelector('details')?.open).toBe(true);
            summary.focus();
          } else (host.querySelector('h3 a') as HTMLElement).focus();
          const oldImage = host.querySelector('img')!;
          await act(async () => {
            client.setQueryData(['session'], { ...session, csrfToken: 'replacement' });
          });
          expect(host.querySelector('img, [data-slot="review-citation"], [data-slot="community-activity"]')).toBeNull();
          expect(window.document.activeElement?.id).toBe('community-title');
          oldImage.dispatchEvent(new window.Event('load'));
          await act(async () => {
            client.setQueryData(['session'], session);
          });
          await show(locale, kind);
          expect(host.querySelector('h3')).toBeNull();
          source++;
          await show(locale, kind);
          expect(host.querySelector('h3')).not.toBeNull();
        }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

test('a sparse Realm page and failed retry keep the same opaque cursor without refill or card hydration', async () => {
  const requests: URL[] = [];
  let status = 200;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      return Response.json(
        status === 200
          ? communityThreadPage('discussion', communitySubject, [], 'opaque-next', realm)
          : { code: 'dependency_unavailable' },
        { status },
      );
    },
  });
  for (const nextStatus of [200, 503, 200]) {
    status = nextStatus;
    const value = await readSubjectCommunity(
      client,
      communitySubject.id,
      ['discussion'],
      true,
      'opaque-next',
      null,
      realm,
    );
    expect(value.regions.discussion?.state).toBe(status === 200 ? 'ready' : 'unavailable');
  }
  expect(requests).toHaveLength(3);
  expect(
    requests.every(
      (url) =>
        url.pathname.endsWith('/threads') &&
        url.searchParams.get('cursor') === 'opaque-next' &&
        url.searchParams.get('place') === realm,
    ),
  ).toBe(true);
});
