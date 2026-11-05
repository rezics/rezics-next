import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { RowValue } from '../src/features/pages/overview';

test('default qualified relation list exposes full readable credit facts and working current subject links', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/work/cast/credits', width: 390 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const testingLibrary = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', testingLibrary));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testingLibrary));
  const { CoverList } = await import('../src/features/pages/cover-list');
  const { holderItems } = await import('../src/features/pages/overview');
  const { SubjectLink } = await import('../src/features/pages/route-support');
  const { qualifiedStatement, qualifiedRealm } = await import('../src/kernel/fake/qualified-relations');
  const person = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e94';
  const character = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e95';
  const role = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e96';
  const secret = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e98';
  const creditedAs = '旅人の声と回想場面の語りを担当したアレクサンドラ・プレイヤー';
  const roleTitle = 'Principal voice performer and narrator of the extended archival recollections';
  const snak = (id: string, data_type: string, content: unknown) => ({
    property: { id, data_type },
    value: { type: 'value', content },
  });
  const summary = (id: string, label: string, type = 'schema:Person') => ({
    id,
    type,
    types: [type],
    label: { value: label, language: 'en' },
    cover: null,
  });
  const related = {
    [role]: summary(role, roleTitle, 'skos:Concept'),
    [character]: summary(character, 'The Traveller', 'wd:Q95074'),
  };
  const first = qualifiedStatement('first', 'wdt:P725', person, [
    snak('schema:position', 'string', '2'),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P1932', 'monolingualtext', { text: creditedAs, language: 'ja' }),
    snak('wdt:P453', 'wikibase-item', character),
    snak('wdt:P453', 'wikibase-item', 'undisclosed-character'),
  ]);
  const second = qualifiedStatement('second', 'wdt:P725', person, [
    snak('schema:position', 'string', '1'),
    snak('wdt:P1932', 'string', 'Alex Player — additional voices in the restored international edition'),
  ]);
  const hidden = qualifiedStatement('hidden', 'wdt:P725', secret, [
    snak('wdt:P1932', 'string', 'Secret credited name'),
    snak('wdt:P453', 'wikibase-item', secret),
    snak('rezics:spoilerLevel', 'quantity', { amount: '+2', unit: '1' }),
  ]);
  const items = holderItems(
    {
      links: [
        ...[first, second].map((assertion) => ({
          subject: person,
          label: 'Alexandra Player',
          summary: summary(person, 'Alexandra Player'),
          assertion,
          related,
        })),
        {
          subject: secret,
          label: 'Secret performer',
          summary: summary(secret, 'Secret performer'),
          assertion: hidden,
          related: { [secret]: summary(secret, 'Secret character', 'wd:Q95074') },
        },
        { subject: 'unavailable-person', label: 'Unavailable performer', summary: null, assertion: first },
      ],
    },
    12,
  )!.items;
  const value: RowValue = {
    locale: 'en',
    link: SubjectLink,
    reader: { spoilerLevel: 0, suitability: 'blur' },
    labels: {
      spoilerShow: 'Show spoiler',
      documentSpoiler: 'Show spoiler',
      cover: { withheld: 'Sensitive cover', reveal: 'Show cover', credit: 'Cover credit', via: 'via' },
    },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Show spoiler',
    context: { id: qualifiedRealm, population: { kind: 'realm', id: qualifiedRealm, title: 'Cast community' } },
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  // Observe the native navigation boundary for Realm links; keep real anchors and their default keyboard activation.
  const destinations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as InstanceType<typeof window.Element>).closest('a');
    if (anchor) {
      event.preventDefault();
      destinations.push(anchor.getAttribute('href')!);
    }
  });
  try {
    const route = createRootRoute({
      component: () => createElement(CoverList, { items, value, label: 'Cast', preview: true }),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: [`/en/subjects/work/cast/credits?realm=${qualifiedRealm}`] }),
    });
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    const reader = within(host as unknown as HTMLElement);
    const user = userEvent.setup({ document: window.document });
    for (const width of [390, 1280]) {
      window.happyDOM.setWindowSize({ width, height: 900 });
      const list = reader.getByRole('list', { name: 'Cast' });
      const rows = Array.from(list.children) as HTMLElement[];
      expect(rows).toHaveLength(3);
      expect(reader.getAllByRole('link', { name: 'Alexandra Player' })).toHaveLength(2);
      const facts = within(rows[0]!).getAllByRole('listitem');
      expect(facts.map((fact: HTMLElement) => fact.textContent)).toEqual([
        'Order: 2',
        `Role: ${roleTitle}`,
        `Credited as: ${creditedAs} Japanese`,
        'Character: The Traveller',
        'Character: Unlabelled subject',
      ]);
      expect(within(rows[0]!).getByText('Character: Unlabelled subject').closest('a')).toBeNull();
      expect(within(rows[0]!).getByText(`Credited as: ${creditedAs}`).getAttribute('lang')).toBe('ja');
      expect(rows[1]!.textContent).toContain('Order: 1');
      expect(rows[1]!.textContent).toContain(
        'Credited as: Alex Player — additional voices in the restored international edition',
      );
      expect(reader.queryByText('Secret performer')).toBeNull();
      expect(reader.queryByText('Credited as: Secret credited name')).toBeNull();
      expect(reader.queryByRole('link', { name: 'Character: Secret character' })).toBeNull();
      expect(host.querySelector(`a[href*="${secret}"]`)).toBeNull();
      expect(host.innerHTML).not.toContain('undisclosed-character');
      expect(reader.queryByText('Unavailable performer')).toBeNull();
      expect(host.querySelector('a a')).toBeNull();
    }
    const personLink = reader.getAllByRole('link', { name: 'Alexandra Player' })[0]!;
    personLink.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(destinations.pop()).toBe(`/en/subjects/${person}/alexandra-player?realm=${qualifiedRealm}`);
    await act(async () => user.tab());
    expect(window.document.activeElement?.textContent).toBe(`Role: ${roleTitle}`);
    await act(async () => user.tab());
    const characterLink = reader.getByRole('link', { name: 'Character: The Traveller' });
    expect(window.document.activeElement).toBe(characterLink);
    expect(characterLink.parentElement?.closest('a')).toBeNull();
    await act(async () => user.keyboard('{Enter}'));
    expect(destinations.pop()).toBe(`/en/subjects/${character}/the-traveller?realm=${qualifiedRealm}`);
    await act(async () => user.click(characterLink));
    expect(destinations.pop()).toBe(`/en/subjects/${character}/the-traveller?realm=${qualifiedRealm}`);
    await act(async () => user.click(reader.getByRole('link', { name: `Role: ${roleTitle}` })));
    expect(destinations.pop()).toBe(
      `/en/subjects/${role}/principal-voice-performer-and-narrator-of-the-extended?realm=${qualifiedRealm}`,
    );
    await act(async () => user.click(reader.getByRole('button', { name: 'Show spoiler' })));
    expect(reader.getByRole('link', { name: 'Secret performer' })).toBeTruthy();
    expect(reader.getByText('Credited as: Secret credited name')).toBeTruthy();
    const secretLink = reader.getByRole('link', { name: 'Character: Secret character' });
    await act(async () => user.click(secretLink));
    expect(destinations.pop()).toBe(`/en/subjects/${secret}/secret-character?realm=${qualifiedRealm}`);
    expect(destinations).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
