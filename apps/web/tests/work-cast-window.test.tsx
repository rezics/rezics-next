import { expect, mock, test } from 'bun:test';
import { act, createElement as h, useState } from 'react';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type { RelationGroupRequest } from '../src/features/pages/relation-stream-query';
import { qualifiedStatement } from '../src/kernel/fake/qualified-relations';
import { workCastVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const snak = (property: string, data_type: string, content: unknown) => ({
  property: { id: property, data_type },
  value: { type: 'value', content },
});
const portrait = {
  media: id(70),
  width: 640,
  height: 960,
  placeholder: { thumbhash: 'Y1aKNHaGiHeAiIeHiHd3eIh4eHeAh4eH', color: '#8899aa' },
  variants: [{ format: 'webp', width: 320 }],
  focalPoint: null,
  credit: null,
};
const summary = (subject: string, label: string, type: string) => ({
  id: subject,
  type,
  types: [type],
  label: { value: label, language: 'en' },
  cover: type === 'schema:Person' || type === 'wd:Q95074' ? portrait : null,
});

function castPage(work: string, cursor: string | null, performerName = 'A. Performer', omitStatement?: string): Section {
  const performer = id(10);
  const unlabelledPerformer = id(18);
  const first = id(11);
  const second = id(12);
  const role = id(20);
  const secret = id(99);
  const characters = [id(30), id(31)];
  const disclosed = Object.fromEntries([
    [performer, summary(performer, 'A. Performer', 'schema:Person')],
    [characters[0]!, summary(characters[0]!, 'The Traveller', 'wd:Q95074')],
    [characters[1]!, summary(characters[1]!, 'The Archivist', 'wd:Q95074')],
    [role, summary(role, 'Voice performer', 'skos:Concept')],
    [secret, summary(secret, 'Secret Character', 'wd:Q95074')],
  ]);
  const row = (statementId: string, qualifiers: unknown[], related = disclosed) => {
    const statement = qualifiedStatement(statementId, 'wdt:P725', performer, qualifiers);
    return {
      target: performer,
      statement,
      label: performerName,
      type: 'schema:Person',
      summary: summary(performer, performerName, 'schema:Person'),
      related,
    };
  };
  const character = (target: string) => snak('wdt:P453', 'wikibase-item', target);
  const common = [
    character(characters[0]!),
    snak('wdt:P3831', 'wikibase-item', role),
    snak('wdt:P1932', 'string', 'A. Player'),
  ];
  const rows = [
    row(first, common),
    row(second, common),
    row(id(13), [character(characters[1]!), ...common.slice(1)]),
    row(id(14), [character(characters[0]!), character(characters[1]!), ...common.slice(1)]),
    row(id(15), [{ property: { id: 'wdt:P453', data_type: 'wikibase-item' }, value: { type: 'somevalue' } }]),
    row(
      id(16),
      [character(secret)],
      Object.fromEntries([
        [performer, disclosed[performer]!],
        [role, disclosed[role]!],
      ]),
    ),
    row(id(17), [character(secret), snak('rezics:spoilerLevel', 'quantity', { amount: '2' })]),
    {
      target: unlabelledPerformer,
      statement: qualifiedStatement(id(18), 'wdt:P725', unlabelledPerformer, common),
      label: '',
      type: 'schema:Person',
      summary: { id: unlabelledPerformer, type: 'schema:Person', types: ['schema:Person'], label: null, cover: null },
      related: disclosed,
    },
  ];
  return {
    ok: true,
    read: { kind: 'relations', id: work, context: id(50), property: 'wdt:P725', limit: 12 } as never,
    body: { relations: rows.filter((entry) => entry.statement.id !== omitStatement), next: cursor },
  };
}

function castValue(work: string, realm: string, context: string): OverviewValue {
  return {
    subject: work,
    subjectLabel: 'A visual novel',
    realm,
    locale: 'en',
    cacheReader: null,
    context: { id: context, population: { kind: 'realm', id: realm } },
    link: ({ href, children, ...props }) => h('a', { href, ...props }, children),
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: {
      spoilerShow: 'Reveal spoiler',
      cover: { withheld: 'Cover withheld', reveal: 'Reveal cover', credit: 'Cover credit', via: 'Cover via' },
    },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal spoiler',
    details: 'Details',
    cover: 'Cover',
    coverVia: 'via',
    licence: 'Licence',
    source: 'Source',
    sources: 'Sources',
    sections: new Map(),
    relations: {},
    relationDirections: [{ property: 'wdt:P725', direction: 'forward', state: 'admitted' }],
    relationNodes: [],
  } as unknown as OverviewValue;
}

test('mounted P725 cast stays on its current window, preserves assertion identity and retires stale delivery', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', Bun.resolveSync('@puckeditor/core', import.meta.dir)));
  const window = new Window({ url: 'https://rezics.test/' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const held: { request: RelationGroupRequest; resolve(value: Section): void; reject(error: Error): void }[] = [];
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  const { relationGroupKey } = await import('../src/features/pages/relation-stream-query');
  mock.module('../src/features/pages/relation-stream-query', () => ({
    relationGroupKey,
    loadRelationGroup: ({ data }: { data: RelationGroupRequest }) =>
      new Promise<Section>((resolve, reject) => held.push({ request: data, resolve, reject })),
  }));
  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    routing,
    { RelationStream, relationStreamItems },
    { castWindow },
    { defaultReader },
    { setLocale },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
    import('../src/features/pages/relation-stream'),
    import('../src/features/catalogue/work-cast/model'),
    import('../src/subject/reader'),
    import('../src/paraglide/runtime.js'),
  ]);
  setLocale('en', { reload: false });
  const work = id(1);
  const replacement = id(2);
  const realm = id(40);
  const context = id(50);
  const initial = { value: castValue(work, realm, context), section: castPage(work, 'opaque-window-2') };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData((await import('../src/session/query')).sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'reader',
  });
  let replace: (value: typeof initial) => void = () => {};
  let omitFocusedRow: (omit: boolean) => void = () => {};
  const rootRoute = routing.createRootRoute({
    component: () => {
      const [page, setPage] = useState(initial);
      const [omitRow, setOmitRow] = useState(false);
      const routeHref = routing.useRouterState({ select: (state) => state.location.href });
      replace = setPage;
      omitFocusedRow = setOmitRow;
      const cursor = new URL(routeHref, 'https://rezics.test').searchParams.get('cursor');
      const section =
        page.value.subject === work && cursor === 'opaque-window-2'
          ? castPage(work, 'cursor-3', 'A. Performer', omitRow ? id(11) : undefined)
          : page.section;
      return h(RelationStream, {
        value: { ...page.value, reader: defaultReader },
        section,
        node: 'cast',
        view: 'credits',
        title: 'Voice credits',
        workCast: true,
      });
    },
  });
  const router = routing.createRouter({
    routeTree: rootRoute,
    history: routing.createMemoryHistory({ initialEntries: ['/en/subjects/cast'] }),
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = () =>
    act(async () => root.render(h(QueryClientProvider, { client }, h(routing.RouterProvider, { router }))));
  const flush = () => act(async () => void (await Bun.sleep(0)));
  const click = async (element: HTMLElement) => {
    await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
    await flush();
  };
  try {
    await render();
    const section = initial.section as Extract<Section, { ok: true }>;
    const projected = relationStreamItems(section, initial.value)!;
    const metrics = [];
    for (const population of [64, 512, 4096]) {
      const unrelatedSubjects = Array.from({ length: population }, (_, n) => ({ id: id(1000 + n) }));
      const historicalAssertions = Array.from({ length: population }, (_, n) => ({ id: id(6000 + n) }));
      expect(unrelatedSubjects).toHaveLength(population);
      expect(historicalAssertions).toHaveLength(population);
      const windowView = castWindow(projected.items);
      metrics.push({
        typedCalls: held.length,
        retainedRows:
          windowView.groups.reduce((total, group) => total + group.performances.length, 0) + windowView.unpaired.length,
        responseBytes: new TextEncoder().encode(JSON.stringify(section.body)).length,
        loaded: windowView.groups.map((group) => group.performances.map((entry) => entry.performer.statement)),
      });
    }
    expect(metrics[1]).toEqual(metrics[0]);
    expect(metrics[2]).toEqual(metrics[0]);
    expect(metrics[0]!.typedCalls).toBe(0);
    expect(metrics[0]!.retainedRows).toBe(9);
    expect(metrics[0]!.loaded).toEqual([
      [id(11), id(12), id(14), id(18)],
      [id(13), id(14)],
    ]);
    expect(projected.items[0]!.summary?.cover).toEqual(portrait);
    expect(
      projected.items[0]!.qualified?.find((note) => note.property === 'wdt:P453')?.subject?.summary?.cover,
    ).toEqual(portrait);

    const group = host.querySelector('[role="group"][aria-label="Voice cast presentation"]')!;
    expect((group.querySelector('button') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('Role: Voice performer');
    expect(host.textContent).toContain('Credited as: A. Player');
    expect([...host.querySelectorAll('h3')].map((heading) => heading.textContent)).not.toContain('Secret Character');
    const characterLink = [...host.querySelectorAll('a')].find((link) => link.textContent?.includes('The Traveller'))!;
    expect(characterLink.getAttribute('target')).toBe('_blank');
    expect(characterLink.getAttribute('rel')).toContain('noopener');
    expect(characterLink.getAttribute('href')).toContain(`/subjects/${id(30)}/`);
    expect(new URL(characterLink.getAttribute('href')!, 'https://rezics.test').searchParams.get('realm')).toBe(realm);
    const via = new URL(characterLink.getAttribute('href')!, 'https://rezics.test').searchParams.get('via');
    expect(via).toContain(`/subjects/${work}/`);
    expect(new URL(via!, 'https://rezics.test').searchParams.get('realm')).toBe(realm);
    const characterReturn = new URL(via!, 'https://rezics.test');
    expect(characterReturn.searchParams.get('node')).toBe('cast');
    expect(workCastVisitReturn(characterReturn.hash)).toMatchObject({
      context,
      node: 'cast',
      presentation: 'character',
      statement: id(11),
      character: id(30),
      history: [],
    });
    const inspection = [...host.querySelectorAll('a')].find((link) => link.textContent === 'Inspect original credit')!;
    expect(inspection.target).toBe('_blank');
    const inspectionAddress = new URL(inspection.href);
    expect(inspectionAddress.pathname).toContain(`/subjects/${work}/`);
    expect(inspectionAddress.searchParams.get('property')).toBe('wdt:P725');
    expect(inspectionAddress.searchParams.get('statement')).toBe(id(11));
    expect(inspectionAddress.searchParams.get('context')).toBe(context);
    const inspectionReturn = new URL(inspectionAddress.searchParams.get('via')!, 'https://rezics.test');
    expect(workCastVisitReturn(inspectionReturn.hash)).toMatchObject({
      statement: id(11),
      character: id(30),
      presentation: 'character',
    });
    expect(
      [...host.querySelectorAll('a')].some((link) =>
        new URL(link.href).pathname.includes(`/subjects/${id(18)}/`),
      ),
    ).toBe(false);
    expect(host.textContent).not.toContain(id(18));
    const more = host.querySelector('[data-slot="continue-group"]') as HTMLAnchorElement;
    expect(new URL(more.href).searchParams.get('cursor')).toBe('opaque-window-2');
    characterLink.focus();
    const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    characterLink.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
    expect(window.document.activeElement).toBe(characterLink);
    expect(host.querySelector('[data-presentation="character"]')).not.toBeNull();

    await click(group.querySelectorAll('button')[1]!);
    expect(
      [...host.querySelectorAll('li[data-statement]')].slice(0, 8).map((row) => row.getAttribute('data-statement')),
    ).toEqual([id(11), id(12), id(13), id(14), id(15), id(16), id(17), id(18)]);
    await click(more);
    held[0]!.reject(new TypeError('Network connection lost'));
    await flush();
    expect(host.querySelector('[data-slot="continue-group"]')?.textContent).toContain('Retry');
    expect(host.querySelector('[data-presentation="credit-order"]')).not.toBeNull();
    await click(host.querySelector('[data-slot="continue-group"]') as HTMLAnchorElement);
    expect(held[1]!.request).toEqual(held[0]!.request);
    held[1]!.resolve(castPage(work, 'cursor-3'));
    await flush();
    expect(host.querySelector('[data-presentation="credit-order"]')).not.toBeNull();
    expect(
      new URL((host.querySelector('[data-slot="continue-group"]') as HTMLAnchorElement).href).searchParams.get(
        'cursor',
      ),
    ).toBe('cursor-3');
    const previous = host.querySelector('[data-slot="previous-group"]') as HTMLAnchorElement;
    expect(previous).not.toBeNull();
    const previousAddress = new URL(previous.href);
    expect(previousAddress.searchParams.get('cursor')).toBeNull();
    expect(workCastVisitReturn(previousAddress.hash)).toMatchObject({
      context,
      node: 'cast',
      presentation: 'credit-order',
      history: [],
    });
    const returnedPerformer = [...host.querySelectorAll('a')].find((link) => link.textContent === 'A. Performer')!;
    const returnedVia = new URL(returnedPerformer.href).searchParams.get('via')!;
    const exactReturn = new URL(returnedVia, 'https://rezics.test');
    expect(exactReturn.searchParams.get('cursor')).toBe('opaque-window-2');
    expect(workCastVisitReturn(exactReturn.hash)).toMatchObject({
      context,
      statement: id(11),
      presentation: 'credit-order',
      history: [null],
    });
    await router.navigate({ href: returnedVia });
    await flush();
    const focusedReturn = host.querySelector(`li[data-statement="${id(11)}"]`);
    expect(window.document.activeElement).toBe(focusedReturn);
    expect(host.querySelector('[data-presentation="credit-order"]')).not.toBeNull();
    await act(async () => omitFocusedRow(true));
    await flush();
    expect(host.textContent).toContain('This cast window has changed since you left.');
    expect(host.querySelector('[data-slot="restart-group"]')).not.toBeNull();
    await router.navigate({ href: previous.href });
    await flush();
    expect(host.querySelector('[data-slot="previous-group"]')).toBeNull();
    expect(host.textContent).not.toContain('This cast window has changed since you left.');
    await click(host.querySelector('[data-slot="continue-group"]') as HTMLAnchorElement);
    expect(held[2]!.request.cursor).toBe('opaque-window-2');

    const nextValue = castValue(replacement, realm, context);
    await act(async () => replace({ value: nextValue, section: castPage(replacement, null, 'New performer') }));
    await flush();
    held[2]!.resolve(castPage(work, null, 'Old delivery'));
    await flush();
    expect(host.textContent).toContain('New performer');
    expect(host.textContent).not.toContain('Old delivery');
    expect(host.querySelector('[data-slot="relation-stream"]')?.getAttribute('data-node')).toBe('cast');
    expect(host.querySelector('[data-slot="continue-group"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}, 15_000);
