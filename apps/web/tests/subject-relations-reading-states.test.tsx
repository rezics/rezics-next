import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type { RelationsViewData } from '../src/features/pages/relations-view';
import type { SubjectPageData } from '../src/features/pages/subject';
import type { RelationDefinition } from '../src/subject/relations';
import pageRecording from '../src/kernel/recorded/subject-page.json';
import linksRecording from '../src/kernel/recorded/subject-links.json';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN under MINIMAL. Happy DOM checks meaning and keyboard behavior; browser geometry is in the story.
test('The mounted standalone Subject Relations page distinguishes failed, empty and populated reading states and keeps its actual native continuation usable without inferring absent relations.', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/reading/relations', width: 320 });
  const requests: string[] = [];
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
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('The supplied Relations page must not fetch or refill');
    }) as typeof fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AnonymousSessionContext, sessionQuery } = await import('../src/session/query');
  const { RelationsView } = await import('../src/features/pages/relations-view');
  const { SubjectFrame, subjectFrame } = await import('../src/features/pages/subject-frame');
  const { viewTabLabels } = await import('../src/features/pages/route-support');
  const { subjectTabs } = await import('../src/features/pages/views');
  const { PlainLink } = await import('../src/features/pages/shared');
  const { defaultReader } = await import('../src/subject/reader');
  const { qualifiedStatement, qualifiedRealm } = await import('../src/kernel/fake/qualified-relations');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { within } = await import(storybook.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const previousLocale = getLocale();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const overview = pageRecording as unknown as SubjectPageData;
  const frame = subjectFrame(overview, 'en')!;
  const subject = { id: frame.id, label: frame.title.text };
  const cursor = 'opaque:/+?=&% 日本語#';
  const relations: Record<string, RelationDefinition> = {
    'wdt:P155': { label: 'Sequel', group: 'order', symmetric: false },
    'wdt:P144': { label: 'Adaptation', group: 'derivation', symmetric: false },
    'rezics:sameSetting': { label: 'Same setting', group: 'world', symmetric: true },
  };
  // Deliberately interleave groups: retain native member order within the fixed presentation group order.
  const links = [
    linksRecording.links[4]!,
    linksRecording.links[1]!,
    linksRecording.links[2]!,
    linksRecording.links[0]!,
  ];
  const original = structuredClone(links);
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.style.width = '320px';
  window.document.body.append(host);
  const root = createRoot(host);
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor) {
      event.preventDefault();
      navigations.push(anchor.getAttribute('href')!);
    }
  });
  const show = async (data: RelationsViewData, locale = 'en', definitions = relations) => {
    setLocale(locale, { reload: false });
    const options = { locale: locale as never };
    host.lang = locale;
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <AnonymousSessionContext.Provider value>
            <RelationsView
              locale={locale}
              subject={subject}
              frame={
                <SubjectFrame
                  frame={frame}
                  locale={locale}
                  reader={defaultReader}
                  link={PlainLink}
                  unlabelled={m.subject_value_unlabelled({}, options)}
                  tabs={subjectTabs(overview)}
                  tabLabels={viewTabLabels()}
                  view="relations"
                />
              }
              data={data}
              relations={definitions}
              value={{
                locale,
                link: PlainLink,
                reader: defaultReader,
                context: { id: qualifiedRealm, population: { kind: 'realm', id: qualifiedRealm, title: 'Readers' } },
                unlabelled: m.subject_value_unlabelled({}, options),
                spoilerShow: m.subject_spoiler_show({}, options),
                labels: {
                  spoilerShow: m.subject_spoiler_show({}, options),
                  documentSpoiler: m.thread_reveal_spoiler({}, options),
                  cover: { withheld: 'Withheld', reveal: 'Reveal', credit: 'Credit', via: 'via' },
                },
              }}
            />
          </AnonymousSessionContext.Provider>
        </QueryClientProvider>,
      ),
    );
  };
  const next = () => host.querySelector<HTMLAnchorElement>('[data-slot="next-page"]');
  const count = () => host.querySelector('[data-slot="view-heading"] [data-slot="count"]')?.textContent;
  const view = () => within(host);
  const expectNext = (property: string | null, locale = 'en') => {
    const anchor = next()!;
    const query = new URLSearchParams();
    if (property) query.set('property', property);
    query.set('cursor', cursor);
    expect(anchor.getAttribute('href')).toBe(`/${locale}/subjects/${frame.id}/the-little-prince/relations?${query}`);
    expect(anchor.textContent).toBe(m.subject_relations_more({}, { locale: locale as never }));
    expect(anchor.hasAttribute('role') || anchor.hasAttribute('tabindex') || anchor.hasAttribute('aria-disabled')).toBe(
      false,
    );
    expect(anchor.querySelector('a, button')).toBeNull();
    return anchor;
  };

  try {
    await show({ body: { links, count: { value: 40, exact: true }, next: cursor }, property: null });
    expect(view().getByRole('heading', { level: 1 }).textContent).toBe('Relations');
    expect(count()).toBe('40');
    expect(view().queryByRole('alert')).toBeNull();
    expect(view().queryByText(m.subject_relation_empty_page())).toBeNull();
    expect(
      [...host.querySelectorAll('[data-slot="relation-group"]')].map((group) => group.getAttribute('data-group')),
    ).toEqual(['order', 'derivation', 'world']);
    expect([...host.querySelectorAll('[data-slot="relation-group"] article')].map((item) => item.textContent)).toEqual(
      expect.arrayContaining(links.map((link) => expect.stringContaining(link.label))),
    );
    const order = host.querySelector('[data-group="order"]')!;
    expect(order.textContent!.indexOf(links[1]!.label)).toBeLessThan(order.textContent!.indexOf(links[3]!.label));
    expect(order.textContent).toContain('2015');
    const frameElement = host.querySelector('[data-slot="subject-frame"]');
    const headerText = frameElement!.textContent;
    const tabs = [...host.querySelectorAll('[data-slot="view-tabs"] a')].map((anchor) => anchor.getAttribute('href'));
    expect(host.querySelector('[data-slot="view-tabs"] [aria-current="page"]')?.getAttribute('data-view')).toBe(
      'relations',
    );
    expectNext(null);

    await show({
      body: {
        links: links.filter((link) => link.property === 'wdt:P155'),
        next: cursor,
        count: { value: 37, exact: false },
      },
      property: 'wdt:P155',
    });
    expect(view().getByRole('heading', { level: 1 }).textContent).toBe('Sequel');
    expect(view().queryByRole('heading', { level: 2 })).toBeNull();
    expect(host.querySelectorAll('[data-layout="cover-grid"]')).toHaveLength(1);
    expect(count()).toBe('37+');
    expectNext('wdt:P155');
    expect(host.querySelector('[data-slot="subject-frame"]')).toBe(frameElement);
    expect(frameElement!.textContent).toBe(headerText);
    expect(
      [...host.querySelectorAll('[data-slot="view-tabs"] a')].map((anchor) => anchor.getAttribute('href')),
    ).toEqual(tabs);

    // Empty describes only this decoded page, even with a nonzero supplied total and a real next cursor.
    for (const locale of ['en', 'de', 'zh-Hant', 'ja']) {
      const options = { locale: locale as never };
      for (const continuation of [null, cursor]) {
        await show(
          { body: { links: [], count: { value: 9, exact: false }, next: continuation }, property: 'wdt:P155' },
          locale,
        );
        expect(view().getByRole('status').textContent).toBe(m.subject_relation_empty_page({}, options));
        expect(view().queryByRole('alert')).toBeNull();
        expect(host.querySelector('article, [data-slot="relation-group"]')).toBeNull();
        expect(count()).toBe('9+');
        if (continuation) expectNext('wdt:P155', locale);
        else expect(next()).toBeNull();
      }
    }
    await show({ body: { links: [], count: { value: 0, exact: true }, next: null }, property: null });
    expect(view().getByRole('status').textContent).toBe('No visible entries on this page.');
    expect(count()).toBe('0');
    expect(next()).toBeNull();
    await show({ body: { links: [], next: cursor }, property: null });
    expect(count()).toBeUndefined();
    expectNext(null);

    // The existing decoder omits withheld summaries; no identity or global absence is inferred from them.
    const withheld = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e98';
    await show({
      body: { links: [{ subject: withheld, label: 'Withheld title', summary: null }], next: cursor },
      property: null,
    });
    expect(view().getByRole('status').textContent).toBe(m.subject_relation_empty_page());
    expect(host.innerHTML).not.toContain(withheld);
    expect(host.textContent).not.toContain('Withheld title');
    expectNext(null);
    for (const body of [{}, { links: null }, { links: 'unavailable', next: cursor }]) {
      await show({ body, property: null });
      expect(view().getByRole('alert').textContent).toBe(m.subject_section_failed());
      expect(view().queryByRole('status')).toBeNull();
      expect(view().queryByText(m.subject_relation_empty_page())).toBeNull();
      expect(count()).toBeUndefined();
      if ('next' in body) expectNext(null); // Retain the original independent next selection, even on failure.
      else expect(next()).toBeNull();
    }

    const title = `語り手 ${'UnbrokenReadingTitle'.repeat(16)} العربية`;
    const role = { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e96', label: 'Principal narrator' };
    const undisclosed = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e95';
    const credit = {
      ...linksRecording.links[1]!,
      label: title,
      assertion: qualifiedStatement('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e97', 'wdt:P155', subject.id, [
        { property: { id: 'wdt:P3831', data_type: 'wikibase-item' }, value: { type: 'value', content: role.id } },
        {
          property: { id: 'wdt:P1932', data_type: 'monolingualtext' },
          value: { type: 'value', content: { text: '朗読者', language: 'ja' } },
        },
        { property: { id: 'wdt:P453', data_type: 'wikibase-item' }, value: { type: 'value', content: undisclosed } },
      ]),
      related: { [role.id]: { id: role.id, label: { value: role.label, language: 'en' } } },
    };
    host.dir = 'rtl';
    window.document.documentElement.style.fontSize = '200%';
    await show({ body: { links: [credit], count: { value: 7, exact: true }, next: cursor }, property: null });
    const primary = view().getByRole('link', { name: title });
    const roleLink = view().getByRole('link', { name: 'Role: Principal narrator' });
    expect(new URL(primary.getAttribute('href')!, window.location.origin).searchParams.get('realm')).toBe(
      qualifiedRealm,
    );
    expect(roleLink.getAttribute('href')).toBe(`/en/subjects/${role.id}/principal-narrator?realm=${qualifiedRealm}`);
    expect(host.textContent).toContain('2015');
    expect(host.querySelector('[lang="ja"]')?.textContent).toContain('朗読者');
    expect(host.innerHTML).not.toContain(undisclosed);
    expect(primary.contains(roleLink)).toBe(false);
    const continuation = expectNext(null);
    // Long-label stress changes only the rendered text on the actual anchor, never its native target.
    continuation.textContent = `${m.subject_relations_more()} / 次の関係 / ${'WeitereBeziehungen'.repeat(16)}`;
    primary.focus();
    expect(window.document.activeElement).toBe(primary);
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(roleLink);
    await act(async () => user.keyboard('{Enter}'));
    expect(navigations.at(-1)).toBe(roleLink.getAttribute('href'));
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(continuation);
    await act(async () => user.keyboard('{Enter}'));
    expect(navigations.at(-1)).toBe(continuation.getAttribute('href'));
    expect(links).toEqual(original);
    expect(requests).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}, 30_000);
