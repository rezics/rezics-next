import { expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { Release } from '@rezics/definitions';
import type { ScreenRow } from '../src/features/catalogue/screen-profile-fields';
import type { ScreenCommand, ScreenRead } from '../src/features/catalogue/screen-profile';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import recorded from '../src/kernel/recorded/definitions-release.json';
import * as start from '../.storybook/react-start';

// One connected actual-component campaign. DOM construction and
// keyboard simulation do not prove browser geometry, native authorization, private SSR or backend growth.
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);

test('Screen initial family keeps independent controls, complete facts/credits, native replay and current-reader retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/screen', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    DocumentFragment: window.DocumentFragment,
    DOMParser: window.DOMParser,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Range: window.Range,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ScreenInitialFields, screenCreationControl, screenRowId } =
    await import('../src/features/catalogue/screen-profile-fields');
  const { ScreenProfile } = await import('../src/features/catalogue/screen-profile-view');
  const { screenInitialFacts, screenName } = await import('../src/features/catalogue/screen-profile');
  const { screenProfileFixture } = await import('../src/kernel/fake/catalogue-screen-profile');
  const { CandidateReaderBoundary, candidateSession } = await import('../src/subject/candidate-lifetime');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const outside = window.document.createElement('button');
  outside.textContent = 'Independent current reader focus';
  window.document.body.append(outside);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const originalReader = { state: 'signed-in' as const, subject: 'original-reader', csrfToken: 'original-csrf' };
  client.setQueryData(sessionQuery.queryKey, originalReader);
  let show!: (node: ReactNode) => void;
  function Surface() {
    const [node, setNode] = useState<ReactNode>(null);
    show = (next) => setNode(() => next);
    return node;
  }
  const route = createRootRoute({ component: Surface });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
  );
  const render = (node: ReactNode) => act(async () => show(node));
  const settle = (milliseconds = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const until = async (predicate: () => boolean) => {
    // The production picker deliberately debounces searches for 250ms.
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await settle(10);
    expect(predicate()).toBe(true);
  };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Unexpected family IO');
  });
  const fieldName = (id: string, release = recorded.release as Release, locale = 'en') =>
    screenName(release, id, locale).text;
  const section = (scope: HTMLElement, name: string, index = 0) =>
    within(scope).getAllByRole('heading', { name, level: 3 })[index]!.closest('section')! as HTMLElement;
  const textbox = (scope: HTMLElement, name: string) =>
    within(scope).getByRole('textbox', { name }) as HTMLInputElement;
  const select = (scope: HTMLElement, name: string) =>
    within(scope).getByRole('combobox', { name }) as HTMLSelectElement;
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const choose = (scope: HTMLElement, name: string, value: string) =>
    act(async () => user.selectOptions(select(scope, name), value));
  const replace = (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      if (value) await user.type(control, value);
    });
  const key = (keys: string) => act(async () => user.keyboard(keys));
  const add = async (scope: HTMLElement, property: string) => {
    const control = select(scope, m.character_add_fact());
    await choose(scope, m.character_add_fact(), property);
    control.focus();
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(within(scope).getByRole('button', { name: m.correction_add() }));
    await key('{Enter}');
    return section(
      scope,
      fieldName(property),
      within(scope).getAllByRole('heading', { name: fieldName(property), level: 3 }).length - 1,
    );
  };
  const association = (scope: HTMLElement) => {
    for (const label of scope.querySelectorAll<HTMLLabelElement>('label[for]')) {
      const target = window.document.getElementById(label.htmlFor)!;
      expect(label.htmlFor).not.toBe('');
      expect(target).not.toBeNull();
      expect(scope.contains(target as unknown as Node)).toBe(true);
      expect([...host.querySelectorAll('[id]')].filter((node) => node.id === label.htmlFor)).toHaveLength(1);
    }
  };
  const row = (
    property: string,
    content: Extract<ScreenRow['statement']['value'], { type: 'value' }>['content'],
    id = crypto.randomUUID(),
  ): ScreenRow => ({
    key: id,
    statement: {
      property: { id: property },
      value: { type: 'value', content },
      qualifiers: [],
      references: [],
      rank: 'normal',
    },
  });
  const observed: Record<string, ScreenRow[]> = {};
  let searches = 0;
  const person = '00000000-0000-4000-8000-000000000302';
  const secondPerson = '00000000-0000-4000-8000-000000000304';
  const parent = '00000000-0000-4000-8000-000000000301';
  const search = async () => {
    searches++;
    return [
      { id: person, title: 'A. Observer', types: ['schema:Person'], typeLabel: 'Person', cover: null },
      { id: secondPerson, title: 'B. Observer', types: ['schema:Person'], typeLabel: 'Person', cover: null },
      { id: parent, title: 'Observatory season', types: ['schema:TVSeason'], typeLabel: 'Season', cover: null },
      {
        id: '00000000-0000-4000-8000-000000000303',
        title: 'Wrong target',
        types: ['schema:Book'],
        typeLabel: 'Book',
        cover: null,
      },
    ];
  };
  function Fields({
    name,
    initial = [],
    release = recorded.release as Release,
    disabled = false,
    locale = 'en',
  }: {
    name: string;
    initial?: ScreenRow[];
    release?: Release;
    disabled?: boolean;
    locale?: string;
  }) {
    const [rows, setRows] = useState(initial);
    observed[name] = rows;
    return (
      <div data-fields={name}>
        <ScreenInitialFields
          type="schema:Episode"
          rows={rows}
          change={setRows}
          release={release}
          locale={locale}
          search={search}
          disabled={disabled}
        />
      </div>
    );
  }
  const fields = (name: string) => host.querySelector<HTMLElement>(`[data-fields="${name}"]`)!;
  const citation = `https://example.org/original/${'complete-citation-'.repeat(16)}?page=24#director`;
  const longScalar = '0.5000000000000000000000000000000000000000000000000000000000000000000001';
  const queuedSubmit = () => {
    const submit = within(host).getByRole('button', { name: m.catalogue_create_submit() });
    const form = submit.closest('form')!;
    // A form's named-property proxy need not enumerate React's expando keys.
    // Its submit button exposes the same renderer key for the queued callback.
    const key = Object.keys(submit).find((key) => key.startsWith('__reactProps$'))!;
    const callback = Reflect.get(form, key).onSubmit as (event: unknown) => void;
    return () => callback({ currentTarget: form, preventDefault() {} });
  };
  const nativeWrites = (fixture: ReturnType<typeof screenProfileFixture>) =>
    fixture.creation.calls.filter((call) => call.method === 'POST');
  const prepare = async () => {
    await until(() => host.querySelector('#create-type') !== null);
    await choose(host, m.catalogue_create_type(), 'schema:Episode');
    await replace(textbox(host, m.catalogue_create_label()), 'The observatory');
  };
  const SessionProfile = candidateSession(ScreenProfile);
  const complete = async () => {
    const director = await add(host, 'schema:director');
    await replace(select(director, fieldName('schema:director')), 'Observer');
    await until(() => within(window.document.body).queryByRole('option', { name: /A\. Observer/ }) !== null);
    expect(within(window.document.body).queryByRole('option', { name: /Wrong target/ })).toBeNull();
    await act(async () => user.click(within(window.document.body).getByRole('option', { name: /A\. Observer/ })));
    await choose(director, m.correction_add_qualifier(), 'schema:position');
    await replace(textbox(director, m.correction_value()), '2');
    await replace(textbox(director, m.relation_citation()), citation);
    const duration = await add(host, 'schema:duration');
    await replace(textbox(duration, m.correction_amount()), '+1440');
    await choose(duration, m.correction_unit(), 'http://www.wikidata.org/entity/Q11574');
    const episode = await add(host, 'schema:episodeNumber');
    await replace(textbox(episode, m.correction_value()), '0.5');
    const part = await add(host, 'schema:isPartOf');
    await replace(select(part, fieldName('schema:isPartOf')), 'Observatory');
    await until(() => within(window.document.body).queryByRole('option', { name: /Observatory season/ }) !== null);
    expect(within(window.document.body).queryByRole('option', { name: /A\. Observer/ })).toBeNull();
    await act(async () => user.click(within(window.document.body).getByRole('option', { name: /Observatory season/ })));
  };
  try {
    // Independent mounts change only their own selector, preserve row-key addresses and keyboard order.
    await render(
      <>
        <Fields name="first" />
        <Fields name="second" />
      </>,
    );
    const a = select(fields('first'), m.character_add_fact());
    const b = select(fields('second'), m.character_add_fact());
    expect(a.id).not.toBe(b.id);
    association(fields('first'));
    association(fields('second'));
    const director = await add(fields('second'), 'schema:director');
    expect(observed.first).toHaveLength(0);
    expect(observed.second).toHaveLength(1);
    const directorKey = observed.second![0]!.key;
    expect(director.id).toBe(screenRowId(observed.second![0]!));
    expect(director.querySelector(':scope > h3')?.textContent).toBe(fieldName('schema:director'));
    expect(director.querySelector('h3')?.getAttribute('data-content-item-slot')).toBe('title');
    expect(director.parentElement!.classList.contains('isolate')).toBe(true);
    expect(director.classList.contains('border')).toBe(false);
    expect(director.closest('fieldset')!.querySelector('legend')!.textContent).toBe(m.screen_initial_facts());
    expect(select(director, m.correction_add_qualifier()).id).toBe(`screen-qualifier-${directorKey}`);
    expect(textbox(director, m.relation_citation()).id).toStartWith(director.id);
    await choose(director, m.correction_add_qualifier(), 'schema:position');
    await replace(textbox(director, m.correction_value()), '2');
    await replace(textbox(director, m.relation_citation()), ` ${citation} `);
    expect(observed.second![0]!.statement.references).toEqual([
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
    ]);
    expect(observed.second![0]!.statement.qualifiers).toEqual([
      { property: { id: 'schema:position' }, value: { type: 'value', content: '2' } },
    ]);
    association(fields('second'));
    const removeQualifier = within(director).getAllByRole('button', { name: m.relation_remove() })[0]!;
    removeQualifier.focus();
    await key('{Enter}');
    await act(async () => user.click(within(director).getAllByRole('button', { name: m.relation_remove() })[0]!));
    expect(observed.second![0]!.statement.qualifiers).toEqual([]);
    within(director).getAllByRole('button', { name: m.relation_remove() }).at(-1)!.focus();
    await key('{Enter}');
    within(director).getAllByRole('button', { name: m.relation_remove() }).at(-1)!.focus();
    await key('{Enter}');
    expect(observed.second).toEqual([]);
    expect(fields('first').querySelector('section')).toBeNull();
    expect(a.id).toBe(select(fields('first'), m.character_add_fact()).id);

    // Single and multivalued released properties retain the original eligibility.
    await add(fields('first'), 'schema:duration');
    expect([...a.options].some((option) => option.value === 'schema:duration')).toBe(false);
    await add(fields('first'), 'schema:director');
    await add(fields('first'), 'schema:director');
    const credits = fields('first').querySelectorAll('section');
    expect(credits).toHaveLength(3);
    expect(credits[1]!.id).toBe(screenRowId(observed.first![1]!));
    expect(credits[2]!.id).toBe(screenRowId(observed.first![2]!));
    expect(credits[1]!.id).not.toBe(credits[2]!.id);
    expect([...a.options].some((option) => option.value === 'schema:director')).toBe(true);
    expect(fields('first').textContent).toContain(m.screen_authored_after());

    // Full supplied localized names/strings/citations stay in the actual DOM in both directions.
    // Browser plays own geometry; setting a DOM viewport is not geometry evidence.
    const release = structuredClone(recorded.release) as Release;
    const longName = `Director — ${'完整名稱 اسم طويل Full released property name '.repeat(8)}`.trimEnd();
    for (const locale of ['en', 'ar']) release.properties['schema:director']!.labels[locale] = longName;
    const initial = [
      row('schema:director', person),
      row('schema:episodeNumber', longScalar),
      row('schema:duration', { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' }),
      row('schema:isPartOf', parent),
    ];
    initial[0]!.statement.qualifiers = [
      { property: { id: 'schema:position' }, value: { type: 'value', content: '2' } },
    ];
    initial[0]!.statement.references = [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
    ];
    const preserved = structuredClone(initial);
    preserved[0]!.statement.qualifiers!.push({
      property: { id: 'schema:position' },
      value: { type: 'value', content: '3' },
    });
    preserved[0]!.statement.references[0]!.parts.push({
      property: { id: 'future:opaque' },
      value: { type: 'novalue' },
    });
    preserved[0]!.statement.references.push({
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/second-group' } },
      ],
    });
    await render(<Fields name="preserved" initial={preserved} />);
    const resolve = (path: string) =>
      screenCreationControl(`/statements/schema:director/0${path}`, observed.preserved!, release, 'en');
    const nested = resolve('/qualifiers/1/value/content')!;
    const citationTarget = resolve('/references/1/parts/0/value/content')!;
    await replace(
      window.document.getElementById(citationTarget.id)! as unknown as HTMLElement,
      'https://example.org/revised',
    );
    expect(observed.preserved![0]!.statement.references[0]).toEqual(preserved[0]!.statement.references[0]);
    await act(async () =>
      user.click(
        within(section(fields('preserved'), fieldName('schema:director'))).getAllByRole('button', {
          name: m.relation_remove(),
        })[0]!,
      ),
    );
    await act(async () =>
      user.click(
        within(section(fields('preserved'), fieldName('schema:director'))).getAllByRole('button', {
          name: m.relation_remove(),
        })[0]!,
      ),
    );
    expect(resolve('/qualifiers/0/value/content')!.id).toBe(nested.id);
    for (const path of [
      '/future',
      '/references/0/parts/1/value/content',
      '/qualifiers/9/value/content',
      '/value/content/future',
    ])
      expect(resolve(path)).toBeUndefined();
    for (const [width, locale, dir] of [
      [390, 'en', 'ltr'],
      [1280, 'en', 'ltr'],
      [390, 'ar', 'rtl'],
      [1280, 'ar', 'rtl'],
    ] as const) {
      await render(null);
      window.happyDOM.setWindowSize({ width, height: 900 });
      await render(
        <div dir={dir}>
          <Fields name="long" initial={initial} release={release} locale={locale} />
        </div>,
      );
      const scope = fields('long');
      expect(within(scope).getByRole('heading', { name: longName, level: 3 }).textContent).toBe(longName);
      expect([...scope.querySelectorAll('p')].some((node) => node.textContent === longScalar)).toBe(true);
      expect([...scope.querySelectorAll('p')].some((node) => node.textContent === citation)).toBe(true);
      expect(textbox(scope, m.correction_amount({}, { locale: locale as never })).value).toBe('+1440');
      expect(select(scope, m.correction_unit({}, { locale: locale as never })).value).toBe(
        'http://www.wikidata.org/entity/Q11574',
      );
      expect(scope.querySelector('a')).toBeNull();
      expect(scope.querySelector('[data-slot="list-row-control"]')).toBeNull();
      association(scope);
    }
    // Missing/retracted definition preserves supplied rows, exact data and explicit removal.
    const missing = structuredClone(release);
    delete missing.properties['schema:director'];
    await render(
      <div dir="ltr">
        <Fields name="long" initial={initial} release={missing} />
      </div>,
    );
    const stale = section(fields('long'), 'schema:director');
    expect(stale.textContent).toContain(m.correction_preserved());
    expect(observed.long![0]).toEqual(initial[0]);
    expect(
      [...select(fields('long'), m.character_add_fact()).options].some((option) => option.value === 'schema:director'),
    ).toBe(false);
    await render(
      <div>
        <Fields name="long" initial={initial} release={release} disabled />
      </div>,
    );
    // Happy DOM's :disabled matcher omits inherited fieldset disabling. Check that
    // native boundary directly and exercise an actual blocked Remove interaction.
    for (const control of fields('long').querySelectorAll('input, select, button'))
      expect(control.closest<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
    const disabledRows = observed.long;
    await act(async () => user.click(within(fields('long')).getAllByRole('button', { name: m.relation_remove() })[0]!));
    expect(observed.long).toBe(disabledRows);

    // Supplied-data growth only: distinct native UUIDv7 targets have independent
    // relation slots, admitting 1/8/64 credits below the total initial-fact bound.
    // No enumeration of the definitions population and no IO occurs while rendering supplied rows.
    await render(null);
    for (const count of [1, 8, 64]) {
      const rows = Array.from({ length: count }, (_, index) =>
        row('schema:director', `00000000-0000-7000-8000-${String(index + 1000).padStart(12, '0')}`),
      );
      expect(
        screenInitialFacts(
          recorded.release as Release,
          { type: 'schema:Episode', labels: { en: 'Supplied credits' }, descriptions: {}, aliases: {} },
          rows.map((entry) => entry.statement),
        ).errors,
      ).toEqual([]);
      let reads = 0;
      const bounded = {
        ...recorded.release,
        properties: new Proxy(recorded.release.properties, {
          get(target, property, receiver) {
            reads++;
            return Reflect.get(target, property, receiver);
          },
          ownKeys() {
            throw new Error('Unexpected whole-definition traversal');
          },
        }),
      } as Release;
      const before = searches;
      await render(<Fields key={count} name="growth" initial={rows} release={bounded} />);
      expect(fields('growth').querySelectorAll('h3[data-content-item-slot="title"]')).toHaveLength(count);
      expect(reads).toBeLessThanOrEqual(300 + 32 * count);
      expect(searches).toBe(before);
      expect(fetch.mock.calls).toHaveLength(0);
    }

    // Initial metadata recovery owns one pending read and only surviving keyboard focus intent.
    for (const mode of [
      'keyboard',
      'pointer',
      'moved-back',
      'pointer-during',
      'locale',
      'reader',
      'csrf',
      'session-aba',
      'unmount',
      'initial',
    ]) {
      await render(null);
      await act(async () => client.setQueryData(sessionQuery.queryKey, originalReader));
      const current = screenProfileFixture();
      const ready = await current.transport.load();
      let reads = 0;
      let deliver!: (read: ScreenRead) => void;
      const hold = () =>
        new Promise<ScreenRead>((resolve) => {
          deliver = resolve;
        });
      let response: Promise<ScreenRead> =
        mode === 'initial' ? hold() : Promise.resolve({ ok: false, reason: 'unavailable' });
      const transport = {
        ...current.transport,
        load: () => {
          reads++;
          return response;
        },
      };
      const editor = (locale = 'en', reader = originalReader) => (
        <CandidateReaderBoundary observed={reader} address="screen-metadata-recovery">
          <SessionProfile
            locale={locale}
            session="signed-in"
            transport={transport}
            search={search}
            onNavigate={() => {}}
          />
        </CandidateReaderBoundary>
      );
      outside.focus();
      await render(editor());
      if (mode === 'initial') {
        await until(() => host.querySelector('[role="status"]') !== null);
        await act(async () => deliver(ready));
        await until(() => host.querySelector('#create-type') !== null);
        expect(window.document.activeElement).toBe(outside);
        expect(reads).toBe(1);
        continue;
      }
      await until(() => host.textContent!.includes(m.correction_unavailable()));
      expect(window.document.activeElement).toBe(outside);
      const retry = within(host).getByRole('button', { name: m.correction_retry() }) as HTMLButtonElement;
      const props = Object.keys(retry).find((key) => key.startsWith('__reactProps$'))!;
      const queued = Reflect.get(retry, props).onClick as (event: {
        currentTarget: HTMLButtonElement;
        detail: number;
      }) => void;
      response = hold();
      retry.focus();
      if (mode === 'pointer') await act(async () => user.click(retry));
      else await key('{Enter}');
      await act(async () => {
        queued({ currentTarget: retry, detail: 0 });
        queued({ currentTarget: retry, detail: 0 });
      });
      expect(reads).toBe(2);
      expect(retry.disabled).toBe(true);
      expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
      expect(host.textContent).toContain(m.candidate_loading());
      expect(host.textContent).not.toContain(m.correction_unavailable());
      if (mode === 'keyboard') {
        await act(async () => deliver({ ok: false, reason: 'concealed' }));
        await until(() => !retry.disabled);
        expect(host.textContent).toContain(m.catalogue_create_concealed());
        expect(within(host).getByRole('button', { name: m.correction_retry() })).toBe(retry);
        expect(window.document.activeElement).toBe(retry);
        response = hold();
        await key(' ');
        expect(reads).toBe(3);
      }
      if (mode === 'moved-back') {
        outside.focus();
        retry.focus();
      }
      if (mode === 'pointer-during') retry.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
      const finish = deliver;
      response = Promise.resolve({ ok: false, reason: 'unavailable' });
      if (mode === 'locale') await render(editor('fr'));
      if (mode === 'reader') await render(editor('en', { ...originalReader, subject: 'replacement-reader' }));
      if (mode === 'csrf') await render(editor('en', { ...originalReader, csrfToken: 'replacement-csrf' }));
      if (mode === 'session-aba')
        await act(async () => {
          client.setQueryData(sessionQuery.queryKey, { ...originalReader, subject: 'replacement-reader' });
          client.setQueryData(sessionQuery.queryKey, originalReader);
        });
      if (mode === 'unmount') await render(null);
      await settle();
      const retired = ['locale', 'reader', 'csrf', 'session-aba', 'unmount'].includes(mode);
      const before = host.innerHTML;
      const beforeFocus = window.document.activeElement;
      const beforeReads = reads;
      await act(async () => finish(ready));
      await settle(15);
      if (retired) {
        expect(host.innerHTML).toBe(before);
        expect(window.document.activeElement).toBe(beforeFocus);
      } else {
        await until(() => host.querySelector('#create-type') !== null);
        if (mode === 'keyboard') expect(window.document.activeElement).toBe(host.querySelector('h1'));
        else expect(window.document.activeElement).not.toBe(host.querySelector('h1'));
      }
      await act(async () => queued({ currentTarget: retry, detail: 0 }));
      expect(reads).toBe(beforeReads);
      expect(nativeWrites(current)).toHaveLength(0);
    }

    // Actual whole creation: local invalid summary retains the native pointer and named fact anchor.
    await render(null);
    const fixture = screenProfileFixture('uncertain');
    let loads = 0;
    const commands: ScreenCommand[] = [];
    const navigations: string[] = [];
    const transport = {
      ...fixture.transport,
      load: () => {
        loads++;
        return fixture.transport.load();
      },
      create: (command: ScreenCommand) => {
        commands.push(structuredClone(command));
        return fixture.transport.create(command);
      },
    };
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        transport={transport}
        search={search}
        onNavigate={(href) => navigations.push(href)}
      />,
    );
    await prepare();
    const invalid = await add(host, 'schema:duration');
    await click(host, m.catalogue_create_submit());
    await until(() => host.textContent!.includes(m.catalogue_create_invalid()));
    expect(commands).toHaveLength(0);
    const anchor = [...host.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].find((node) =>
      decodeURIComponent(node.hash.slice(1)).startsWith(invalid.id),
    )!;
    expect(anchor.textContent).toContain(fieldName('schema:duration'));
    expect(host.textContent).toContain('/statements/schema:duration');
    await act(async () => user.click(anchor));
    expect(invalid.contains(window.document.activeElement as unknown as Node)).toBe(true);
    await click(invalid, m.relation_remove());
    const callsBefore = fixture.creation.calls.length;
    await complete();
    expect(fixture.creation.calls).toHaveLength(callsBefore);
    expect(loads).toBe(1);
    association(host);
    await click(host, m.catalogue_create_submit());
    await until(() => host.textContent!.includes(m.catalogue_create_uncertain()));
    expect(nativeWrites(fixture)).toHaveLength(1);
    const frozen = structuredClone(commands[0]!);
    expect(frozen.item.statements['schema:duration']![0]!.value).toEqual({
      type: 'value',
      content: { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' },
    });
    expect(frozen.item.statements['schema:episodeNumber']![0]!.value).toEqual({ type: 'value', content: '0.5' });
    expect(frozen.item.statements['schema:isPartOf']![0]!.value).toEqual({ type: 'value', content: parent });
    expect(frozen.item.statements['schema:director']![0]).toMatchObject({
      value: { type: 'value', content: person },
      qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }],
      references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }],
    });
    for (const control of host.querySelectorAll('fieldset input, fieldset select, fieldset button'))
      expect(control.closest<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
    const write = structuredClone(nativeWrites(fixture)[0]!);
    expect(write).toMatchObject({
      path: '/v1/subjects',
      authorization: 'Bearer fixture',
      key: frozen.key,
      body: frozen.item,
    });
    await click(host, m.catalogue_create_retry());
    await until(() => host.textContent!.includes(m.catalogue_create_created()));
    expect(commands).toEqual([frozen, frozen]);
    expect(nativeWrites(fixture)).toEqual([write, write]);
    expect(loads).toBe(1);
    expect(fixture.creation.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(fixture.creation.calls.at(-1)).toMatchObject({ authorization: null, session: 'created-session' });
    const link = within(host).getByRole('link', { name: m.catalogue_create_open() }) as HTMLAnchorElement;
    expect(navigations).toEqual([link.getAttribute('href')]);

    // Distinct denial, empty, unavailable, signed-out and stale-definition preservation use the existing seams.
    for (const scenario of ['denied', 'empty', 'definitions-unavailable', 'signed-out'] as const) {
      await render(null);
      const current = screenProfileFixture(scenario);
      await render(
        <ScreenProfile
          locale="en"
          session={scenario === 'signed-out' ? 'signed-out' : 'signed-in'}
          transport={current.transport}
          search={search}
          onNavigate={(href) => navigations.push(href)}
        />,
      );
      if (scenario === 'denied') {
        await prepare();
        await add(host, 'schema:episodeNumber');
        await replace(textbox(section(host, fieldName('schema:episodeNumber')), m.correction_value()), '0.5');
        await click(host, m.catalogue_create_submit());
        await until(() => host.textContent!.includes(m.catalogue_create_denied()));
        expect(textbox(host, m.catalogue_create_label()).value).toBe('The observatory');
        expect(nativeWrites(current)).toHaveLength(1);
      } else if (scenario === 'signed-out') {
        await until(
          () => host.textContent!.includes(m.catalogue_create_signed_out()) && host.querySelector('fieldset') !== null,
        );
        expect(host.querySelector('fieldset')?.matches(':disabled')).toBe(true);
        expect(nativeWrites(current)).toHaveLength(0);
      } else {
        await until(() =>
          host.textContent!.includes(scenario === 'empty' ? m.catalogue_create_empty() : m.correction_unavailable()),
        );
        expect(host.querySelector('form')).toBeNull();
        expect(nativeWrites(current)).toHaveLength(0);
      }
    }
    await render(null);
    const staleRelease = screenProfileFixture('invalid');
    let releaseReads = 0;
    const staleTransport = {
      ...staleRelease.transport,
      load: async () => {
        const result = await staleRelease.transport.load();
        if (result.ok && releaseReads++ > 0) {
          const release = structuredClone(result.release);
          delete release.properties['schema:episodeNumber'];
          for (const type of Object.values(release.types))
            type.properties = type.properties.filter((id) => id !== 'schema:episodeNumber');
          return { ...result, release };
        }
        return result;
      },
    };
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        transport={staleTransport}
        search={search}
        onNavigate={() => {
          throw new Error('Stale creation must not navigate');
        }}
      />,
    );
    await prepare();
    const staleRow = await add(host, 'schema:episodeNumber');
    await replace(textbox(staleRow, m.correction_value()), '0.5');
    await click(host, m.catalogue_create_submit());
    await until(() => host.textContent!.includes(m.correction_preserved()));
    expect(section(host, 'schema:episodeNumber')).toBe(staleRow);
    expect(nativeWrites(staleRelease)).toHaveLength(1);
    await click(host, m.catalogue_create_submit());
    expect(nativeWrites(staleRelease)).toHaveLength(1);

    // A rejected second credit resolves to its own inner controls through metadata failure and Type changes.
    await render(null);
    const recovery = screenProfileFixture('reader-unavailable');
    const submitted: ScreenCommand[] = [];
    const opened: string[] = [];
    let metadataReads = 0;
    const badPaths = ['/value/content', '/qualifiers/0/value/content', '/references/0/parts/0/value/content'];
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        search={search}
        onNavigate={(href) => opened.push(href)}
        transport={{
          ...recovery.transport,
          load: async () => {
            metadataReads++;
            if ([2, 3, 7].includes(metadataReads)) throw new Error('Metadata refresh failed');
            if (metadataReads === 4) return { ok: false, reason: 'unavailable' };
            return recovery.transport.load();
          },
          create: async (command) => {
            submitted.push(structuredClone(command));
            if (submitted.length <= 2)
              return {
                ok: false,
                reason: 'invalid',
                refreshDefinitions: true,
                errors: [...badPaths, '/future/value', '/qualifiers/9/value/content'].map((path) => ({
                  pointer: `/statements/schema:director/1${path}`,
                  code: 'invalid_format',
                })),
              };
            recovery.creation.setScenario(submitted.length === 3 ? 'uncertain' : 'reader-unavailable');
            if (submitted.length === 3)
              return { ...(await recovery.transport.create(command)), refreshDefinitions: true };
            return recovery.transport.create(command);
          },
        }}
      />,
    );
    await prepare();
    await complete();
    const firstCredit = section(host, fieldName('schema:director'));
    let secondCredit = await add(host, 'schema:director');
    await replace(select(secondCredit, fieldName('schema:director')), 'B. Observer');
    await until(() => within(window.document.body).queryByRole('option', { name: /B\. Observer/ }) !== null);
    await act(async () => user.click(within(window.document.body).getByRole('option', { name: /B\. Observer/ })));
    await choose(secondCredit, m.correction_add_qualifier(), 'schema:position');
    await replace(textbox(secondCredit, m.correction_value()), '3');
    await replace(textbox(secondCredit, m.relation_citation()), citation);
    await click(host, m.catalogue_create_add_language());
    await replace(host.querySelector<HTMLInputElement>('#create-language-1')!, 'ja');
    await replace(host.querySelector<HTMLInputElement>('#create-label-1')!, '天文台');
    await click(host, m.catalogue_create_submit());
    await until(
      () => metadataReads === 2 && !within(host).queryByRole('button', { name: m.catalogue_create_saving() }),
    );
    expect(host.querySelector<HTMLInputElement>('#create-label-0')!.value).toBe('The observatory');
    expect(host.querySelector<HTMLInputElement>('#create-label-1')!.value).toBe('天文台');
    expect(host.textContent).toContain(m.catalogue_create_unavailable());
    expect(
      (within(host).getByRole('button', { name: m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const metadata = client
      .getQueryCache()
      .findAll({ queryKey: ['screen-profile'] })
      .at(-1)!;
    expect(metadata.state).toMatchObject({ status: 'error', data: { ok: true } });
    await act(async () => queuedSubmit()());
    expect(submitted).toHaveLength(1);
    const correctionLinks = () => [...host.querySelectorAll<HTMLAnchorElement>('[role="alert"] a[href^="#"]')];
    expect(correctionLinks()).toHaveLength(3);
    const rejectedTargets = correctionLinks().map((link) => decodeURIComponent(link.hash.slice(1)));
    for (const link of correctionLinks()) {
      expect(link.textContent).toContain(`${fieldName('schema:director')} 2`);
      await act(async () => user.click(link));
      expect(secondCredit.contains(window.document.activeElement as unknown as Node)).toBe(true);
      expect(firstCredit.contains(window.document.activeElement as unknown as Node)).toBe(false);
    }
    for (const count of [3, 4]) {
      await click(host, m.catalogue_create_retry());
      await until(
        () =>
          metadataReads === count &&
          !(within(host).getByRole('button', { name: m.catalogue_create_retry() }) as HTMLButtonElement).disabled,
      );
      expect(host.textContent).toContain(m.catalogue_create_unavailable());
      expect(submitted).toHaveLength(1);
    }
    await click(host, m.catalogue_create_retry()); // Only successful current metadata recovers the draft.
    await until(
      () =>
        metadataReads === 5 &&
        !(within(host).getByRole('button', { name: m.catalogue_create_submit() }) as HTMLButtonElement).disabled,
    );
    expect(host.textContent).not.toContain(m.catalogue_create_unavailable());
    expect(host.querySelector<HTMLInputElement>('#create-label-1')!.value).toBe('天文台');
    await choose(host, m.catalogue_create_type(), 'schema:Movie');
    expect(correctionLinks()).toHaveLength(0);
    for (const id of rejectedTargets) expect(window.document.getElementById(id)).toBeNull();
    await choose(host, m.catalogue_create_type(), 'schema:Episode');
    secondCredit = section(host, fieldName('schema:director'), 1);
    await click(host, m.catalogue_create_submit());
    await until(() => submitted.length === 2 && correctionLinks().length === 3);
    expect(correctionLinks().map((link) => decodeURIComponent(link.hash.slice(1)))).toEqual(rejectedTargets);
    await replace(textbox(secondCredit, m.correction_value()), '4');
    await replace(textbox(secondCredit, m.relation_citation()), 'https://example.org/corrected');
    await replace(select(secondCredit, fieldName('schema:director')), 'A. Observer');
    await until(() => within(window.document.body).queryByRole('option', { name: /A\. Observer/ }) !== null);
    await act(async () => user.click(within(window.document.body).getByRole('option', { name: /A\. Observer/ })));
    await click(host, m.catalogue_create_submit());
    await until(() => host.textContent!.includes(m.catalogue_create_uncertain()));
    expect(submitted[2]!.item.statements['schema:director']![0]).toEqual(
      submitted[0]!.item.statements['schema:director']![0],
    );
    expect(submitted[2]!.item.statements['schema:director']![1]).toMatchObject({
      value: { type: 'value', content: person },
      qualifiers: [{ value: { type: 'value', content: '4' } }],
      references: [{ parts: [{ value: { type: 'value', content: 'https://example.org/corrected' } }] }],
    });
    expect(select(host, m.catalogue_create_type()).disabled).toBe(true);
    await until(
      () => metadataReads === 7 && !within(host).queryByRole('button', { name: m.catalogue_create_saving() }),
    );
    expect(host.textContent).toContain(m.catalogue_create_unavailable());
    const sealedWrite = structuredClone(nativeWrites(recovery)[0]!);
    await click(host.querySelector('form')!, m.catalogue_create_retry());
    await until(() => host.textContent!.includes(m.catalogue_create_created()));
    expect(submitted[3]).toEqual(submitted[2]);
    expect(nativeWrites(recovery)).toEqual([sealedWrite, sealedWrite]);
    expect(metadataReads).toBe(7);
    expect(opened).toEqual([]);
    const exactId = recovery.creation.calls
      .find((call) => call.method === 'GET')!
      .path.split('/')
      .at(-1)!;
    recovery.creation.setScenario('ready');
    await click(host, m.catalogue_create_retry());
    await until(() => opened.length === 1);
    expect(opened[0]).toContain(exactId);
    expect(recovery.creation.calls.filter((call) => call.method === 'GET').map((call) => call.path)).toEqual([
      `/v1/subjects/${exactId}`,
      `/v1/subjects/${exactId}`,
    ]);
    expect(submitted).toHaveLength(4);

    // Retired work cannot submit again, deliver success/failure, reread, navigate or steal focus.
    // The session case uses the production candidateSession observer, including batched A-B-A.
    for (const transition of ['reader', 'csrf', 'signed-out', 'session-aba', 'locale', 'target', 'unmount'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        await render(null);
        await act(async () => client.setQueryData(sessionQuery.queryKey, originalReader));
        const current = screenProfileFixture();
        let resolve!: (result: CreateResult) => void;
        let reject!: (error: Error) => void;
        const held = new Promise<CreateResult>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        let result: CreateResult | undefined;
        let creates = 0;
        let reads = 0;
        let navigated = 0;
        const transport = {
          ...current.transport,
          load: () => {
            reads++;
            return current.transport.load();
          },
          create: async (command: ScreenCommand) => {
            creates++;
            result = await current.transport.create(command);
            return held;
          },
        };
        const editor = (reader = originalReader, locale = 'en', id?: string): ReactNode =>
          transition === 'session-aba' ? (
            <SessionProfile
              locale={locale}
              id={id}
              session="signed-in"
              transport={transport}
              search={search}
              onNavigate={() => {
                navigated++;
              }}
            />
          ) : (
            <CandidateReaderBoundary observed={reader} address="screen-retirement">
              <ScreenProfile
                locale={locale}
                id={id}
                session="signed-in"
                transport={transport}
                search={search}
                onNavigate={() => {
                  navigated++;
                }}
              />
            </CandidateReaderBoundary>
          );
        await render(editor());
        await prepare();
        const oldSubmit = queuedSubmit();
        await click(host, m.catalogue_create_submit());
        await until(() => result !== undefined);
        expect(creates).toBe(1);
        if (transition === 'reader') await render(editor({ ...originalReader, subject: 'replacement-reader' }));
        if (transition === 'csrf') await render(editor({ ...originalReader, csrfToken: 'replacement-csrf' }));
        if (transition === 'signed-out')
          await render(
            <CandidateReaderBoundary observed={{ state: 'signed-out', csrfToken: null }} address="screen-retirement">
              <ScreenProfile
                locale="en"
                session="signed-out"
                transport={transport}
                search={search}
                onNavigate={() => {
                  navigated++;
                }}
              />
            </CandidateReaderBoundary>,
          );
        if (transition === 'session-aba')
          await act(async () => {
            client.setQueryData(sessionQuery.queryKey, { ...originalReader, subject: 'replacement-reader' });
            client.setQueryData(sessionQuery.queryKey, originalReader);
          });
        if (transition === 'locale') await render(editor(originalReader, 'fr'));
        if (transition === 'target') await render(editor(originalReader, 'en', current.id));
        if (transition === 'unmount') await render(null);
        await settle();
        await settle();
        const before = host.textContent;
        const readCount = reads;
        const callCount = current.creation.calls.length;
        outside.focus();
        await act(async () => oldSubmit());
        expect(creates).toBe(1);
        await act(async () => {
          if (delivery === 'throw') reject(new Error('Late screen delivery unavailable'));
          else resolve(delivery === 'failure' ? { ok: false, reason: 'unavailable' } : result!);
        });
        await settle();
        expect(host.textContent).toBe(before);
        expect(navigated).toBe(0);
        expect(reads).toBe(readCount);
        expect(current.creation.calls).toHaveLength(callCount);
        expect(window.document.activeElement).toBe(outside);
        expect(host.textContent).not.toContain(m.catalogue_create_created());
      }
    }
    expect(fetch.mock.calls).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    fetch.mockRestore();
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}, 30_000);
