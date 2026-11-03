import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('mounted cards retire browser epochs and descriptors until a fresh native observation arrives', async () => {
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { SubjectCommunityContext, SubjectCommunityRegion } =
    await import('../src/features/pages/subject-community-view');
  const { useSubjectCommunityReading } = await import('../src/features/pages/subject-community-lifetime');
  const { communityThread, communityThreadPage, communitySubject } =
    await import('../src/kernel/fake/subject-community');
  const { composedCommunityRegion } = await import('../src/features/pages/subject-community');
  const { GLOBAL } = await import('../src/features/pages/subject-ratings');
  const client = new QueryClient();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const session = { state: 'signed-in', subject: 'reader', csrfToken: 'csrf-one' };
  client.setQueryData(['session'], session);
  let source = 0;
  let locale = 'en';
  let href = '/en/subjects/one/reviews?cursor=same&node=reviews';
  let origin!: ReturnType<typeof useSubjectCommunityReading>;
  let region = composedCommunityRegion(
    { status: 200, body: communityThreadPage('review', communitySubject, [communityThread('review')], 'next') },
    { kind: 'subjectThreads', id: communitySubject.id, threadKind: 'review', place: GLOBAL, limit: 20 },
    true,
  );
  function Probe() {
    origin = useSubjectCommunityReading({ source: String(source), descriptor: href, reader: 'reader' });
    return null;
  }
  const show = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
          <SubjectCommunityContext.Provider
            value={{
              regions: { review: region },
              authors: {},
              now: '2026-11-02T00:00:00Z',
              reader: 'reader',
              sourceKey: String(source),
            }}
          >
            <SubjectCommunityRegion
              id="reviews"
              kind="review"
              region={region}
              authors={{}}
              now="2026-11-02T00:00:00Z"
              subject={communitySubject}
              locale={locale}
              href={href}
              paged
              node="reviews"
            />
          </SubjectCommunityContext.Provider>
        </QueryClientProvider>,
      ),
    );
  const populated = () => expect(host.querySelector('section')?.getAttribute('data-state')).toBe('populated');
  const retired = () => {
    expect(host.querySelector('[data-slot="community-current-context"]')).toBeNull();
    expect(
      host.querySelector('h3, [data-slot="review-citation"], [data-slot="community-reaction-summary"]'),
    ).toBeNull();
    expect(host.querySelector('[data-slot="retry"]')?.getAttribute('href')).toBe(href);
  };
  try {
    await show();
    populated();
    for (const replace of [
      () => client.setQueryData(['session'], { ...session, csrfToken: 'csrf-two' }),
      () => client.setQueryData(['session'], { ...session, subject: 'other' }),
      () => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }),
      () => client.setQueryData(['session'], session), // Equal successful observations also replace an epoch.
      () => client.setQueryData(['exposure', 'viewer'], ['changed']),
    ]) {
      const link = host.querySelector('h3 a') as unknown as HTMLElement;
      link.focus();
      const late = origin;
      await act(async () => {
        replace();
        expect(late.isCurrent()).toBe(false);
      });
      retired();
      expect(window.document.activeElement?.id).toBe('reviews-title');
      await act(async () => {
        client.setQueryData(['session'], session);
      });
      await show();
      retired();
      source++;
      await show();
      populated();
      expect(origin.isCurrent()).toBe(true);
      expect(late.isCurrent()).toBe(false);
    }
    for (const replace of [
      () => {
        locale = 'fr';
      },
      () => {
        href += '&place=realm';
      },
    ]) {
      replace();
      await show();
      retired();
      source++;
      await show();
      populated();
    }
    if (region.state !== 'ready') throw new Error('Expected a readable native fixture');
    region = { ...region, reactionsAsOf: null };
    await show();
    retired(); // A watermark cannot replace the baseline inside an existing observation.
    source++;
    await show();
    populated();
    expect(host.querySelector('[data-slot="community-reaction-summary"]')).toBeNull();
    expect(host.querySelector('button, a[href$="#reply"]')).toBeNull();
    const late = origin;
    await act(async () => root.render(null));
    expect(late.isCurrent()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});
