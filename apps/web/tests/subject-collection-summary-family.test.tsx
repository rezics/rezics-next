import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { LinkProps } from '../src/features/pages/shared';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

// UNRUN: mounted composition assertions for integration, without native/browser/visual acceptance claims.
test('Subject collection summaries use the shared family while retaining admission, original navigation, native order and preview versus paged bounds', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/subject/reader' });
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
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { PageData } = await import('../src/features/pages/data');
  const { CollectionList } = await import('../src/features/pages/overview');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const previousLocale = getLocale();
  const locale = 'fr';
  const options = { locale } as const;
  const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const subjectLabel = 'Lectures';
  const fullHref = `/fr/subjects/${subject}/lectures/lists`;
  const unlabelled = 'Collection sans titre';
  const longTitle = `Zulu — ${'قراءات طويلة SansEspaces'.repeat(20)}`;
  const supplied = Array.from({ length: 15 }, (_, index) => ({
    id: index === 0 ? 'collection /+?=#版%' : `collection-${30 - index}`,
    title: index === 0 ? longTitle : index === 1 ? '' : `Alpha ${index}`,
    curator:
      index === 0
        ? { displayName: 'Camille', handle: 'hidden-handle' }
        : index === 1
          ? { displayName: null, handle: 'curateur' }
          : null,
    multiplicity: index === 0 ? 3 : index === 3 ? 2 : 1,
  }));
  const originalSupplied = structuredClone(supplied);
  const response = (
    collections: unknown = supplied,
    count: unknown = { value: 23, exact: true },
    next: unknown = 'native-next',
  ) => ({
    status: 200,
    body: { collections, count, next },
  });
  const navigations: string[] = [];
  function OriginalPageLink({ href, children, ...props }: LinkProps) {
    return (
      <a
        {...props}
        data-original-page-link=""
        href={href}
        onClick={(event) => {
          event.preventDefault();
          navigations.push(href);
        }}
      >
        {children}
      </a>
    );
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  client.setQueryData(['exposure', 'anonymous'], ['collections']);
  const fetches: (readonly unknown[])[] = [];
  const stop = client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'fetch') fetches.push(event.query.queryKey);
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  host.dir = 'rtl';
  const root = createRoot(host);
  const show = async (
    props: Record<string, unknown> = { limit: 6 },
    result: { status: number; body: unknown } | null = response(),
  ) => {
    const node = {
      type: 'CollectionList',
      props: { id: 'lists', title: { en: 'Lists', fr: 'Collections' }, ...props },
    };
    const document = { root: { props: {} }, content: [node] } satisfies CompositionDocument;
    const plan = planReads(platformRegistry, document, { subject });
    const key = plan.nodes.lists!;
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PageData
            locale={locale}
            subject={subject}
            subjectLabel={subjectLabel}
            document={document as never}
            reads={result ? { [key]: result } : {}}
            messages={{
              unknown: 'Inconnu',
              none: 'Aucun',
              unlabelled,
              sources: 'Sources',
              aliases: 'Alias',
              search: 'Recherche',
            }}
            link={OriginalPageLink}
          >
            <CollectionList {...node.props} />
          </PageData>
        </QueryClientProvider>,
      );
      await Bun.sleep(0);
    });
  };
  const rows = () => [...host.querySelectorAll('section[data-slot="collection-list"] > ul > li')];
  const titles = () => rows().map((row) => row.querySelector('h3')?.textContent);
  const expectedTitles = supplied.map(({ title }) => title || unlabelled);
  const seeAll = () => host.querySelector<HTMLAnchorElement>('[data-slot="see-all"]');
  const countText = () => host.querySelector('[data-slot="count"]')?.textContent;

  try {
    // Explicit component locales must win over the runtime locale, including all metadata and fallbacks.
    setLocale('en', { reload: false });
    await show();
    expect(host.querySelector('h2')?.textContent).toBe('Collections');
    expect(host.querySelector('section')?.getAttribute('aria-labelledby')).toBe(host.querySelector('h2')?.id);
    expect(host.querySelectorAll('ul')).toHaveLength(1);
    expect(titles()).toEqual(expectedTitles.slice(0, 6));
    expect(countText()).toBe('23');
    expect(seeAll()?.getAttribute('href')).toBe(fullHref);
    expect(seeAll()?.textContent).toBe(m.subject_view_all({ label: 'Collections' }, options));
    expect(seeAll()?.getAttribute('aria-describedby')).toBe(host.querySelector('h2')?.id);

    for (const [index, row] of rows().entries()) {
      const heading = row.querySelector('h3')!;
      const primary = heading.querySelector<HTMLAnchorElement>('a')!;
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      expect(heading.hidden || heading.hasAttribute('aria-hidden') || heading.classList.contains('sr-only')).toBe(
        false,
      );
      expect(primary.textContent).toBe(expectedTitles[index]!);
      expect(primary.getAttribute('href')).toBe(`/fr/collections/${encodeURIComponent(supplied[index]!.id)}`);
      expect(primary.hasAttribute('data-original-page-link')).toBe(true);
      expect(primary.hasAttribute('role') || primary.hasAttribute('tabindex')).toBe(false);
      expect(primary.classList.contains('min-h-11')).toBe(true);
      expect(primary.classList.contains('focus-visible:outline-2')).toBe(true);
      expect(heading.className).toContain('[overflow-wrap:anywhere]');
      expect(heading.className).not.toMatch(/truncate|line-clamp|text-left|text-right/);
      expect(row.querySelectorAll('a')).toHaveLength(1);
      expect(row.querySelector('li, h2, img, button, a a, a button')).toBeNull();
    }
    const metadata = rows().map((row) => row.querySelector('[data-content-item-slot="metadata"]')?.textContent);
    expect(metadata[0]).toBe(
      `${m.subject_collection_by({ name: 'Camille' }, options)} ·\u00a0${m.library_subject_multiplicity({ count: 3 }, options)}`,
    );
    expect(metadata[1]).toBe(m.subject_collection_by({ name: '@curateur' }, options));
    expect(metadata[2]).toBeUndefined();
    expect(metadata[3]).toBe(m.library_subject_multiplicity({ count: 2 }, options));
    expect(metadata[4]).toBeUndefined();
    expect(host.textContent).not.toContain('hidden-handle');
    const firstLink = rows()[0]!.querySelector<HTMLAnchorElement>('a')!;
    firstLink.focus();
    expect(window.document.activeElement).toBe(firstLink);
    await act(async () => user.keyboard('{Enter}'));
    expect(navigations).toEqual([`/fr/collections/${encodeURIComponent(supplied[0]!.id)}`]);

    const originalRows = rows();
    await show({ paged: true, limit: 6 });
    expect(titles()).toEqual(expectedTitles);
    expect(rows()).toHaveLength(15);
    expect(seeAll()).toBeNull();
    expect(countText()).toBe('23');
    expect(rows()[0]).toBe(originalRows[0]!);
    await show({ paged: true, limit: 1 });
    expect(titles()).toEqual(expectedTitles);
    const pagedRows = rows();
    const reversed = supplied.toReversed();
    await show({ paged: true, limit: 1 }, response(reversed));
    expect(titles()).toEqual(expectedTitles.toReversed());
    for (const [index, row] of rows().entries()) expect(row).toBe(pagedRows[14 - index]!);

    await show({ limit: 100 });
    expect(titles()).toEqual(expectedTitles.slice(0, 12));
    await show({});
    expect(titles()).toEqual(expectedTitles.slice(0, 12));
    await show({ limit: 2 });
    expect(titles()).toEqual(expectedTitles.slice(0, 2));

    // Admission is the actual collection.get hook's supplied exposure; no permissive hook mock.
    await act(async () => {
      client.setQueryData(['exposure', 'anonymous'], []);
      await Bun.sleep(0);
    });
    expect(titles()).toEqual(expectedTitles.slice(0, 2));
    for (const row of rows()) {
      expect(row.querySelector('a, button, [tabindex], [role="link"]')).toBeNull();
      expect(row.querySelector('h3')?.textContent).toBeTruthy();
      expect(row.querySelector('h3')?.parentElement?.classList.contains('before:hidden')).toBe(true);
      expect(row.innerHTML).not.toContain('after:inset-0');
    }
    expect(seeAll()?.getAttribute('href')).toBe(fullHref);
    expect(navigations).toHaveLength(1);
    await show({ paged: true, limit: 1 });
    expect(titles()).toEqual(expectedTitles);
    expect(host.querySelector('a')).toBeNull();
    await act(async () => {
      client.setQueryData(['exposure', 'anonymous'], ['collections']);
      await Bun.sleep(0);
    });
    expect(rows().every((row) => row.querySelector('a[data-original-page-link]') !== null)).toBe(true);

    const pair = supplied.slice(0, 2);
    for (const scenario of [
      { count: { value: 2, exact: true }, next: null, text: '2', more: false },
      { count: { value: 19, exact: true }, next: null, text: '19', more: true },
      { count: { value: 2, exact: true }, next: 'opaque-native', text: '2', more: true },
    ]) {
      await show({ limit: 6, title: {} }, response(pair, scenario.count, scenario.next));
      expect(host.querySelector('h2')?.textContent).toBe(m.subject_lists({}, options));
      expect(countText()).toBe(scenario.text);
      expect(seeAll() !== null).toBe(scenario.more);
      expect(titles()).toEqual(expectedTitles.slice(0, 2));
    }
    // A preview remainder still exposes the full list with a native zero count and no cursor.
    await show({ limit: 1 }, response(pair, { value: 0, exact: true }, null));
    expect(seeAll()?.getAttribute('href')).toBe(fullHref);
    expect(countText()).toBe('0');
    await show({ limit: 6 }, response([], { value: 0, exact: true }, 'still-native'));
    expect(host.querySelector('section, ul, a')).toBeNull();
    for (const result of [
      { status: 503, body: { code: 'unavailable' } },
      { status: 200, body: { collections: null } },
      response(pair, null, null),
      response(pair, { value: 2, exact: false }, null),
    ]) {
      await show({ limit: 6 }, result);
      expect(host.querySelector('section')?.getAttribute('data-state')).toBe('failed');
      expect(host.querySelector('[data-slot="retry"]')).not.toBeNull();
      expect(host.querySelector('ul, h3, [data-slot="count"]')).toBeNull();
    }
    await show({ limit: 6 }, null);
    expect(host.querySelector('section')?.getAttribute('data-state')).toBe('failed');
    expect(host.querySelector('ul, h3, [data-slot="count"]')).toBeNull();
    expect(supplied).toEqual(originalSupplied);
    expect(fetches).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    stop();
    client.clear();
    host.remove();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}, 30_000);
