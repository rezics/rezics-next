import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import type { CreateResult, CreateSubjectCommand, CreateTransport, InitialSubject } from '../src/features/catalogue/create-subject';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import type { ScreenRow } from '../src/features/catalogue/screen-profile-fields';

// The production components and request-backed story fixtures run in a DOM, without native services or a browser.
test('A contributor starts the actual creation task before alternative editors and completes a story arc without duplicate creation headings', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/new' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { StoryArcProfile } = await import('../src/features/catalogue/story-arc-profile-view');
  const { catalogueCreateFixture } = await import('../src/kernel/fake/catalogue-create');
  const { storyArcProfileFixture, storyArcCreatedId } = await import('../src/kernel/fake/catalogue-story-arc-profile');
  const { storyArcType } = await import('../src/features/catalogue/story-arc-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  const generic = catalogueCreateFixture();
  try {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CreateSubjectForm, {
            locale: 'en',
            session: 'signed-in',
            transport: generic.transport,
            onNavigate() {},
          }),
        ),
      );
    });
    await waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    });
    const name = canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    const language = canvas.getByRole('textbox', { name: m.catalogue_create_language() });
    const directory = canvas.getByRole('navigation', { name: m.facts_other_editors(), hidden: true });
    expect(host.querySelector('input, select, textarea')).toBe(name);
    expect(name.compareDocumentPosition(directory) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(language.compareDocumentPosition(directory) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      name.closest('form')!.compareDocumentPosition(directory) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const disclosure = directory.closest('details')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('summary')!.textContent).toBe(m.facts_other_editors());
    expect(Array.from(directory.querySelectorAll('a'), (link) => link.getAttribute('href'))).toEqual([
      '/en/catalogue/literary',
      '/en/catalogue/game',
      '/en/catalogue/recipe',
      '/en/catalogue/character',
      '/en/catalogue/screen',
      '/en/catalogue/manga',
      '/en/catalogue/people',
      '/en/catalogue/album',
    ]);
    await act(async () => {
      await user.type(name, '  A name & another  ');
      await user.selectOptions(canvas.getByRole('combobox', { name: m.catalogue_create_type() }), 'schema:Movie');
    });
    const search = canvas.getByRole('link', { name: `${m.catalogue_create_search()} · ${m.guide_new_tab()}` });
    expect(search.getAttribute('href')).toBe('/en/search?q=A%20name%20%26%20another');
    expect(name.getAttribute('aria-describedby')!.split(' ')).toContain(search.parentElement!.id);
    expect(search.getAttribute('target')).toBe('_blank');
    expect(search.getAttribute('rel')).toBe('noopener noreferrer');
    expect(name.value).toBe('  A name & another  ');
    expect(canvas.getByRole('combobox', { name: m.catalogue_create_type() }).value).toBe('schema:Movie');
    expect(generic.calls).toEqual([]);

    const arc = storyArcProfileFixture();
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(StoryArcProfile, { ...arc.props, locale: 'en', work: arc.work.id }),
        ),
      );
    });
    await waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    });
    expect(canvas.getAllByRole('heading', { name: m.story_arc_create() })).toHaveLength(1);
    expect(host.querySelector('h1')!.textContent).toBe(m.story_arc_create());
    expect(canvas.getByText(m.story_arc_creation_help())).toBeDefined();
    expect(canvas.getByRole('combobox', { name: m.story_arc_choose_existing() })).toBeDefined();
    expect(canvas.queryByRole('combobox', { name: m.catalogue_create_type() })).toBeNull();
    expect(host.querySelector('select#create-type')).toBeNull();
    expect(canvas.queryByText(m.catalogue_create_grain())).toBeNull();
    const arcName = canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    expect(arcName.closest('section')!.querySelectorAll('h1, h2')).toHaveLength(0);
    const form = within(arcName.closest('form')!);
    expect(form.getByText(storyArcType)).toBeDefined();
    expect(form.getByText(arc.release.types[storyArcType]!.labels.en!)).toBeDefined();
    expect(arcName.closest('form')!.querySelector('#create-type-help')!.textContent).toBe(
      arc.release.types[storyArcType]!.descriptions?.en ?? '',
    );
    expect(
      form.getByRole('link', { name: `${m.guide_type_help()} · ${m.guide_new_tab()}` }).getAttribute('href'),
    ).toContain(`type=${encodeURIComponent(storyArcType)}`);
    expect(canvas.queryByRole('link', { name: m.story_arc_continue() })).toBeNull();
    expect(arc.creation.calls).toEqual([]);
    await act(async () => {
      await user.type(arcName, 'A real arc');
      await user.type(form.getByRole('textbox', { name: m.catalogue_create_description() }), 'A named narrative range');
      await user.type(form.getByRole('textbox', { name: m.catalogue_create_aliases() }), 'Journey arc\nTravel arc');
      await user.click(form.getByRole('button', { name: m.catalogue_create_add_language() }));
    });
    await act(async () => {
      await user.type(form.getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!, 'ja');
      await user.type(form.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '旅の編');
      await user.type(form.getAllByRole('textbox', { name: m.catalogue_create_aliases() })[1]!, '旅路編');
      await user.click(form.getByRole('button', { name: m.catalogue_create_submit() }));
    });
    const writes = arc.creation.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: '/v1/subjects',
      body: {
        type: storyArcType,
        labels: { en: 'A real arc', ja: '旅の編' },
        descriptions: { en: 'A named narrative range' },
        aliases: { en: ['Journey arc', 'Travel arc'], ja: ['旅路編'] },
      },
    });
    expect(writes[0]!.key).toBeTruthy();
    expect(arc.creation.receipts.size).toBe(1);
    expect(arc.creation.calls.at(-1)!.path).toBe(`/v1/subjects/${storyArcCreatedId}`);
    const href = `/en/subjects/${storyArcCreatedId}/a-real-arc`;
    expect(canvas.getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(href);
    expect(canvas.getByRole('link', { name: m.story_arc_continue() }).getAttribute('href')).toBe(
      `${href}/story-arc?work=${encodeURIComponent(arc.work.id)}`,
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// Authored production-form regressions; native/browser/SSR and visual acceptance remain separate.
test('Creation corrections lead with current human fields, disclose exact failures, and retain recovery authority', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/new' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const pickerCallbacks = new Map<string, (items: EntityPickerSubject[]) => void>();
  const partChoice: EntityPickerSubject = {
    id: '00000000-0000-4000-8000-000000000391',
    title: 'Season',
    types: ['schema:TVSeason'],
    typeLabel: 'TV season',
    cover: null,
  };
  const creditChoice: EntityPickerSubject = {
    id: '00000000-0000-4000-8000-000000000392',
    title: 'Performer',
    types: ['schema:Person'],
    typeLabel: 'Person',
    cover: null,
  };
  const retiredChoice: EntityPickerSubject = { ...creditChoice, id: '00000000-0000-4000-8000-000000000394' };
  const lockedChoice: EntityPickerSubject = { ...creditChoice, id: '00000000-0000-4000-8000-000000000393' };
  mock.module('@rezics/ui/entity-picker', () => ({
    EntityPicker: (props: {
      label: string;
      disabled?: boolean;
      value?: readonly EntityPickerSubject[];
      onValueChange?: (items: EntityPickerSubject[]) => void;
    }) => {
      pickerCallbacks.set(props.label, props.onValueChange ?? (() => {}));
      return createElement(
        'button',
        {
          type: 'button',
          disabled: props.disabled,
          'data-selected': props.value?.[0]?.id ?? '',
          onClick: () => props.onValueChange?.([partChoice]),
        },
        props.label,
      );
    },
  }));
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { ScreenProfile } = await import('../src/features/catalogue/screen-profile-view');
  const { ScreenInitialFields } = await import('../src/features/catalogue/screen-profile-fields');
  const { screenFactId, screenInitialFacts, screenName } = await import('../src/features/catalogue/screen-profile');
  const { screenProfileFixture } = await import('../src/kernel/fake/catalogue-screen-profile');
  const { catalogueCreateFixture } = await import('../src/kernel/fake/catalogue-create');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  let generation = 0;
  const mount = async (element: Parameters<typeof root.render>[0]) => {
    await act(async () => root.render(createElement(QueryClientProvider, { client, key: ++generation }, element)));
    await waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (!host.querySelector('#create-label-0')) throw new Error('Waiting for the production creation form');
    });
  };
  const fill = async () => {
    await act(async () => {
      await user.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'A new film');
      const select = canvas.queryByRole('combobox', { name: m.catalogue_create_type() });
      if (select) await user.selectOptions(select, 'schema:Movie');
    });
  };
  const submit = async () => {
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    });
  };
  const codes = (region: Element) => Array.from(region.querySelectorAll('code'), (node) => node.textContent);
  try {
    const fixture = catalogueCreateFixture();
    const definitions = await fixture.transport.definitions();
    if (!definitions.ok) throw new Error('Expected the admitted creation definitions');
    const typeLabel = definitions.types.find((type) => type.id === 'schema:Movie')!.label;
    await mount(
      createElement(CreateSubjectForm, {
        locale: 'en',
        session: 'signed-in',
        transport: fixture.transport,
        onNavigate() {},
        profile: {
          scope: 'readonly-correction',
          title: 'Create film',
          type: 'schema:Movie',
          readOnlyType: true,
          fields: () => null,
          prepare: (item) => ({ item, errors: [] }),
        },
      }),
    );
    const type = host.querySelector('#create-type')!;
    expect(type.textContent).toContain(typeLabel);
    expect(type.textContent).not.toContain('schema:Movie');
    expect(type.getAttribute('aria-labelledby')).toBe('create-type-label');
    const typeDetails = host.querySelector('code')!.closest('details')!;
    expect(typeDetails.open).toBe(false);
    expect(typeDetails.querySelector('summary')!.textContent).toBe(m.catalogue_creation_technical_details());
    expect(codes(typeDetails)).toEqual(['schema:Movie']);
    expect(typeDetails.querySelector('dt')!.textContent).toBe(m.catalogue_creation_type_id());
    await submit();
    const alert = canvas.getByRole('alert');
    const link = within(alert).getByRole('link', { name: m.catalogue_create_label() });
    expect(link.getAttribute('href')).toBe('#create-label-0');
    const name = canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    expect(name.getAttribute('aria-describedby')).toContain('create-label-0-error');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    await act(async () => {
      await user.click(link);
    });
    expect(window.document.activeElement).toBe(name);
    await waitFor(() => expect(window.location.hash).toBe('#create-label-0'));
    const failureDetails = alert.querySelector('details')!;
    expect(failureDetails.open).toBe(false);
    expect(codes(failureDetails)).toEqual(['/labels/en', 'invalid_format']);
    expect(Array.from(failureDetails.querySelectorAll('dt'), (node) => node.textContent)).toEqual([
      m.catalogue_creation_pointer(),
      m.catalogue_creation_error_code(),
    ]);
    await act(async () => {
      await user.click(failureDetails.querySelector('summary')!);
    });
    expect(failureDetails.open).toBe(true);
    expect(failureDetails.querySelector('code')!.classList.contains('select-all')).toBe(true);
    expect(fixture.calls).toEqual([]);

    await mount(
      createElement(CreateSubjectForm, {
        locale: 'en',
        session: 'signed-in',
        onNavigate() {},
        transport: {
          ...fixture.transport,
          definitions: async () => ({
            ok: true as const,
            types: [{ id: 'schema:Movie', label: 'schema:Movie', description: '' }],
          }),
        },
        profile: {
          scope: 'type-name-unavailable',
          title: 'Create film',
          type: 'schema:Movie',
          readOnlyType: true,
          fields: () => null,
          prepare: (item) => ({ item, errors: [] }),
        },
      }),
    );
    expect(host.querySelector('#create-type')!.textContent).toContain(m.catalogue_creation_type_unlabelled());
    expect(host.querySelector('#create-type')!.textContent).not.toContain('schema:Movie');
    expect(codes(host)).toEqual(['schema:Movie']);

    // The real Screen producer has Profile.control, no errorLabel, and heading text from its admitted definition.
    const screen = screenProfileFixture();
    const read = await screen.transport.load();
    if (!read.ok) throw new Error('Expected the screen profile definitions');
    const longLabel = '上映時間・収録時間と特別版に含まれる映像の長さ'.repeat(5);
    read.release.properties['schema:duration']!.labels = { ja: longLabel };
    let current = read;
    await mount(
      createElement(ScreenProfile, {
        locale: 'en',
        session: 'signed-in',
        search: async () => [],
        onNavigate() {},
        transport: { ...screen.transport, load: async () => current },
      }),
    );
    await fill();
    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'schema:duration');
      await user.click(canvas.getByRole('button', { name: m.correction_add() }));
    });
    await submit();
    const screenAlert = canvas.getByRole('alert');
    const correction = within(screenAlert).getByRole('link', { name: longLabel });
    expect(correction.getAttribute('href')).toBe(`#${encodeURIComponent(screenFactId('schema:duration'))}`);
    expect(correction.getAttribute('lang')).toBe('ja');
    expect(correction.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    expect(correction.textContent).not.toContain('/statements/');
    await act(async () => {
      await user.click(correction);
    });
    const field = host.querySelector(`#${screenFactId('schema:duration').replaceAll('%', '\\%')}`)!;
    expect(field.contains(window.document.activeElement)).toBe(true);
    await waitFor(() =>
      expect(decodeURIComponent(window.location.hash.slice(1))).toBe(screenFactId('schema:duration')),
    );
    expect(screen.creation.calls).toEqual([]);
    expect(codes(screenAlert).some((value) => value?.startsWith('/statements/schema:duration/'))).toBe(true);
    expect(Array.from(screenAlert.querySelectorAll('details')).every((details) => !details.open)).toBe(true);
    const updatedLabel = 'Current running time';
    current = { ...read, release: structuredClone(read.release) };
    current.release.properties['schema:duration']!.labels = { en: updatedLabel };
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.correction_retry() }));
    });
    await waitFor(() => within(screenAlert).getByRole('link', { name: updatedLabel }));
    expect(within(screenAlert).queryByRole('link', { name: longLabel })).toBeNull();
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() }).value).toBe('A new film');
    // This producer falls back to a property ID when its label is absent; that ID cannot lead the correction.
    current = { ...current, release: structuredClone(current.release) };
    current.release.properties['schema:duration']!.labels = {};
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.correction_retry() }));
    });
    await waitFor(() => within(screenAlert).getByRole('link', { name: m.catalogue_creation_field_unknown() }));
    expect(within(screenAlert).queryByRole('link', { name: 'schema:duration' })).toBeNull();

    // Unknown pointers and unavailable mappings never pretend to identify the Name field.
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      const o = { locale };
      const unknown = [
        { pointer: '/future/value~1with~0escapes', code: 'unsupported' as const },
        { pointer: '/labels/zz', code: 'required' as const },
        { pointer: '/statements/future:field/0/value', code: 'out_of_range' as const },
      ];
      await mount(
        createElement(CreateSubjectForm, {
          locale,
          session: 'signed-in',
          onNavigate() {},
          transport: {
            ...fixture.transport,
            submit: async () => ({ ok: false as const, reason: 'invalid' as const, errors: unknown }),
          },
          profile: {
            scope: `unknown-${locale}`,
            title: 'Create',
            control: (pointer) => (pointer.startsWith('/statements/') ? 'missing-control' : undefined),
            fields: () => null,
            prepare: (item) => ({ item, errors: [] }),
          },
        }),
      );
      // The UI locale does not silently change the language in the user's retained terms.
      const formName = canvas.getByRole('textbox', { name: m.catalogue_create_label({}, o) });
      await act(async () => {
        await user.type(formName, '映画 — A film');
        await user.selectOptions(
          canvas.getByRole('combobox', { name: m.catalogue_create_type({}, o) }),
          'schema:Movie',
        );
        await user.click(canvas.getByRole('button', { name: m.catalogue_create_submit({}, o) }));
      });
      const unknownAlert = canvas.getByRole('alert');
      expect(unknownAlert.textContent).toContain(m.catalogue_create_invalid({}, o));
      expect(within(unknownAlert).queryAllByRole('link')).toHaveLength(0);
      expect(within(unknownAlert).getAllByText(m.catalogue_creation_field_unknown({}, o))).toHaveLength(3);
      expect(codes(unknownAlert)).toEqual(unknown.flatMap((error) => [error.pointer, error.code]));
      expect(Array.from(unknownAlert.querySelectorAll('summary'), (node) => node.textContent)).toEqual(
        unknown.map(() => m.catalogue_creation_technical_details({}, o)),
      );
      expect(formName.getAttribute('aria-invalid')).toBe('false');
      expect(formName.value).toBe('映画 — A film');
    }

    const partLabel = screenName(read.release, 'schema:isPartOf', 'en').text;
    const creditLabel = screenName(read.release, 'wdt:P725', 'en').text;
    const initialRows: ScreenRow[] = [
      {
        key: 'part-row',
        statement: {
          property: { id: 'schema:isPartOf' },
          value: { type: 'value', content: '00000000-0000-4000-8000-000000000301' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      },
      {
        key: 'old-credit-row',
        statement: {
          property: { id: 'wdt:P725' },
          value: { type: 'value', content: '' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      },
    ];
    let currentRows = initialRows;
    function ScreenFields({ disabled }: { disabled: boolean }) {
      const [rows, setRows] = useState(initialRows);
      currentRows = rows;
      return createElement(ScreenInitialFields, {
        type: 'schema:Episode',
        rows,
        change: (next) => setRows(next),
        release: read.release,
        locale: 'en',
        search: async () => [],
        disabled,
      });
    }
    const screenCommands: CreateSubjectCommand[] = [];
    let finishScreen!: (result: CreateResult) => void;
    const screenTransport: CreateTransport = {
      definitions: async () => ({
        ok: true,
        types: [{ id: 'schema:Episode', label: 'Episode', description: '' }],
      }),
      submit: async (command) => {
        screenCommands.push(command);
        return new Promise((resolve) => {
          finishScreen = resolve;
        });
      },
      read: async () => ({ state: 'unavailable' }),
    };
    await mount(
      createElement(CreateSubjectForm, {
        locale: 'en',
        session: 'signed-in',
        transport: screenTransport,
        onNavigate() {},
        profile: {
          scope: 'screen-initial-fields-lifetime',
          title: 'Create episode',
          type: 'schema:Episode',
          readOnlyType: true,
          fields: (_type, disabled) => createElement(ScreenFields, { disabled }),
          prepare: (item) => screenInitialFacts(read.release, item, currentRows.map((row) => row.statement)),
        },
      }),
    );
    const oldPart = pickerCallbacks.get(partLabel)!;
    const oldCredit = pickerCallbacks.get(creditLabel)!;
    const creditSection = Array.from(host.querySelectorAll('section')).find(
      (section) => section.querySelector('h3')?.textContent === creditLabel,
    )!;
    await act(async () => {
      await user.click(within(creditSection).getByRole('button', { name: m.relation_remove() }));
      oldPart([partChoice]);
    });
    expect(currentRows.map((row) => row.statement.property.id)).toEqual(['schema:isPartOf']);
    expect(currentRows[0]!.statement.value).toEqual({ type: 'value', content: partChoice.id });

    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_add_fact() }), 'wdt:P725');
      await user.click(canvas.getByRole('button', { name: m.correction_add() }));
      oldCredit([retiredChoice]);
    });
    const newCredit = currentRows.find((row) => row.statement.property.id === 'wdt:P725')!;
    expect(newCredit.key).not.toBe('old-credit-row');
    expect(newCredit.statement.value).toEqual({ type: 'value', content: '' });
    expect(canvas.getByRole('button', { name: creditLabel }).getAttribute('data-selected')).toBe('');
    const currentCredit = pickerCallbacks.get(creditLabel)!;
    await act(async () => currentCredit([creditChoice]));
    expect(currentRows.find((row) => row.key === newCredit.key)!.statement.value).toEqual({
      type: 'value',
      content: creditChoice.id,
    });

    await act(async () => {
      await user.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'A new episode');
      await user.click(canvas.getByRole('button', { name: m.catalogue_create_submit() }));
    });
    const sealed = structuredClone(screenCommands[0]!);
    const sealedStatements = (screenCommands[0]!.item as InitialSubject & { statements: Record<string, StatementInput[]> })
      .statements;
    expect(sealedStatements['schema:isPartOf']![0]!.value).toEqual({ type: 'value', content: partChoice.id });
    expect(sealedStatements['wdt:P725']![0]!.value).toEqual({ type: 'value', content: creditChoice.id });
    expect(canvas.getByRole('button', { name: creditLabel }).hasAttribute('disabled')).toBe(true);
    await act(async () => currentCredit([lockedChoice]));
    expect(screenCommands[0]).toEqual(sealed);
    expect(currentRows.find((row) => row.key === newCredit.key)!.statement.value).toEqual({
      type: 'value',
      content: creditChoice.id,
    });
    expect(canvas.getByRole('button', { name: creditLabel }).getAttribute('data-selected')).toBe(creditChoice.id);

    await act(async () => finishScreen({ ok: false, reason: 'invalid', errors: [], refreshDefinitions: true }));
    await waitFor(() => expect(canvas.getByRole('button', { name: creditLabel }).hasAttribute('disabled')).toBe(false));
    const recoveredCredit = pickerCallbacks.get(creditLabel)!;
    await act(async () => recoveredCredit([lockedChoice]));
    expect(currentRows.find((row) => row.key === newCredit.key)!.statement.value).toEqual({
      type: 'value',
      content: lockedChoice.id,
    });
    expect(screenCommands[0]).toEqual(sealed);

    const uncertain = catalogueCreateFixture('uncertain');
    await mount(
      createElement(CreateSubjectForm, {
        locale: 'en',
        session: 'signed-in',
        transport: uncertain.transport,
        onNavigate() {},
      }),
    );
    await fill();
    await submit();
    expect(canvas.getByRole('alert').textContent).toContain(m.catalogue_create_uncertain());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() }).disabled).toBe(true);
    const original = structuredClone(uncertain.calls[0]);
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    });
    expect(uncertain.calls[1]).toEqual(original);
    expect(uncertain.receipts.size).toBe(1);
    expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toBeDefined();

    const conflict = catalogueCreateFixture('conflict');
    await mount(
      createElement(CreateSubjectForm, {
        locale: 'en',
        session: 'signed-in',
        transport: conflict.transport,
        onNavigate() {},
      }),
    );
    await fill();
    await submit();
    expect(canvas.getByRole('alert').textContent).toContain(m.catalogue_create_conflict());
    expect(canvas.getByRole('button', { name: m.catalogue_create_submit() }).disabled).toBe(true);
    const failedKey = conflict.calls[0]!.key;
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.catalogue_create_review_new() }));
    });
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() }).value).toBe('A new film');
    conflict.setScenario('ready');
    await submit();
    expect(conflict.calls[1]!.key).not.toBe(failedKey);
    expect(conflict.calls[1]!.body).toEqual(conflict.calls[0]!.body);

    const profileUncertain = catalogueCreateFixture('uncertain');
    await mount(
      createElement(CreateSubjectForm, {
        locale: 'en',
        session: 'signed-in',
        transport: profileUncertain.transport,
        onNavigate() {},
        profile: {
          scope: 'retained-profile-command',
          title: 'Create film',
          type: 'schema:Movie',
          fields: () => null,
          prepare: (item) => ({ item, errors: [] }),
        },
      }),
    );
    await fill();
    await submit();
    profileUncertain.setScenario('conflict');
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    });
    expect(profileUncertain.calls[1]).toEqual(profileUncertain.calls[0]);
    expect(canvas.queryByRole('button', { name: m.catalogue_create_review_new() })).toBeNull();
    expect(canvas.getByRole('button', { name: m.catalogue_create_retry() }).disabled).toBe(true);
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() }).value).toBe('A new film');

    for (const scenario of ['denied', 'signed-out', 'invalid', 'reader-unavailable', 'concealed'] as const) {
      const recovery = catalogueCreateFixture(scenario);
      await mount(
        createElement(CreateSubjectForm, {
          locale: 'en',
          session: 'signed-in',
          transport: recovery.transport,
          onNavigate() {},
        }),
      );
      await fill();
      await submit();
      if (scenario === 'invalid') {
        expect(recovery.refreshes).toBe(1);
        expect(canvas.getByRole('alert').textContent).toContain(m.catalogue_create_refresh());
        expect(canvas.getByRole('combobox', { name: m.catalogue_create_type() }).value).toBe('schema:Movie');
        const name = canvas.getByRole('textbox', { name: m.catalogue_create_label() });
        expect(name.value).toBe('A new film');
        const failedKey = recovery.calls[0]!.key;
        await act(async () => {
          await user.type(name, ' corrected');
        });
        expect(name.getAttribute('aria-invalid')).toBe('false');
        recovery.setScenario('ready');
        await submit();
        expect(recovery.calls[1]!.key).not.toBe(failedKey);
        expect(recovery.calls[1]!.body.labels.en).toBe('A new film corrected');
      } else if (scenario === 'denied' || scenario === 'signed-out') {
        expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() }).value).toBe('A new film');
        expect(canvas.getByRole('alert').textContent).toContain(
          scenario === 'denied' ? m.catalogue_create_denied() : m.catalogue_create_signed_out(),
        );
        if (scenario === 'signed-out')
          expect(canvas.getByRole('link', { name: m.account_sign_in() }).getAttribute('href')).toContain('return_to=');
      } else {
        expect(canvas.queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
        expect(canvas.getByRole('status').textContent).toContain(m.catalogue_create_created());
        recovery.setScenario('ready');
        await act(async () => {
          await user.click(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
        });
        expect(canvas.getByRole('link', { name: m.catalogue_create_open() })).toBeDefined();
        expect(recovery.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
