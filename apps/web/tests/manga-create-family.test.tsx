import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { MangaCommand, MangaTransport } from '../src/features/catalogue/manga-profile';

// Authored UNRUN. Actual mounted creation, generated-client fixture and real native controls.
// This is not browser geometry, native authorization, private SSR or backend growth proof.
test('complete Manga creation keeps series and volume drafts, independent controls, deliberate commands and retired work', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({
    url: 'https://site.test/en/catalogue/manga',
    width: 390,
    height: 844,
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLButtonElement: window.HTMLButtonElement,
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
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { mangaFixture, mangaSeriesId, mangaVolumeId, mangaVolumeCitation } =
    await import('../src/kernel/fake/catalogue-manga-profile');
  const { checkDocument, hasDocumentContent } = await import('@rezics/document');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  const outside = window.document.createElement('button');
  outside.textContent = 'Current reader focus';
  window.document.body.append(host, outside);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const show = (node: ReactNode) =>
    act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await settle();
    expect(predicate()).toBe(true);
  };
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const select = (scope: HTMLElement, name: string, value: string) =>
    act(async () => user.selectOptions(within(scope).getByRole('combobox', { name }), value));
  const input = (scope: HTMLElement, name: string) => within(scope).getByRole('textbox', { name }) as HTMLInputElement;
  const replace = (control: HTMLElement, text: string) =>
    act(async () => {
      await user.clear(control);
      if (text) await user.type(control, text);
    });
  const posts = (fixture: ReturnType<typeof mangaFixture>) => fixture.calls.filter((call) => call.method === 'POST');
  const title = (fixture: ReturnType<typeof mangaFixture>, property: string) =>
    fixture.release.properties[property]!.labels.en!;
  const row = (scope: HTMLElement, name: string) => within(scope).getByRole('region', { name });
  const add = async (scope: HTMLElement, group: string, property: string, name: string) => {
    const picker = within(scope).getByRole('combobox', { name: group });
    await select(scope, group, property);
    await click(picker.closest('section')!, m.correction_add());
    return within(scope).getAllByRole('region', { name }).at(-1)!;
  };
  const selectAssociation = async (control: HTMLElement, scope: HTMLElement) => {
    const label = [...scope.querySelectorAll<HTMLLabelElement>('label')].find((label) => label.htmlFor === control.id)!;
    expect(control.id).not.toBe('');
    expect(label).toBeDefined();
    expect(label.textContent).not.toBe('');
    await act(async () => user.click(label));
    expect(window.document.activeElement).toBe(control);
  };
  const fresh = async (
    fixture: ReturnType<typeof mangaFixture>,
    key: string,
    transport = fixture.transport,
    session = 'signed-in',
    search = async () => [] as { id: string; title: string; types: string[] }[],
  ) => {
    await show(<MangaProfileEditor key={key} locale="en" session={session} transport={transport} search={search} />);
    await until(
      () => !!host.querySelector('select') && !(host.querySelector('fieldset') as HTMLFieldSetElement).disabled,
    );
    return host;
  };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const callback = (button: HTMLElement) =>
    Reflect.get(
      button,
      Object.keys(button).find((key) => key.startsWith('__reactProps$'))!,
    ).onClick as () => void;
  const longName = `The Paper Observatory — ${'Full multilingual name 紙の天文台 '.repeat(8)}`;
  const longAlias = `Alternative ${'unbrokenalias'.repeat(20)}`;
  try {
    const series = mangaFixture('uncertain');
    const volume = mangaFixture('reader-unavailable');
    let rejectVolume = true;
    const volumeTransport: MangaTransport = {
      ...volume.transport,
      create: async (command) => {
        if (!rejectVolume) return volume.transport.create(command);
        rejectVolume = false;
        return {
          ok: false,
          reason: 'invalid',
          errors: [
            {
              pointer: '/statements/schema:inLanguage/1/references/0/parts/0/value/content',
              code: 'invalid_format',
            },
            {
              pointer: '/statements/schema:inLanguage/1/value/content',
              code: 'invalid_format',
            },
            {
              pointer: '/statements/wdt:P179/0/qualifiers/0/value/content',
              code: 'invalid_format',
            },
            {
              pointer: '/statements/schema:inLanguage/99/value/content',
              code: 'invalid_format',
            },
          ],
        };
      },
    };
    const commands: MangaCommand[] = [];
    const seriesTransport = {
      ...series.transport,
      create: (command: MangaCommand) => {
        commands.push(command);
        return series.transport.create(command);
      },
    };
    const search = async () => [
      {
        id: mangaSeriesId,
        title: 'The Paper Observatory',
        types: ['schema:ComicSeries'],
      },
      {
        id: '00000000-0000-4000-8000-00000000d103',
        title: 'Wrong membership kind',
        types: ['schema:Person'],
      },
    ];
    const pair = () => (
      <>
        <div data-mount="series">
          <MangaProfileEditor locale="en" session="signed-in" transport={seriesTransport} search={search} />
        </div>
        <div data-mount="volume">
          <MangaProfileEditor locale="en" session="signed-in" transport={volumeTransport} search={search} />
        </div>
      </>
    );
    await show(pair());
    await until(
      () =>
        host.querySelectorAll('form').length === 2 &&
        [...host.querySelectorAll('fieldset')].every((field) => !field.disabled),
    );
    const a = host.querySelector<HTMLElement>('[data-mount="series"]')!;
    const b = host.querySelector<HTMLElement>('[data-mount="volume"]')!;
    expect(series.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(volume.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    const addControls = [a, b].flatMap((scope) =>
      [...scope.querySelectorAll<HTMLSelectElement>('select')].filter((control) => control.id !== 'manga-type'),
    );
    expect(new Set(addControls.map((control) => control.id)).size).toBe(addControls.length);
    for (const scope of [a, b]) {
      for (const control of scope.querySelectorAll<HTMLSelectElement>('select')) {
        if (control.id !== 'manga-type') await selectAssociation(control, scope);
      }
      expect(scope.querySelector('form li section, [data-slot="list-row-link"], a button, a input')).toBeNull();
      for (const heading of scope.querySelectorAll('h2'))
        expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      expect(scope.textContent).toContain(m.manga_grain_help());
    }
    const stableAddIds = addControls.map((control) => control.id);
    await show(pair());
    const currentAddControls = [a, b].flatMap((scope) =>
      [...scope.querySelectorAll<HTMLSelectElement>('select')].filter((control) => control.id !== 'manga-type'),
    );
    expect(currentAddControls.map((control) => control.id)).toEqual(stableAddIds);
    await replace(input(a, m.catalogue_create_label()), longName);
    await replace(input(a, m.catalogue_create_description()), 'An original quiet astronomical mystery.');
    await replace(input(a, m.catalogue_create_aliases()), `${longAlias}\nNight atlas`);
    await click(a, m.catalogue_create_add_language());
    await click(a, m.catalogue_create_add_language());
    const terms = within(a).getByRole('group', {
      name: m.catalogue_create_terms(),
    });
    const languages = within(terms).getAllByRole('textbox', {
      name: m.catalogue_create_language(),
    });
    await replace(languages[2]!, 'ja');
    const labels = within(terms).getAllByRole('textbox', {
      name: m.catalogue_create_label(),
    });
    await replace(labels[2]!, '紙の天文台');
    const removes = within(terms).getAllByRole('button', {
      name: m.catalogue_create_remove_language(),
    });
    const removedId = removes[0]!.getAttribute('aria-controls')!;
    await act(async () => {
      removes[0]!.focus();
      await user.keyboard('{Enter}');
    });
    expect(window.document.getElementById(removedId)).toBeNull();
    expect(window.document.activeElement).toBe(languages[2]);
    await click(a, m.catalogue_create_remove_language());
    expect(window.document.activeElement).toBe(
      within(a).getByRole('button', {
        name: m.catalogue_create_add_language(),
      }),
    );
    expect(input(a, m.catalogue_create_label()).value).toBe(longName);
    expect(input(a, m.catalogue_create_aliases()).value).toBe(`${longAlias}\nNight atlas`);
    expect(input(b, m.catalogue_create_label()).value).toBe('');
    // Repeated qualifier selectors belong to their own rows and their own mounted editor.
    const authorA = await add(a, m.manga_creators(), 'schema:author', title(series, 'schema:author'));
    const authorB = await add(b, m.manga_creators(), 'schema:author', title(volume, 'schema:author'));
    const qualifierA = within(authorA).getByRole('combobox', {
      name: m.correction_add_qualifier(),
    }) as HTMLSelectElement;
    const qualifierB = within(authorB).getByRole('combobox', {
      name: m.correction_add_qualifier(),
    }) as HTMLSelectElement;
    expect(qualifierA.id).not.toBe(qualifierB.id);
    await selectAssociation(qualifierA, a);
    await selectAssociation(qualifierB, b);
    await select(authorA, m.correction_add_qualifier(), 'schema:position');
    expect(qualifierB.value).toBe('');
    expect(
      (
        within(authorB).getByRole('button', {
          name: m.relation_add_qualifier(),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await click(authorA, m.relation_add_qualifier());
    expect(
      within(authorA).getByRole('heading', {
        name: title(series, 'schema:position'),
        level: 4,
      }),
    ).not.toBeNull();
    expect(
      within(authorB).queryByRole('heading', {
        name: title(volume, 'schema:position'),
        level: 4,
      }),
    ).toBeNull();
    expect(qualifierA.value).toBe('');
    await click(authorA, m.recipe_remove_field());
    await click(authorA, m.recipe_remove_field());
    await click(authorB, m.recipe_remove_field());
    const language = await add(a, m.manga_publication(), 'schema:inLanguage', title(series, 'schema:inLanguage'));
    await replace(input(language, m.correction_value()), 'ja');
    const publicationPicker = within(a).getByRole('combobox', {
      name: m.manga_publication(),
    });
    await select(a, m.manga_publication(), 'schema:inLanguage');
    await act(async () => {
      publicationPicker.focus();
      await user.tab();
    });
    expect(window.document.activeElement).toBe(
      within(publicationPicker.closest('section')!).getByRole('button', {
        name: m.correction_add(),
      }),
    );
    // Type switches retain only the native separate field drafts; terms remain shared.
    await select(a, m.manga_grain(), 'schema:PublicationVolume');
    expect(
      within(a).queryByRole('region', {
        name: title(series, 'schema:inLanguage'),
      }),
    ).toBeNull();
    await select(a, m.manga_grain(), 'schema:ComicSeries');
    expect(input(row(a, title(series, 'schema:inLanguage')), m.correction_value()).value).toBe('ja');
    const authored = await add(a, m.authored_title(), 'schema:abstract', title(series, 'schema:abstract'));
    expect(authored.textContent).toContain(m.authored_citation_hint());
    expect(authored.textContent).toContain(m.authored_original());
    await replace(input(authored, m.authored_language()), 'en');
    await replace(input(authored, m.authored_licence()), 'CC-BY-4.0');
    const editor = authored.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!;
    await act(async () => {
      await user.click(editor);
      await user.type(editor, 'An original account of the observatory.');
      await user.tab();
    });
    await click(a, m.manga_title());
    expect(posts(series)).toHaveLength(0);
    expect(a.querySelector(`a[href="#original-${authored.id.replace('manga-row-', '')}"]`)).not.toBeNull();
    await act(async () => user.click(within(authored).getByRole('checkbox', { name: m.authored_original() })));
    await replace(input(authored, m.relation_citation()), 'https://example.org/original-summary');
    await click(authored, m.recipe_remove_field());
    const sealedRemoval = callback(within(authored).getByRole('button', { name: m.recipe_remove_field() }));
    await click(a, m.manga_title());
    await until(() => a.textContent!.includes(m.correction_unavailable()));
    expect(posts(series)).toHaveLength(1);
    const sealed = structuredClone(commands[0]!);
    expect(within(authored).getByRole('button', { name: m.recipe_remove_field() }).matches(':disabled')).toBe(true);
    await click(authored, m.recipe_remove_field());
    const pendingFocus = window.document.activeElement;
    await act(async () => sealedRemoval());
    expect(window.document.activeElement).toBe(pendingFocus);
    expect(authored.isConnected).toBe(true);
    expect((input(a, m.catalogue_create_label()) as HTMLInputElement).matches(':disabled')).toBe(true);
    expect(within(a).getByRole('button', { name: m.catalogue_create_add_language() }).matches(':disabled')).toBe(true);
    expect(within(b).getByRole('button', { name: m.catalogue_create_add_language() }).matches(':disabled')).toBe(false);
    const boundsBeforeReplay = series.calls.length;
    await settle();
    expect(series.calls).toHaveLength(boundsBeforeReplay);
    await click(a, m.correction_retry());
    await until(() => a.textContent!.includes(m.manga_created()));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
    expect(commands[1]).toEqual(sealed);
    expect(posts(series)[0]!.key).toBe(posts(series)[1]!.key);
    expect(posts(series)[0]!.body).toEqual(posts(series)[1]!.body);
    expect(series.calls).toHaveLength(9); // Initial definitions, two deliberate attempts, one current reader.
    expect(series.calls.filter((call) => call.path === '/v1/definitions/active')).toHaveLength(3);
    expect(series.calls.filter((call) => call.path === `/v1/subjects/${mangaSeriesId}`)).toHaveLength(1);
    expect(sealed.independent).toBe(false);
    expect(sealed.item.labels).toEqual({ en: longName });
    expect(sealed.item.aliases).toEqual({ en: [longAlias, 'Night atlas'] });
    expect(sealed.item.statements['schema:inLanguage']![0]!.value).toEqual({
      type: 'value',
      content: 'ja',
    });
    const content = sealed.item.statements['schema:abstract']![0]!.value;
    if (content.type !== 'value') throw new Error('Expected authored value');
    const body = content.content as {
      document: Parameters<typeof checkDocument>[0];
      language: string;
      licence: string;
    };
    expect(body.language).toBe('en');
    expect(body.licence).toBe('CC-BY-4.0');
    expect(checkDocument(body.document)).toBe(true);
    if (!checkDocument(body.document)) throw new Error('Expected normalized document');
    expect(hasDocumentContent(body.document)).toBe(true);
    expect(JSON.stringify(body.document)).toContain('An original account of the observatory.');
    expect(sealed.item.statements['schema:abstract']![0]!.references).toEqual([
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: {
              type: 'value',
              content: 'https://example.org/original-summary',
            },
          },
        ],
      },
    ]);
    expect(within(a).getByRole('link', { name: m.candidate_view_public() }).getAttribute('href')).toContain(
      mangaSeriesId,
    );
    // Volume membership only admits a current series, with exact qualifier, quantity and URL.
    await select(b, m.manga_grain(), 'schema:PublicationVolume');
    await replace(input(b, m.catalogue_create_label()), 'The Paper Observatory, volume 2');
    const work = await add(b, m.manga_membership(), 'wdt:P179', title(volume, 'wdt:P179'));
    const target = within(work).getByRole('combobox', {
      name: title(volume, 'wdt:P179'),
    });
    await act(async () => user.type(target, 'Paper'));
    await until(
      () =>
        within(window.document.body as unknown as HTMLElement).queryByRole('option', {
          name: /The Paper Observatory/,
        }) !== null,
    );
    expect(
      within(window.document.body as unknown as HTMLElement).queryByRole('option', {
        name: /Wrong membership kind/,
      }),
    ).toBeNull();
    await act(async () => {
      target.focus();
      await user.keyboard('{ArrowDown}{Enter}');
    });
    const qualifier = within(work).getByRole('combobox', {
      name: m.correction_add_qualifier(),
    });
    await selectAssociation(qualifier, work);
    await select(work, m.correction_add_qualifier(), 'schema:position');
    await click(work, m.relation_add_qualifier());
    await replace(input(work, m.correction_value()), '2');
    expect(
      within(work).getByRole('heading', {
        name: title(volume, 'schema:position'),
        level: 4,
      }),
    ).not.toBeNull();
    const pages = await add(b, m.manga_publication(), 'schema:numberOfPages', title(volume, 'schema:numberOfPages'));
    await replace(input(pages, m.correction_amount()), '+192');
    await select(pages, m.correction_unit(), '1');
    await replace(input(pages, m.relation_citation()), mangaVolumeCitation);
    const isbn = await add(b, m.manga_publication(), 'schema:isbn', title(volume, 'schema:isbn'));
    await replace(input(isbn, m.correction_value()), '9781234567897');
    const firstLanguage = await add(b, m.manga_publication(), 'schema:inLanguage', title(volume, 'schema:inLanguage'));
    const secondLanguage = await add(b, m.manga_publication(), 'schema:inLanguage', title(volume, 'schema:inLanguage'));
    await replace(input(firstLanguage, m.correction_value()), 'ja');
    await replace(input(secondLanguage, m.correction_value()), 'en');
    await replace(input(secondLanguage, m.relation_citation()), 'https://example.org/old-citation');
    await click(b, m.catalogue_create_add_language());
    const termLanguages = within(b).getAllByRole('textbox', {
      name: m.catalogue_create_language(),
    });
    await replace(termLanguages[1]!, 'en');
    await replace(
      within(b).getAllByRole('textbox', {
        name: m.catalogue_create_label(),
      })[1]!,
      '紙の天文台 第二巻',
    );
    expect(
      within(b)
        .getByRole('combobox', { name: m.manga_publication() })
        .querySelector('option[value="schema:numberOfPages"]'),
    ).toBeNull();
    await click(b, m.manga_title());
    expect(posts(volume)).toHaveLength(0);
    expect(b.querySelector('a[href="#manga-independent"]')).not.toBeNull();
    const acknowledgement = b.querySelector<HTMLAnchorElement>('a[href="#manga-independent"]')!;
    expect(acknowledgement.textContent).toBe(m.manga_independent());
    await act(async () => user.click(acknowledgement));
    expect(window.document.activeElement).toBe(within(b).getByRole('checkbox', { name: m.manga_independent() }));
    const duplicate = b.querySelector<HTMLAnchorElement>(`a[href="#${CSS.escape(termLanguages[1]!.id)}"]`)!;
    expect(duplicate.closest('li')!.textContent).toContain(m.catalogue_create_validation_language_unique());
    await act(async () => user.click(duplicate));
    expect(window.document.activeElement).toBe(termLanguages[1]);
    await replace(termLanguages[1]!, 'ja');
    await act(async () => user.click(within(b).getByRole('checkbox', { name: m.manga_independent() })));
    await click(b, m.manga_title());
    await until(() => b.textContent!.includes(m.correction_error_url()));
    const rejectionLinks = [...b.querySelectorAll<HTMLAnchorElement>('form li a')];
    for (const [link, control] of [
      [rejectionLinks[0]!, input(secondLanguage, m.relation_citation())],
      [rejectionLinks[1]!, input(secondLanguage, m.correction_value())],
      [rejectionLinks[2]!, input(work, m.correction_value())],
    ] as const) {
      await act(async () => user.click(link));
      expect(window.document.activeElement).toBe(control);
      expect(control.getAttribute('aria-invalid')).toBe('true');
      expect(window.document.getElementById(control.getAttribute('aria-describedby')!)!.textContent).toContain(
        link.textContent!,
      );
    }
    expect(rejectionLinks[3]!.getAttribute('href')).toBe('#manga-fields');
    await act(async () => user.click(rejectionLinks[3]!));
    expect(window.document.activeElement).toBe(b.querySelector('[id="manga-fields"]'));
    expect(rejectionLinks[0]!.textContent).toContain(m.relation_citation());
    expect(input(firstLanguage, m.relation_citation()).getAttribute('aria-invalid')).toBeNull();
    await replace(input(secondLanguage, m.relation_citation()), 'https://example.org/correct-citation');
    await click(b, m.manga_title());
    await until(() => b.textContent!.includes(m.manga_created()));
    expect(posts(volume)).toHaveLength(1);
    expect(volume.calls).toHaveLength(9); // Initial definitions, fresh admission, exact series check, create/read.
    expect(volume.calls.filter((call) => call.path === `/v1/subjects/${mangaSeriesId}`)).toHaveLength(1);
    expect(volume.calls.filter((call) => call.path === `/v1/subjects/${mangaVolumeId}`)).toHaveLength(1);
    expect(posts(volume)[0]!.body).toEqual({
      type: 'schema:PublicationVolume',
      labels: {
        en: 'The Paper Observatory, volume 2',
        ja: '紙の天文台 第二巻',
      },
      descriptions: {},
      aliases: {},
      statements: {
        'schema:inLanguage': [
          {
            property: { id: 'schema:inLanguage' },
            value: { type: 'value', content: 'ja' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
          {
            property: { id: 'schema:inLanguage' },
            value: { type: 'value', content: 'en' },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: {
                      type: 'value',
                      content: 'https://example.org/correct-citation',
                    },
                  },
                ],
              },
            ],
            rank: 'normal',
          },
        ],
        'wdt:P179': [
          {
            property: { id: 'wdt:P179' },
            value: { type: 'value', content: mangaSeriesId },
            qualifiers: [
              {
                property: { id: 'schema:position' },
                value: { type: 'value', content: '2' },
              },
            ],
            references: [],
            rank: 'normal',
          },
        ],
        'schema:numberOfPages': [
          {
            property: { id: 'schema:numberOfPages' },
            value: { type: 'value', content: { amount: '+192', unit: '1' } },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: mangaVolumeCitation },
                  },
                ],
              },
            ],
            rank: 'normal',
          },
        ],
        'schema:isbn': [
          {
            property: { id: 'schema:isbn' },
            value: { type: 'value', content: '9781234567897' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
        ],
      },
    });
    expect(within(b).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
    volume.setScenario('ready');
    await click(b, m.correction_retry());
    await until(() => within(b).queryByRole('link', { name: m.candidate_view_public() }) !== null);
    expect(volume.calls.at(-1)!.path).toBe(`/v1/subjects/${mangaVolumeId}`);
    expect(posts(volume)).toHaveLength(1);
    // A refreshed definition retains complete private rows until deliberate local confirmation.
    const stale = mangaFixture();
    const creator = {
      id: '00000000-0000-4000-8000-00000000d103',
      title: 'Private creator',
      types: ['schema:Person'],
    };
    await fresh(stale, 'stale-field', stale.transport, 'signed-in', async () => [creator]);
    await replace(input(host, m.catalogue_create_label()), 'Stale field draft');
    const staleRow = await add(host, m.manga_creators(), 'schema:author', title(stale, 'schema:author'));
    const picker = within(staleRow).getByRole('combobox', {
      name: title(stale, 'schema:author'),
    });
    await act(async () => user.type(picker, 'Private'));
    await until(() => within(host).queryByRole('option', { name: /Private creator/ }) !== null);
    await act(async () => user.click(within(host).getByRole('option', { name: /Private creator/ })));
    await select(staleRow, m.correction_add_qualifier(), 'schema:position');
    await click(staleRow, m.relation_add_qualifier());
    await replace(input(staleRow, m.correction_value()), '2');
    await replace(input(staleRow, m.relation_citation()), 'https://example.org/creator-source');
    const sibling = await add(host, m.manga_publication(), 'schema:inLanguage', title(stale, 'schema:inLanguage'));
    await replace(input(sibling, m.correction_value()), 'ja');
    const properties = [...stale.release.types['schema:ComicSeries']!.properties];
    const refresh = () => act(async () => client.refetchQueries({ queryKey: ['manga-profile'] }));
    const withdraw = async () => {
      stale.release.types['schema:ComicSeries']!.properties = properties.filter(
        (id) => !['schema:author', 'schema:inLanguage'].includes(id),
      );
      await refresh();
    };
    await withdraw();
    const panel = (id: string) => window.document.getElementById(id)! as unknown as HTMLElement;
    const before = structuredClone(stale.calls);
    expect(panel(staleRow.id).textContent).toContain(title(stale, 'schema:author'));
    expect(host.textContent).not.toContain('Private creator');
    await click(panel(staleRow.id), m.recipe_remove_field());
    expect(window.document.activeElement).toBe(
      within(panel(staleRow.id)).getByRole('button', {
        name: m.candidate_cancel(),
      }),
    );
    const canceledRemoval = callback(
      within(panel(staleRow.id)).getByRole('button', {
        name: m.recipe_remove_field(),
      }),
    );
    await click(panel(staleRow.id), m.candidate_cancel());
    await act(async () => canceledRemoval());
    expect(panel(staleRow.id)).toBeDefined();
    expect(window.document.activeElement).toBe(
      within(panel(staleRow.id)).getByRole('button', {
        name: m.recipe_remove_field(),
      }),
    );
    expect(stale.calls).toEqual(before);
    await click(panel(staleRow.id), m.recipe_remove_field());
    const retiredRemoval = callback(
      within(panel(staleRow.id)).getByRole('button', {
        name: m.recipe_remove_field(),
      }),
    );
    // Re-admission reveals exactly the retained target, qualifier, citation and sibling scalar.
    stale.release.types['schema:ComicSeries']!.properties = properties;
    await refresh();
    outside.focus();
    await act(async () => retiredRemoval());
    expect(window.document.activeElement).toBe(outside);
    expect(panel(staleRow.id).textContent).toContain('Private creator');
    expect(input(panel(staleRow.id), m.correction_value()).value).toBe('2');
    expect(input(panel(staleRow.id), m.relation_citation()).value).toBe('https://example.org/creator-source');
    expect(input(panel(sibling.id), m.correction_value()).value).toBe('ja');
    await withdraw();
    await click(host, m.manga_title());
    expect(posts(stale)).toHaveLength(0); // Withdrawn assertions remain inadmissible.
    const staleLink = host.querySelector<HTMLAnchorElement>(`a[href="#${staleRow.id}"]`)!;
    await act(async () => user.click(staleLink));
    expect(window.document.activeElement).toBe(panel(staleRow.id));
    await click(panel(staleRow.id), m.recipe_remove_field());
    const localCalls = structuredClone(stale.calls);
    await click(panel(staleRow.id), m.recipe_remove_field());
    expect(host.querySelector(`#${staleRow.id}`)).toBeNull();
    expect(window.document.activeElement).toBe(
      within(panel(sibling.id)).getByRole('button', {
        name: m.recipe_remove_field(),
      }),
    );
    expect(stale.calls).toEqual(localCalls);
    stale.release.types['schema:ComicSeries']!.properties = properties;
    await refresh();
    expect(input(panel(sibling.id), m.correction_value()).value).toBe('ja');
    expect(input(host, m.catalogue_create_label()).value).toBe('Stale field draft');
    await click(host, m.manga_title());
    await until(() => host.textContent!.includes(m.manga_created()));
    expect(posts(stale)).toHaveLength(1);
    expect((posts(stale)[0]!.body as { statements: unknown }).statements).toEqual({
      'schema:inLanguage': [
        {
          property: { id: 'schema:inLanguage' },
          value: { type: 'value', content: 'ja' },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      ],
    });
    // Refusals keep drafts and never retry themselves; conflict requires deliberate review.
    for (const scenario of ['denied', 'invalid', 'stale', 'conflict'] as const) {
      const fixture = mangaFixture(scenario);
      await fresh(fixture, scenario);
      await replace(input(host, m.catalogue_create_label()), 'Retained draft');
      await click(host, m.manga_title());
      await until(() => posts(fixture).length === 1 && host.querySelector('[role="alert"]') !== null);
      const conflict = scenario === 'stale' || scenario === 'conflict';
      if (conflict) {
        expect(
          (
            within(host).getByRole('button', {
              name: m.manga_title(),
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        await click(host, m.catalogue_create_review_new());
      } else expect(host.textContent).toContain(scenario === 'denied' ? m.correction_denied() : m.correction_invalid());
      expect(input(host, m.catalogue_create_label()).value).toBe('Retained draft');
      const before = structuredClone(fixture.calls);
      await settle();
      expect(fixture.calls).toEqual(before);
      fixture.setScenario('ready');
      await click(host, m.manga_title());
      await until(() => host.textContent!.includes(m.manga_created()));
      expect(posts(fixture)).toHaveLength(2);
      expect(posts(fixture)[1]!.key).not.toBe(posts(fixture)[0]!.key);
    }
    for (const scenario of ['reader-unavailable', 'reader-concealed'] as const) {
      const fixture = mangaFixture(scenario);
      await fresh(fixture, scenario);
      await replace(input(host, m.catalogue_create_label()), 'Readback recovery');
      await click(host, m.manga_title());
      await until(() => host.textContent!.includes(m.manga_created()));
      expect(within(host).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
      expect(host.textContent).toContain(
        scenario === 'reader-concealed' ? m.catalogue_create_concealed() : m.catalogue_create_reader_unavailable(),
      );
      const before = fixture.calls.length;
      await settle();
      expect(fixture.calls).toHaveLength(before);
      fixture.setScenario('ready');
      await click(host, m.correction_retry());
      await until(
        () =>
          within(host).queryByRole('link', {
            name: m.candidate_view_public(),
          }) !== null,
      );
      expect(fixture.calls).toHaveLength(before + 1);
      expect(fixture.calls.at(-1)!.path).toBe(`/v1/subjects/${mangaSeriesId}`);
      expect(posts(fixture)).toHaveLength(1);
    }
    // Supplied-data growth only: multivalued language rows admit 1/8/64. No backend claim.
    for (const count of [1, 8, 64]) {
      const fixture = mangaFixture();
      const supplied = await fixture.transport.load();
      if (!supplied.ok) throw new Error('Expected supplied release');
      let wholePopulationTraversals = 0;
      const related = new Proxy(fixture.reads.get(mangaSeriesId)!.related, {
        ownKeys(target) {
          wholePopulationTraversals++;
          return Reflect.ownKeys(target);
        },
      });
      const read = {
        ...supplied,
        public: { ...fixture.reads.get(mangaSeriesId)!, related },
      };
      await fresh(fixture, `growth-${count}`, {
        ...fixture.transport,
        load: async () => read,
      });
      const before = structuredClone(fixture.calls);
      for (let index = 0; index < count; index++)
        await add(host, m.manga_publication(), 'schema:inLanguage', title(fixture, 'schema:inLanguage'));
      expect(
        within(host).getAllByRole('region', {
          name: title(fixture, 'schema:inLanguage'),
        }),
      ).toHaveLength(count);
      const ids = [...host.querySelectorAll('section[id^="manga-row-"]')].map((element) => element.id);
      expect(new Set(ids).size).toBe(count);
      expect(fixture.calls).toEqual(before);
      expect(wholePopulationTraversals).toBe(0);
      expect(host.querySelectorAll('[data-slot="entity-picker"]')).toHaveLength(0);
    }
    for (const scenario of ['empty', 'unavailable', 'loading'] as const) {
      const fixture = mangaFixture(scenario);
      await show(
        <MangaProfileEditor
          key={scenario}
          locale="en"
          session="signed-in"
          transport={fixture.transport}
          search={async () => []}
        />,
      );
      const message =
        scenario === 'empty'
          ? m.catalogue_create_empty()
          : scenario === 'loading'
            ? m.candidate_loading()
            : m.correction_unavailable();
      await until(() => host.textContent!.includes(message));
      expect(
        (
          within(host).getByRole('button', {
            name: m.manga_title(),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(posts(fixture)).toHaveLength(0);
    }
    const signedOut = mangaFixture();
    await show(
      <MangaProfileEditor
        key="signed-out"
        locale="en"
        session="signed-out"
        transport={signedOut.transport}
        search={async () => []}
      />,
    );
    await until(() => host.textContent!.includes(m.catalogue_create_signed_out()));
    expect(
      (
        within(host).getByRole('button', {
          name: m.manga_title(),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(posts(signedOut)).toHaveLength(0);
    let retries = 0;
    const sessionView = (session: string) => (
      <MangaProfileEditor
        key="session-recovery"
        locale="en"
        session={session}
        retrySession={async () => {
          retries++;
        }}
        transport={signedOut.transport}
        search={async () => []}
      />
    );
    await show(sessionView('signed-in'));
    await until(() => !host.querySelector<HTMLFieldSetElement>('fieldset')!.disabled);
    await replace(input(host, m.catalogue_create_label()), 'Private session draft');
    await show(sessionView('unavailable'));
    expect(host.textContent).toContain(m.catalogue_create_unavailable());
    expect(host.textContent).not.toContain(m.candidate_loading());
    expect(within(host).getByRole('button', { name: m.manga_title() }).matches(':disabled')).toBe(true);
    await click(host, m.erasure_retry_session());
    expect(retries).toBe(1);
    await show(sessionView('signed-in'));
    expect(input(host, m.catalogue_create_label()).value).toBe('Private session draft');
    // Late command outcomes and queued submit cannot escape a retired reader. Fresh work succeeds.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = mangaFixture();
      const entered = deferred<void>();
      const gate = deferred<typeof delivery>();
      let hold = true;
      const transport: MangaTransport = {
        ...fixture.transport,
        create: async (command) => {
          const result = await fixture.transport.create(command);
          if (!hold) return result;
          hold = false;
          entered.resolve();
          const kind = await gate.promise;
          if (kind === 'throw') throw new Error('Retired creation delivery');
          return kind === 'failure' ? { ok: false, reason: 'unavailable' } : result;
        },
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          key={delivery}
          address="manga-create"
          observed={{
            state: 'signed-in',
            subject: reader,
            csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
          }}
        >
          <MangaProfileEditor locale="en" session="signed-in" transport={transport} search={async () => []} />
        </CandidateReaderBoundary>
      );
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
      await until(
        () => !!host.querySelector('select') && !(host.querySelector('fieldset') as HTMLFieldSetElement).disabled,
      );
      await replace(input(host, m.catalogue_create_label()), 'Old reader draft');
      const form = host.querySelector('form')!;
      const reactProps = Object.keys(form).find((key) => key.startsWith('__reactProps$'))!;
      const oldSubmit = (
        Reflect.get(form, reactProps) as {
          onSubmit: (event: { preventDefault: () => void }) => void;
        }
      ).onSubmit;
      await click(host, m.manga_title());
      await entered.promise;
      expect(posts(fixture)).toHaveLength(1);
      expect(form.getAttribute('aria-busy')).toBe('true');
      expect(input(host, m.catalogue_create_label()).matches(':disabled')).toBe(true);
      const pendingCalls = structuredClone(fixture.calls);
      await act(async () => oldSubmit({ preventDefault() {} }));
      expect(fixture.calls).toEqual(pendingCalls);
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await until(
        () => !!host.querySelector('select') && !(host.querySelector('fieldset') as HTMLFieldSetElement).disabled,
      );
      outside.focus();
      const before = structuredClone(fixture.calls);
      await act(async () => {
        oldSubmit({ preventDefault() {} });
        gate.resolve(delivery);
      });
      await settle();
      expect(fixture.calls).toEqual(before);
      expect(window.document.activeElement).toBe(outside);
      expect(host.textContent).not.toContain(m.manga_created());
      expect(within(host).queryByRole('button', { name: m.correction_retry() })).toBeNull();
      expect(input(host, m.catalogue_create_label()).value).toBe('');
      await replace(input(host, m.catalogue_create_label()), 'New reader draft');
      await click(host, m.manga_title());
      await until(() => host.textContent!.includes(m.manga_created()));
      expect(posts(fixture)).toHaveLength(2);
      expect(posts(fixture)[1]!.key).not.toBe(posts(fixture)[0]!.key);
    }
    // A retired definitions read cannot populate its old query or replace the current form.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = mangaFixture();
      const entered = deferred<void>();
      const gate = deferred<typeof delivery>();
      let hold = true;
      const transport: MangaTransport = {
        ...fixture.transport,
        load: async () => {
          const result = await fixture.transport.load();
          if (!hold) return result;
          hold = false;
          entered.resolve();
          const kind = await gate.promise;
          if (kind === 'throw') throw new Error('Retired definitions delivery');
          return kind === 'failure' ? { ok: false, reason: 'unavailable' } : result;
        },
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          key={`load-${delivery}`}
          address="manga-load"
          observed={{
            state: 'signed-in',
            subject: reader,
            csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
          }}
        >
          <MangaProfileEditor locale="en" session="signed-in" transport={transport} search={async () => []} />
        </CandidateReaderBoundary>
      );
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
      await entered.promise;
      const retired = client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey[0] === 'manga-profile' && query.state.fetchStatus === 'fetching')!;
      expect(retired).toBeDefined();
      const freshLabel = `Current supplied series label ${delivery}`;
      fixture.release.types['schema:ComicSeries']!.labels.en = freshLabel;
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await until(() => host.textContent!.includes(freshLabel));
      const before = structuredClone(fixture.calls);
      outside.focus();
      await act(async () => gate.resolve(delivery));
      await settle();
      expect(retired.state.data).toBeUndefined();
      expect(fixture.calls).toEqual(before);
      expect(window.document.activeElement).toBe(outside);
      expect(host.textContent).toContain(freshLabel);
      expect(host.textContent).not.toContain(m.correction_unavailable());
    }
    // Explicit created-reader retry is also fenced when its holder retires.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = mangaFixture('reader-unavailable');
      const entered = deferred<void>();
      const gate = deferred<typeof delivery>();
      const transport: MangaTransport = {
        ...fixture.transport,
        read: async (id) => {
          const result = await fixture.transport.read(id);
          entered.resolve();
          const kind = await gate.promise;
          if (kind === 'throw') throw new Error('Retired readback delivery');
          return kind === 'failure' ? { state: 'unavailable' } : result;
        },
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          key={`reader-${delivery}`}
          address="manga-readback"
          observed={{
            state: 'signed-in',
            subject: reader,
            csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
          }}
        >
          <MangaProfileEditor locale="en" session="signed-in" transport={transport} search={async () => []} />
        </CandidateReaderBoundary>
      );
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
      await until(
        () => !!host.querySelector('select') && !(host.querySelector('fieldset') as HTMLFieldSetElement).disabled,
      );
      await replace(input(host, m.catalogue_create_label()), 'Created by the previous reader');
      await click(host, m.manga_title());
      await until(() => host.textContent!.includes(m.catalogue_create_reader_unavailable()));
      fixture.setScenario('ready');
      const retry = within(host).getByRole('button', {
        name: m.correction_retry(),
      });
      const props = Object.keys(retry).find((key) => key.startsWith('__reactProps$'))!;
      const oldRetry = (Reflect.get(retry, props) as { onClick: () => Promise<void> }).onClick;
      await click(host, m.correction_retry());
      await entered.promise;
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await until(
        () => !!host.querySelector('select') && !(host.querySelector('fieldset') as HTMLFieldSetElement).disabled,
      );
      const before = structuredClone(fixture.calls);
      outside.focus();
      await act(async () => {
        await oldRetry();
        gate.resolve(delivery);
      });
      await settle();
      expect(fixture.calls).toEqual(before);
      expect(posts(fixture)).toHaveLength(1);
      expect(window.document.activeElement).toBe(outside);
      expect(host.textContent).not.toContain(m.manga_created());
      expect(within(host).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
      await replace(input(host, m.catalogue_create_label()), 'Fresh creation after retirement');
      await click(host, m.manga_title());
      await until(() => host.textContent!.includes(m.manga_created()));
      expect(posts(fixture)).toHaveLength(2);
    }
    await show(null);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}, 60_000);
