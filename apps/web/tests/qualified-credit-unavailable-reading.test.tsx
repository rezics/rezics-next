import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { Stmt, Snak } from '../src/features/pages/shared';
import type { SubjectSummary } from '../src/media/summary';
import { qualifiedRelationsPage, qualifiedRealm } from '../src/kernel/fake/qualified-relations';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { m } from '../src/paraglide/messages.js';
import { relationDefinitions } from '../src/subject/relations';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { qualifiedNotes } = await import('../src/features/pages/qualified-relations');
const { SubjectPage, pageContext, pageRelationProperties } = await import('../src/features/pages/subject');

type CreditRow = {
  statement: Stmt;
  target: string;
  label: string;
  summary: NonNullable<SubjectSummary>;
  related: Record<string, SubjectSummary>;
};
const snak = (id: string, data_type: string, content: unknown): Snak => ({
  property: { id, data_type },
  value: { type: 'value', content },
});
const personLabel = 'Alexandra — 旅人の声 — ' + 'InternationalPerformer'.repeat(8);
const roleLabel = 'Narrator — 語り手 — الراوي\n' + 'ArchivalVoice'.repeat(12);
const creditedAs = '旅人の声と回想場面の語り\n復元された国際版';
const arabicName = 'صوت الراوي في النسخة الأصلية';
const longNote = 'RestoredEdition'.repeat(16) + '\nOriginal spelling retained';

/** Change only finite supplied text/projections in the existing native page DTO. */
function readingPage() {
  const page = structuredClone(qualifiedRelationsPage({ realm: qualifiedRealm }));
  page.document.content = page.document.content.filter((node) => ['header', 'cast'].includes(String(node.props.id)));
  delete page.document.content.find((node) => node.props.id === 'cast')!.props.title;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const cast = page.reads[plan.nodes.cast!]!.body as { relations: CreditRow[] };
  const first = cast.relations[0]!;
  const role = String(first.statement.qualifiers.find((q) => q.property.id === 'wdt:P3831')!.value.content);
  const character = String(first.statement.qualifiers.find((q) => q.property.id === 'wdt:P453')!.value.content);
  const part = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e99';
  first.label = personLabel;
  first.summary.label = { value: personLabel, language: 'en' };
  first.related = {
    [role]: { ...first.related[role]!, label: { value: roleLabel, language: 'en' } },
    [character]: null,
    [part]: { id: part, type: 'wd:Q2620972', label: { value: ' \n\t', language: 'en' } },
  };
  first.statement.qualifiers = [
    snak('wdt:P1545', 'quantity', { amount: '+0002.50', unit: '1' }),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P453', 'wikibase-item', character),
    snak('wdt:P1932', 'monolingualtext', { text: creditedAs, language: 'ja' }),
    snak('wdt:P518', 'wikibase-item', part),
    snak('schema:character', 'wikibase-item', character),
    snak('schema:position', 'external-id', 'II'),
    snak('wdt:P1932', 'string', longNote),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P1932', 'monolingualtext', { text: arabicName, language: 'ar' }),
  ];
  const unqualified = structuredClone(first);
  unqualified.statement.id = 'unqualified-credit';
  unqualified.statement.qualifiers = [];
  unqualified.label = 'A genuinely unqualified performer';
  const spoiler = structuredClone(first);
  spoiler.statement.id = 'spoiler-credit';
  spoiler.label = 'Spoiler performer';
  spoiler.statement.qualifiers = [
    snak('wdt:P1932', 'string', 'Concealed credited name'),
    snak('wdt:P453', 'wikibase-item', character),
    snak('rezics:spoilerLevel', 'quantity', { amount: '+2', unit: '1' }),
  ];
  cast.relations = [first, unqualified, spoiler];
  return { page, role, character, part, person: first.target };
}

test('unavailable item labels retain their localized categories without inventing identities or changing note shapes', () => {
  const { page, role, character } = readingPage();
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const statement = (page.reads[plan.nodes.cast!]!.body as { relations: CreditRow[] }).relations[0]!.statement;
  const item = { ...statement, qualifiers: [snak('wdt:P3831', 'wikibase-item', role)] };
  const malformed = [
    undefined,
    null,
    [],
    3,
    'label',
    {},
    { label: null },
    { label: [] },
    { label: { value: 17 } },
    { label: { value: '' } },
    { label: { value: ' \n\t' } },
  ];
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    const options = { locale: locale as never };
    for (const supplied of malformed) {
      expect(qualifiedNotes(item, { [role]: supplied }, locale)).toEqual([
        {
          property: 'wdt:P3831',
          text: `${m.subject_credit_role({}, options)}: ${m.subject_value_unlabelled({}, options)}`,
        },
      ]);
    }
  }
  expect(qualifiedNotes(item, Object.create({ [role]: { id: role, label: { value: 'Inherited' } } }), 'en')).toEqual([
    { property: 'wdt:P3831', text: 'Role: Unlabelled subject' },
  ]);
  for (const id of [undefined, null, 12, '', ' \t']) {
    expect(qualifiedNotes(item, { [role]: { id, label: { value: 'Disclosed label' } } }, 'en')).toEqual([
      { property: 'wdt:P3831', text: 'Role: Unlabelled subject' },
    ]);
  }
  // A matching summary keeps its supplied label and links to the requested target.
  expect(qualifiedNotes(item, { [role]: { id: role, label: { value: '  Disclosed label  ', language: 'en' } } }, 'en')).toEqual([
    {
      property: 'wdt:P3831',
      text: 'Role:   Disclosed label  ',
      subject: { id: role, label: '  Disclosed label  ' },
    },
  ]);
  expect(qualifiedNotes(item, { [role]: { id: role, label: 'Readable string label' } }, 'en')).toEqual([
    {
      property: 'wdt:P3831',
      text: 'Role: Readable string label',
      subject: { id: role, label: 'Readable string label' },
    },
  ]);
  expect(
    qualifiedNotes(
      {
        ...statement,
        qualifiers: [
          snak('example:unknown', 'wikibase-item', role),
          { property: { id: 'wdt:P453', data_type: 'wikibase-item' }, value: { type: 'somevalue' } },
          { property: { id: 'wdt:P518', data_type: 'wikibase-item' }, value: { type: 'novalue' } },
          snak('wdt:P3831', 'wikibase-item', { id: role }),
        ],
      },
      {},
      'en',
    ),
  ).toEqual([]);
});

test('Credits retain actual role, character and part qualifier categories when their supplied human labels are unavailable, while known qualifiers keep independent native links and full readable meaning.', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/work/cast/credits', width: 320 });
  const requests: string[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new Error('This supplied credit journey requires no new reads');
    }) as typeof fetch,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const library = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', library));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', library));
  const { subjectHref } = await import('../src/subject/subject-href');
  const { page, role, character, part, person } = readingPage();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      component: () => (
        <QueryClientProvider client={client}>
          <SubjectPage
            page={page}
            locale="en"
            relations={relationDefinitions(definitions.release, pageRelationProperties(page), 'en')}
            renderJsonLd={false}
            reader={{ spoilerLevel: 0, suitability: 'blur' }}
            messages={{
              unknown: 'Unknown',
              none: 'None',
              unlabelled: 'Unlabelled',
              sources: 'Sources',
              spoilerShow: 'Show spoiler',
            }}
          />
        </QueryClientProvider>
      ),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: [`/en/subjects/${page.subject}/cast?realm=${qualifiedRealm}`] }),
    });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    const reader = within(host as unknown as HTMLElement);
    const user = userEvent.setup({ document: window.document });
    // DOM semantics and focus only. Browser geometry at these sizes is authored in the story, not inferred here.
    for (const [width, scale, direction] of [
      [320, 1, 'ltr'],
      [320, 2, 'rtl'],
      [1280, 1, 'ltr'],
    ] as const) {
      window.happyDOM.setWindowSize({ width, height: 900 });
      window.document.documentElement.style.fontSize = `${16 * scale}px`;
      host.dir = direction;
      const list = reader.getByRole('list', { name: 'Cast' });
      const rows = Array.from(list.children) as HTMLElement[];
      expect(rows.map((row) => row.tagName)).toEqual(['LI', 'LI', 'LI']);
      const facts = within(rows[0]!).getAllByRole('listitem') as HTMLElement[];
      expect(facts.map((fact) => fact.textContent)).toEqual([
        'Order: +0002.50',
        `Role: ${roleLabel}`,
        'Character: Unlabelled subject',
        `Credited as: ${creditedAs} Japanese`,
        'Applies to part: Unlabelled subject',
        'Character: Unlabelled subject',
        'Order: II',
        `Credited as: ${longNote}`,
        `Role: ${roleLabel}`,
        `Credited as: ${arabicName} Arabic`,
      ]);
      for (const index of [2, 4, 5]) expect(facts[index]!.querySelector('a')).toBeNull();
      expect(rows[1]!.querySelector('ul')).toBeNull();
      expect(within(rows[1]!).getAllByRole('link')).toHaveLength(1);
      expect(reader.queryByText('Spoiler performer')).toBeNull();
      expect(reader.queryByText('Concealed credited name')).toBeNull();
      for (const id of [character, part]) expect(host.outerHTML).not.toContain(id);
      expect(list.querySelector('a a')).toBeNull();
      expect(rows[0]!.querySelector('[lang="ja"]')!.textContent).toBe(`Credited as: ${creditedAs}`);
      expect(rows[0]!.querySelector('[lang="ar"]')!.textContent).toBe(`Credited as: ${arabicName}`);
      const links = within(rows[0]!).getAllByRole('link') as HTMLAnchorElement[];
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        `${subjectHref({ id: person, label: personLabel }, 'en').href}?realm=${qualifiedRealm}`,
        `${subjectHref({ id: role, label: roleLabel }, 'en').href}?realm=${qualifiedRealm}`,
        `${subjectHref({ id: role, label: roleLabel }, 'en').href}?realm=${qualifiedRealm}`,
      ]);
      links[0]!.focus();
      for (let index = 0; index < links.length; index++) {
        if (index > 0) await act(async () => user.tab());
        expect(window.document.activeElement).toBe(links[index]);
        await act(async () => user.keyboard('{Enter}'));
        expect(destinations.pop()).toBe(links[index]!.getAttribute('href'));
      }
      const more = within(list.closest('section')!).getByRole('link', { name: 'More: Cast' });
      const url = new URL(more.getAttribute('href')!, window.location.href);
      expect(url.searchParams.get('node')).toBe('cast');
      expect(url.searchParams.get('cursor')).toBe('cast-next');
      expect(url.searchParams.get('realm')).toBe(qualifiedRealm);
    }
    await act(async () => user.click(reader.getByRole('button', { name: 'Show spoiler' })));
    const spoiler = reader.getByRole('link', { name: 'Spoiler performer' }).closest('article')!;
    expect(within(spoiler).getByText('Character: Unlabelled subject').closest('a')).toBeNull();
    expect(within(spoiler).getByText('Credited as: Concealed credited name')).toBeTruthy();
    expect(spoiler.outerHTML).not.toContain(character);
    await act(async () => user.click(reader.getByRole('button', { name: 'Hide spoilers' })));
    expect(reader.queryByRole('link', { name: 'Spoiler performer' })).toBeNull();
    expect(requests).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
