import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import recording from '../src/kernel/recorded/subject-page.json';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

test('Overview previews keep bounded native rows, truthful counts and independent keyboard navigation through section failure and recovery', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/fr/subjects/book/overview?realm=selected#editions' });
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
  const { SubjectList, CollectionList, Preview } = await import('../src/features/pages/overview');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const { within } = await import(storybook.resolve('@testing-library/dom'));
  const user = userEvent.setup({ document: window.document });
  const title = `Éditions et traductions — ${'SansEspacesالعربية'.repeat(20)}`;
  const collectionTitle = '読者が選んだ本と読書の記録'.repeat(18);
  const nodes = [
    {
      type: 'SubjectList',
      props: { id: 'editions', property: 'schema:exampleOfWork', limit: 1, title: { fr: title } },
    },
    {
      type: 'SubjectList',
      props: { id: 'related', property: 'local:related /+?', limit: 1, title: { fr: 'Œuvres liées' } },
    },
    { type: 'CollectionList', props: { id: 'lists', limit: 1, title: { ja: collectionTitle } } },
  ];
  const document = { root: { props: {} }, content: nodes } satisfies CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: recording.subject });
  const supplied = structuredClone(recording.reads.r1.body);
  const original = structuredClone(supplied);
  const collection = structuredClone(recording.reads.r6);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  client.setQueryData(['exposure', 'anonymous'], ['collections']);
  const reads: unknown[] = [];
  const stop = client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'fetch') reads.push(event.query.queryKey);
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.style.width = '320px';
  host.style.fontSize = '200%';
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
  const show = async (
    first: { status: number; body: unknown } = { status: 200, body: supplied },
    second: { status: number; body: unknown } = {
      status: 200,
      body: { ...supplied, count: { value: 12345, exact: false } },
    },
    subject: string | null = recording.subject,
  ) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PageData
            document={document as never}
            locale="fr"
            subject={subject}
            subjectLabel="Les lectures"
            realm="realm /+?"
            messages={{
              unknown: 'Inconnu',
              none: 'Aucun',
              unlabelled: 'Sans titre',
              sources: 'Sources',
              aliases: 'Alias',
            }}
            reads={{ [plan.nodes.editions!]: first, [plan.nodes.related!]: second, [plan.nodes.lists!]: collection }}
          >
            <SubjectList {...nodes[0]!.props} />
            <SubjectList {...nodes[1]!.props} />
            <CollectionList {...nodes[2]!.props} />
            <Preview
              id="complete"
              slot="complete"
              title="Complet"
              count={{ value: 1, relation: 'exact' }}
              more={false}
              href="/must-not-appear"
              locale="fr"
            >
              <p>Complete supplied preview</p>
            </Preview>
          </PageData>
        </QueryClientProvider>,
      );
    });
  };
  const section = (id: string) => host.querySelector<HTMLElement>(`section#${id}`)!;
  const more = (id: string) => section(id).querySelector<HTMLAnchorElement>('[data-slot="see-all"]')!;
  const assertAction = (link: HTMLAnchorElement) => {
    for (const token of [
      'min-h-11',
      'min-w-11',
      'max-w-full',
      'whitespace-normal',
      '[overflow-wrap:anywhere]',
      'focus-visible:outline-2',
    ])
      expect(link.classList.contains(token)).toBe(true);
    expect(link.querySelector('a, button')).toBeNull();
    expect(link.hasAttribute('tabindex')).toBe(false);
    expect(link.className).not.toMatch(/truncate|line-clamp|whitespace-nowrap/);
  };
  try {
    await show();
    const editions = section('editions');
    const sibling = section('lists');
    expect(within(editions).getByRole('heading', { level: 2, name: title }).id).toBe('editions-title');
    expect(editions.getAttribute('aria-labelledby')).toBe('editions-title');
    expect(editions.querySelector('[data-slot="count"]')?.textContent).toBe('2');
    expect(section('related').querySelector('[data-slot="count"]')?.textContent).toBe(
      `${new Intl.NumberFormat('fr').format(12345)}+`,
    );
    expect(sibling.querySelector('h2')?.getAttribute('lang')).toBe('ja');
    expect(sibling.querySelector('h2')?.textContent).toBe(collectionTitle);
    expect(editions.textContent).toContain(supplied.links[0]!.label);
    expect(editions.textContent).not.toContain(supplied.links[1]!.label);
    const expected = `/fr/subjects/${recording.subject}/les-lectures/editions?realm=realm%20%2F%2B%3F`;
    expect(more('editions').getAttribute('href')).toBe(expected);
    expect(more('editions').textContent).toBe(m.subject_view_all({ label: title }, { locale: 'fr' }));
    expect(more('editions').getAttribute('aria-describedby')).toBe('editions-title');
    expect(more('related').getAttribute('href')).toBe(
      `/fr/subjects/${recording.subject}/les-lectures/relations?property=local%3Arelated%20%2F%2B%3F&realm=realm%20%2F%2B%3F`,
    );
    expect(section('complete').querySelector('a')).toBeNull();
    for (const link of host.querySelectorAll<HTMLAnchorElement>('[data-slot="see-all"]')) assertAction(link);
    expect(editions.querySelector('h2')?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(more('editions'));
    await act(async () => user.keyboard('{Enter}'));
    expect(navigations).toEqual([expected]);

    await show({ status: 503, body: {} }, { status: 403, body: {} });
    expect(section('lists')).toBe(sibling);
    for (const [id, heading] of [
      ['editions', title],
      ['related', 'Œuvres liées'],
    ]) {
      const failed = section(id!);
      expect(within(failed).getByRole('heading', { name: heading! }).textContent).toBe(heading!);
      expect(failed.querySelector('[data-slot="count"], [data-slot="see-all"]')).toBeNull();
      const retry = within(failed).getByRole('link', {
        name: m.subject_section_retry({}, { locale: 'fr' }),
      }) as HTMLAnchorElement;
      assertAction(retry);
      expect(retry.getAttribute('href')).toBe('');
      // Empty-relative reloads keep the current query and omit the fragment, as before.
      expect(retry.href).toBe('https://site.test/fr/subjects/book/overview?realm=selected');
      expect(retry.getAttribute('aria-describedby')).toBe(`${id}-title ${id}-status`);
      expect(within(failed).getByRole('status').id).toBe(`${id}-status`);
      retry.focus();
      await act(async () => user.keyboard('{Enter}'));
    }
    expect(navigations.slice(1)).toEqual(['', '']);
    // A new supplied page response restores only the failed regions; the reload itself remains native.
    await show();
    expect(section('lists')).toBe(sibling);
    expect(section('editions').querySelector('[data-slot="retry"], [role="status"]')).toBeNull();
    expect(more('editions').getAttribute('href')).toBe(expected);
    await show({ status: 200, body: { links: supplied.links, next: 'opaque-native-cursor' } });
    expect(section('editions').querySelector('[data-slot="count"]')).toBeNull();
    expect(more('editions').getAttribute('href')).toBe(expected);
    await show({ status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } });
    expect(host.querySelector('#editions')).toBeNull();
    await show(undefined, undefined, null);
    expect(host.querySelectorAll('[data-slot="see-all"]')).toHaveLength(0);
    expect(supplied).toEqual(original);
    expect(reads).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    stop();
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
