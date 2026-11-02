import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';

// Authored UNRUN. One actual mounted Album creation campaign using the existing generated-client fixture.
// DOM interaction is not layout, native authorization, private SSR or backend growth proof.
test('Album creation composes complete terms and initial facts while preserving exact commands, recovery and retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/album', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    HTMLButtonElement: window.HTMLButtonElement,
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
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { albumFixture, albumId, artistId, roleId, seriesId, partId } =
    await import('../src/kernel/fake/catalogue-album-profile');
  const { albumDraft } = await import('../src/features/catalogue/album-profile');
  const { pickText } = await import('@rezics/composition');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const outside = window.document.createElement('button');
  outside.textContent = 'Fresh reader focus';
  window.document.body.append(outside);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const show = (node: ReactNode) =>
    act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await settle();
    expect(predicate()).toBe(true);
  };
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const textbox = (scope: HTMLElement, name: string) =>
    within(scope).getByRole('textbox', { name }) as HTMLInputElement;
  const replace = (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      if (value) await user.type(control, value);
    });
  const select = (scope: HTMLElement, name: string, value: string) =>
    act(async () => user.selectOptions(within(scope).getByRole('combobox', { name }), value));
  type Fixture = ReturnType<typeof albumFixture>;
  const name = (fixture: Fixture, id: string) => pickText(fixture.release.properties[id]?.labels ?? {}, 'en').text;
  const writes = (fixture: Fixture) => fixture.calls.filter((call) => call.method === 'POST');
  const add = async (scope: HTMLElement, property: string) => {
    await select(scope, m.character_add_fact(), property);
    within(scope).getByRole('button', { name: m.correction_add() }).focus();
    await act(async () => user.keyboard('{Enter}'));
    const row = [...scope.querySelectorAll<HTMLElement>('fieldset[id^="album-row-"]')].at(-1)!;
    expect(row.contains(window.document.activeElement as unknown as Node)).toBe(true);
    return row;
  };
  const searches: string[] = [];
  const search = (fixture: Fixture) => async (text: string) => {
    searches.push(text);
    return [artistId, roleId, seriesId, partId].flatMap((id) => {
      const related = fixture.publicRead.related[id]!;
      const title = pickText(related.labels, 'en').text;
      return title.toLowerCase().includes(text.toLowerCase())
        ? [{ id, title, types: [related.type!], typeLabel: related.type!, cover: null }]
        : [];
    });
  };
  let mount = 0;
  const page = (
    fixture: Fixture,
    options: { transport?: typeof fixture.transport; session?: string; locale?: string } = {},
  ) => (
    <AlbumProfile
      key={++mount}
      locale={options.locale ?? 'en'}
      session={options.session ?? 'signed-in'}
      transport={options.transport ?? fixture.transport}
      search={search(fixture)}
    />
  );
  const ready = async (fixture: Fixture, options: Parameters<typeof page>[1] = {}) => {
    await show(page(fixture, options));
    await until(() => !!host.querySelector('form'));
    return host.querySelector<HTMLElement>('article')!;
  };
  const longName = 'Harbour sessions — 港の演奏 — جلسات الميناء ' + 'CompleteAlbumName'.repeat(10);
  const description = 'A complete album description 説明 محفوظة كاملة. '.repeat(4);
  const alias = 'Alternative album name 別名 اسم آخر ' + 'UnabridgedAlias'.repeat(12);
  const citation = 'https://artist.example/releases/' + 'original-source-'.repeat(16) + '?language=ja#credits';
  const fillTerms = async (scope: HTMLElement) => {
    await replace(textbox(scope, m.catalogue_create_language()), 'en');
    await replace(textbox(scope, m.catalogue_create_label()), longName);
    await replace(textbox(scope, m.catalogue_create_description()), description);
    await replace(textbox(scope, m.catalogue_create_aliases()), `${alias}\n港の別名`);
  };
  const date = async (scope: HTMLElement) => {
    const row = await add(scope, 'schema:datePublished');
    await select(row, m.correction_precision(), '9');
    await replace(textbox(row, m.correction_year()), '2024');
    await replace(textbox(row, m.relation_citation()), citation);
    return row;
  };
  const chooseTarget = async (scope: HTMLElement, label: string, text: string, title: RegExp) => {
    const input = within(scope).getByRole('combobox', { name: label });
    await act(async () => user.type(input, text));
    await until(
      () => within(window.document.body as unknown as HTMLElement).queryByRole('option', { name: title }) !== null,
    );
    const popup = within(window.document.body as unknown as HTMLElement).getByRole('listbox', { name: label });
    expect(within(popup).getAllByRole('option')).toHaveLength(1);
    // Select the real popup by native keyboard, rather than directly invoking a change callback.
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
  };
  const frame = (scope: HTMLElement, level: number) => {
    const heading = scope.querySelector(`h${level}`)!;
    expect(heading.getAttribute('data-content-item-slot')).toBe('title');
    expect(heading.parentElement!.classList.contains('isolate')).toBe(true);
    expect(heading.parentElement!.querySelector('[data-content-item-slot="preview"]')).not.toBeNull();
    expect(scope.querySelector('[data-slot="list-row-link"]')).toBeNull();
    expect(scope.querySelector('a button, a input, a select, button a')).toBeNull();
    expect(heading.className).not.toMatch(/truncate|line-clamp/);
  };
  const associations = (scope: HTMLElement) => {
    for (const label of scope.querySelectorAll<HTMLLabelElement>('label[for]')) {
      expect(label.htmlFor).not.toBe('');
      expect(scope.contains(window.document.getElementById(label.htmlFor))).toBe(true);
    }
  };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const queuedSubmit = (form: HTMLElement) => {
    const key = Object.keys(form).find((key) => key.startsWith('__reactProps$'))!;
    return (Reflect.get(form, key) as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit;
  };
  try {
    const fixture = albumFixture('uncertain');
    const longLabel = 'Artist credit — ' + 'Full released multilingual name 名称 الاسم '.repeat(6);
    fixture.release.properties['schema:contributor']!.labels.en = longLabel;
    const scope = await ready(fixture);
    expect(fixture.calls.map((call) => call.path)).toEqual([
      '/v1/definitions/active',
      expect.stringContaining('/v1/definitions/releases/'),
    ]);
    expect(scope.querySelectorAll('fieldset[id^="album-row-"]')).toHaveLength(0);
    frame(scope.querySelector('#album-terms')!, 2);
    expect(within(scope).getByRole('heading', { level: 2, name: m.album_initial_facts() })).toBeDefined();
    const beforeEdit = structuredClone(fixture.calls);
    await fillTerms(scope);
    const terms = scope.querySelector<HTMLElement>('#album-terms')!;
    const originalLanguage = textbox(terms, m.catalogue_create_language());
    const addLanguage = within(terms).getByRole('button', { name: m.catalogue_create_add_language() });
    const label = terms.querySelector<HTMLLabelElement>(`label[for="${originalLanguage.id}"]`)!;
    await act(async () => user.click(label));
    expect(window.document.activeElement).toBe(originalLanguage);
    originalLanguage.focus();
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(textbox(terms, m.catalogue_create_label()));
    await click(terms, m.catalogue_create_add_language());
    await click(terms, m.catalogue_create_add_language());
    const languages = within(terms).getAllByRole('textbox', { name: m.catalogue_create_language() });
    const blank = languages[1]!.closest('fieldset')!;
    const retained = languages[2]!.closest('fieldset')!;
    const retainedLabel = textbox(retained, m.catalogue_create_label());
    const retainedId = retainedLabel.id;
    await replace(languages[2]!, 'ja');
    await replace(retainedLabel, '港の演奏');
    await click(scope, m.album_create());
    expect(writes(fixture)).toHaveLength(0);
    const errorAnchor = scope.querySelector<HTMLAnchorElement>(`a[href="#${languages[1]!.id}"]`)!;
    expect(errorAnchor).not.toBeNull();
    expect(window.document.getElementById(errorAnchor.hash.slice(1))).toBe(languages[1]);
    const removeMiddle = within(blank).getByRole('button', { name: m.catalogue_create_remove_language() });
    expect(removeMiddle.getAttribute('aria-controls')).toBe(blank.id);
    removeMiddle.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(window.document.activeElement).toBe(languages[2]);
    expect(retainedLabel.id).toBe(retainedId);
    expect(retained.isConnected).toBe(true);
    await replace(languages[2]!, 'en');
    await click(scope, m.album_create());
    expect(writes(fixture)).toHaveLength(0); // duplicate language remains invalid
    await replace(languages[2]!, 'ja');
    await replace(textbox(retained, m.catalogue_create_description()), '完全な説明');
    await replace(textbox(retained, m.catalogue_create_aliases()), '港の別名\n演奏別名');
    expect(fixture.calls).toEqual(beforeEdit);

    const release = await date(scope);
    frame(release, 3);
    const external = await add(scope, 'schema:sameAs');
    await replace(textbox(external, m.correction_url()), citation);
    expect(within(external).getByText(citation, { selector: 'p' }).textContent).toBe(citation);
    const field = within(scope).getByRole('combobox', { name: m.character_add_fact() }) as HTMLSelectElement;
    expect([...field.options].some((option) => option.value === 'schema:datePublished')).toBe(false);
    const credit = await add(scope, 'schema:contributor');
    frame(credit, 3);
    expect(within(credit).getByRole('heading', { level: 3, name: longLabel }).textContent).toBe(longLabel);
    await chooseTarget(credit, longLabel, 'Harbour', /The Harbour Ensemble/);
    await select(credit, m.relation_qualifier(), 'wdt:P1932');
    const creditedAs = textbox(credit, name(fixture, 'wdt:P1932'));
    const creditedId = creditedAs.id;
    await replace(creditedAs, alias);
    await select(credit, m.relation_qualifier(), 'wdt:P3831');
    await chooseTarget(credit, name(fixture, 'wdt:P3831'), 'Performer', /Performer/);
    await select(credit, m.relation_qualifier(), 'schema:position');
    await replace(textbox(credit, name(fixture, 'schema:position')), '1');
    await select(credit, m.relation_qualifier(), 'wdt:P518');
    await chooseTarget(credit, name(fixture, 'wdt:P518'), 'story arc', /Harbour story arc/);
    expect(textbox(credit, name(fixture, 'wdt:P1932')).id).toBe(creditedId);
    expect(credit.querySelector('input[id^="relation-qualifier-"]')).not.toBeNull();
    await replace(textbox(credit, m.relation_citation()), citation);
    expect(within(credit).getByText(citation, { selector: 'p' }).textContent).toBe(citation);
    const qualifierSelect = within(credit).getByRole('combobox', { name: m.relation_qualifier() }) as HTMLSelectElement;
    expect([...qualifierSelect.options].filter((option) => option.value)).toHaveLength(0);
    // Remove and explicitly re-add a qualifier without losing the statement target or citation.
    await click(credit, `${m.relation_remove()}: ${name(fixture, 'schema:position')}`);
    await click(credit, `${m.relation_remove()}: ${name(fixture, 'schema:position')}`);
    await select(credit, m.relation_qualifier(), 'schema:position');
    await replace(textbox(credit, name(fixture, 'schema:position')), '1');
    const relation = await add(scope, 'wdt:P179');
    await chooseTarget(relation, name(fixture, 'wdt:P179'), 'Harbour', /Harbour concerts/);
    const classification = await add(scope, 'schema:genre');
    await chooseTarget(classification, name(fixture, 'schema:genre'), 'Performer', /Performer/);
    expect([...field.options].some((option) => option.value === 'schema:genre')).toBe(true);
    const extra = await add(scope, 'schema:contributor');
    await click(extra, m.recipe_remove_field());
    expect(extra.isConnected).toBe(false);
    expect(credit.isConnected).toBe(true);
    associations(scope);
    expect(fixture.calls).toEqual(beforeEdit); // picker fixture search adds no native reads
    expect(searches.length).toBeGreaterThan(0);
    const submit = queuedSubmit(scope.querySelector('form')!);
    await click(scope, m.album_create());
    await until(() => scope.textContent!.includes(m.catalogue_create_uncertain()));
    expect(writes(fixture)).toHaveLength(1);
    const original = structuredClone(writes(fixture)[0]!);
    expect(original.authorization).toBe('Bearer fixture');
    expect(original.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(original.body).toMatchObject({
      type: 'schema:MusicAlbum',
      labels: { en: longName, ja: '港の演奏' },
      descriptions: { en: description, ja: '完全な説明' },
      aliases: { en: [alias, '港の別名'], ja: ['港の別名', '演奏別名'] },
      statements: {
        'schema:datePublished': [
          {
            property: { id: 'schema:datePublished' },
            value: {
              type: 'value',
              content: {
                time: '+2024-00-00T00:00:00Z',
                precision: 9,
                calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
              },
            },
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }],
          },
        ],
        'schema:contributor': [
          {
            property: { id: 'schema:contributor' },
            value: { type: 'value', content: artistId },
            qualifiers: [
              { property: { id: 'wdt:P1932' }, value: { type: 'value', content: alias } },
              { property: { id: 'wdt:P3831' }, value: { type: 'value', content: roleId } },
              { property: { id: 'wdt:P518' }, value: { type: 'value', content: partId } },
              { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
            ],
            references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }],
          },
        ],
        'wdt:P179': [{ value: { type: 'value', content: seriesId } }],
        'schema:genre': [{ value: { type: 'value', content: roleId } }],
        'schema:sameAs': [{ value: { type: 'value', content: citation } }],
      },
    });
    expect(terms.matches(':disabled')).toBe(true);
    expect(within(scope).queryByRole('button', { name: m.catalogue_create_review_new() })).toBeNull();
    expect(within(scope).getByRole('button', { name: m.catalogue_create_retry() }).hasAttribute('disabled')).toBe(
      false,
    );
    // Replay is owned by the sealed item/key even if released metadata disappears between attempts.
    delete fixture.release.types['schema:MusicAlbum'];
    await click(scope, m.catalogue_create_retry());
    await until(() => scope.textContent!.includes(m.catalogue_create_created()));
    expect(writes(fixture)[1]).toEqual(original);
    expect(fixture.receipts.size).toBe(1);
    const created = within(scope).getByText(albumId, { selector: 'code' });
    frame(created.closest('section')!, 2);
    expect(created.textContent).toBe(albumId);
    expect(within(scope).getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toContain(
      `/en/subjects/${albumId}/`,
    );
    expect(fixture.calls.filter((call) => call.path === `/v1/subjects/${albumId}`)).toHaveLength(1);
    expect(fixture.calls.at(-1)).toMatchObject({ method: 'GET', authorization: null, session: 'album-session' });
    const afterCreated = structuredClone(fixture.calls);
    await act(async () => submit({ preventDefault() {} }));
    await settle();
    expect(fixture.calls).toEqual(afterCreated);

    // Each independent mount retains its own terms address and removal-focus destination.
    const independent = [albumFixture(), albumFixture()];
    await show(
      <>
        {independent.map((item, index) => (
          <AlbumProfile key={index} locale="en" session="signed-in" transport={item.transport} search={search(item)} />
        ))}
      </>,
    );
    await until(() => host.querySelectorAll('form').length === 2);
    const [a, b] = [...host.querySelectorAll<HTMLElement>('article')];
    const aLanguage = textbox(a!, m.catalogue_create_language());
    const bLanguage = textbox(b!, m.catalogue_create_language());
    expect(aLanguage.id).not.toBe(bLanguage.id);
    await click(a!, m.catalogue_create_add_language());
    const added = within(a!).getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!;
    await replace(added, 'ja');
    await click(a!, m.catalogue_create_remove_language());
    expect(window.document.activeElement).toBe(
      within(a!).getByRole('button', { name: m.catalogue_create_add_language() }),
    );
    expect(within(b!).getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(1);
    expect(independent.every((item) => writes(item).length === 0)).toBe(true);

    // Whole-field removal retains private values and sibling correction addresses.
    const removal = albumFixture();
    const delivery = deferred<Awaited<ReturnType<typeof removal.transport.create>>>();
    const commands: Parameters<typeof removal.transport.create>[0][] = [];
    const removalPanel = await ready(removal, {
      transport: {
        ...removal.transport,
        create: (command) => {
          commands.push(command);
          return delivery.promise;
        },
      },
    });
    await fillTerms(removalPanel);
    const empty = await add(removalPanel, 'schema:contributor');
    await click(empty, m.recipe_remove_field());
    expect(empty.isConnected).toBe(false);
    expect(window.document.activeElement?.id).toBe('album-field');
    const complete = await add(removalPanel, 'schema:contributor');
    await chooseTarget(complete, name(removal, 'schema:contributor'), 'Harbour', /Harbour Ensemble/);
    await select(complete, m.relation_qualifier(), 'wdt:P1932');
    await replace(textbox(complete, name(removal, 'wdt:P1932')), 'Credited name');
    await replace(textbox(complete, m.relation_citation()), citation);
    const cited = await add(removalPanel, 'schema:contributor');
    await replace(textbox(cited, m.relation_citation()), citation);
    const qualified = await add(removalPanel, 'schema:contributor');
    await select(qualified, m.relation_qualifier(), 'wdt:P1932');
    await replace(textbox(qualified, name(removal, 'wdt:P1932')), 'Qualifier only');
    await click(removalPanel, m.album_create());
    const correctionLinks = () =>
      [...removalPanel.querySelectorAll<HTMLAnchorElement>('a[href^="#album-row-"]')].map((link) => link.hash);
    const correctionTargets = correctionLinks();
    expect(correctionTargets.some((hash) => hash.startsWith(`#${cited.id}`))).toBe(true);
    const values = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLInputElement>('input')].map((input) => [input.id, input.value]);
    for (const row of [complete, cited, qualified]) {
      const snapshot = values(row);
      await click(row, m.recipe_remove_field());
      expect(window.document.activeElement).toBe(within(row).getByRole('button', { name: m.candidate_cancel() }));
      await click(row, m.candidate_cancel());
      expect(values(row)).toEqual(snapshot);
      expect(window.document.activeElement).toBe(within(row).getByRole('button', { name: m.recipe_remove_field() }));
    }
    expect(complete.textContent).toContain('Harbour Ensemble');
    await click(complete, m.recipe_remove_field());
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(within(complete).getByRole('button', { name: m.recipe_remove_field() }));
    await click(complete, m.recipe_remove_field());
    await click(complete, m.recipe_remove_field());
    expect(complete.isConnected).toBe(false);
    expect(cited.isConnected && qualified.isConnected).toBe(true);
    expect(cited.contains(window.document.activeElement as unknown as Node)).toBe(true);
    expect(correctionLinks()).toEqual(correctionTargets);
    expect(textbox(removalPanel, m.catalogue_create_label()).value).toBe(longName);
    for (const row of [cited, qualified]) {
      await click(row, m.recipe_remove_field());
      await click(row, m.recipe_remove_field());
      expect(row.isConnected).toBe(false);
    }
    expect(window.document.activeElement?.id).toBe('album-field');
    const sealed = await add(removalPanel, 'schema:contributor');
    await chooseTarget(sealed, name(removal, 'schema:contributor'), 'Harbour', /Harbour Ensemble/);
    await click(sealed, m.recipe_remove_field());
    await click(removalPanel, m.album_create());
    expect(commands).toHaveLength(1);
    await click(sealed, m.recipe_remove_field());
    expect(sealed.isConnected).toBe(true);
    expect(within(sealed).getByRole('button', { name: m.recipe_remove_field() }).matches(':disabled')).toBe(true);
    await act(async () => delivery.resolve({ ok: false, reason: 'unavailable' }));
    await click(sealed, m.recipe_remove_field());
    expect(sealed.isConnected).toBe(true);
    await click(removalPanel, m.catalogue_create_retry());
    expect(commands[1]).toBe(commands[0]);

    for (const scenario of ['denied', 'conflict', 'invalid', 'stale-metadata'] as const) {
      const failed = albumFixture(scenario);
      const panel = await ready(failed);
      await fillTerms(panel);
      const dateRow = await date(panel);
      await click(panel, m.album_create());
      const message =
        scenario === 'denied'
          ? m.catalogue_create_denied()
          : scenario === 'conflict'
            ? m.catalogue_create_conflict()
            : m.catalogue_create_invalid();
      await until(
        () =>
          panel.textContent!.includes(message) && panel.querySelector('form')?.getAttribute('aria-busy') === 'false',
      );
      const first = structuredClone(writes(failed)[0]!);
      expect(writes(failed)).toHaveLength(1);
      expect(panel.querySelector('fieldset')!.matches(':disabled')).toBe(true);
      if (scenario === 'invalid' || scenario === 'stale-metadata') {
        const anchor = panel.querySelector<HTMLAnchorElement>('a[href^="#album-row-"]')!;
        expect(window.document.getElementById(anchor.hash.slice(1))).toBe(dateRow);
        if (scenario === 'stale-metadata') expect(dateRow.textContent).toContain(m.correction_stale());
        expect(failed.calls.filter((call) => call.path === '/v1/definitions/active')).toHaveLength(2);
      }
      const noAuto = structuredClone(failed.calls);
      await settle();
      expect(failed.calls).toEqual(noAuto);
      await click(panel, m.catalogue_create_review_new());
      expect(textbox(panel, m.catalogue_create_label()).value).toBe(longName);
      expect(panel.querySelector('fieldset')!.matches(':disabled')).toBe(false);
      if (scenario === 'stale-metadata') {
        await click(dateRow, m.recipe_remove_field());
        await click(dateRow, m.recipe_remove_field());
      }
      failed.setScenario('ready');
      await click(panel, m.album_create());
      await until(() => panel.textContent!.includes(m.catalogue_create_created()));
      expect(writes(failed)[1]!.key).not.toBe(first.key);
    }

    // Native grouped indices distinguish repeated creators; authored languages keep separate targets.
    const exact = albumFixture('reader-unavailable');
    exact.publicRead.related[seriesId] = { type: 'schema:Organization', labels: { en: 'Guest ensemble' } };
    const { albumCreateCorrections } = await import('../src/features/catalogue/album-create-guidance');
    const escaped = 'schema:credit/~original';
    exact.release.properties[escaped] = exact.release.properties['schema:contributor']!;
    const sample = (id: string, property: string) => ({
      id,
      statement: {
        property: { id: property },
        value: { type: 'value' as const, content: artistId },
        references: [],
      },
    });
    const addressed = albumCreateCorrections(
      [
        { pointer: '/statements/schema:credit~1~0original/1/value/content', code: 'unsupported' },
        { pointer: '/labels/bad~1~0language', code: 'invalid_format' },
        { pointer: '/statements/schema:credit~1~0original/4/value/content', code: 'unsupported' },
        { pointer: '/statements/schema:credit~2original/1/value/content', code: 'unsupported' },
        { pointer: '/statements/schema:credit~1~0original', code: 'unsupported' },
      ],
      [{ id: 42, language: 'bad/~language', label: 'Name', description: '', aliases: '' }],
      [sample('first', escaped), sample('middle', 'schema:contributor'), sample('second', escaped)],
      exact.release,
      'en',
      'terms',
    );
    expect(addressed.map((error) => error.target)).toEqual([
      'album-row-second-value',
      'terms-language-42',
      undefined,
      undefined,
      undefined,
    ]);
    let rejection = true;
    const commands: import('../src/features/catalogue/album-profile').AlbumCommand[] = [];
    const exactPanel = await ready(exact, {
      transport: {
        ...exact.transport,
        create: async (command) => {
          commands.push(structuredClone(command));
          if (!rejection) return exact.transport.create(command);
          return {
            ok: false,
            reason: 'invalid',
            errors: [
              { pointer: '/statements/schema:contributor/1/value/content', code: 'unsupported' },
              { pointer: '/labels/ja', code: 'out_of_range' },
              { pointer: '/statements/schema:contributor/1/qualifiers/0/value/content', code: 'invalid_format' },
              {
                pointer: '/statements/schema:contributor/1/references/0/parts/0/value/content',
                code: 'invalid_format',
              },
              { pointer: '/statements/schema:contributor/01/value/content', code: 'unsupported' },
            ],
          };
        },
      },
    });
    await replace(textbox(exactPanel, m.catalogue_create_label()), 'First name');
    await click(exactPanel, m.catalogue_create_add_language());
    const secondTerms = within(exactPanel)
      .getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!
      .closest('fieldset')!;
    await replace(textbox(secondTerms, m.catalogue_create_language()), 'ja');
    await replace(textbox(secondTerms, m.catalogue_create_label()), 'Second name');
    const firstCreator = await add(exactPanel, 'schema:contributor');
    const secondCreator = await add(exactPanel, 'schema:contributor');
    for (const creator of [firstCreator, secondCreator])
      await chooseTarget(creator, name(exact, 'schema:contributor'), 'Harbour', /Harbour/);
    await select(secondCreator, m.relation_qualifier(), 'wdt:P1932');
    await replace(textbox(secondCreator, name(exact, 'wdt:P1932')), 'Credit');
    await replace(textbox(secondCreator, m.relation_citation()), 'https://example.com/credit');
    await click(exactPanel, m.album_create());
    await until(() => commands.length === 1 && exactPanel.querySelector('form')?.getAttribute('aria-busy') === 'false');
    const corrections = [...exactPanel.querySelectorAll<HTMLAnchorElement>('[role="alert"] a')];
    expect(corrections).toHaveLength(4);
    expect(corrections[0]!.hash).toBe(`#${secondCreator.id}-value`);
    expect(corrections[1]!.hash).toBe(`#${textbox(secondTerms, m.catalogue_create_label()).id}`);
    expect(corrections[2]!.hash).toBe(`#${secondCreator.id}-qualifier-0`);
    expect(corrections[3]!.hash).toBe(`#album-citation-${secondCreator.id.slice('album-row-'.length)}`);
    expect(exactPanel.textContent).toContain('/statements/schema:contributor/01/value/content');
    for (const [index, row] of [
      [0, secondCreator],
      [2, secondCreator],
      [3, secondCreator],
    ] as const) {
      await act(async () => user.click(corrections[index]!));
      expect(row.contains(window.document.activeElement)).toBe(true);
      expect(window.document.activeElement?.matches(':disabled')).toBe(false);
    }
    await replace(within(secondCreator).getByRole('combobox', { name: name(exact, 'schema:contributor') }), '');
    await chooseTarget(secondCreator, name(exact, 'schema:contributor'), 'Guest', /Guest ensemble/);
    await act(async () => user.click(corrections[1]!));
    expect(window.document.activeElement).toBe(textbox(secondTerms, m.catalogue_create_label()));
    await replace(textbox(secondTerms, m.catalogue_create_label()), 'Corrected second name');
    rejection = false;
    await click(exactPanel, m.album_create());
    await until(() => exactPanel.textContent!.includes(m.catalogue_create_reader_unavailable()));
    expect(commands[1]!.item.labels).toEqual({ en: 'First name', ja: 'Corrected second name' });
    expect(commands[1]!.item.statements['schema:contributor']![0]).toEqual(
      commands[0]!.item.statements['schema:contributor']![0],
    );
    expect(commands[1]!.item.statements['schema:contributor']![1]!.value).toEqual({ type: 'value', content: seriesId });
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    exact.setScenario('ready');
    await click(exactPanel, m.catalogue_create_retry());
    await until(() => within(exactPanel).queryByRole('link', { name: m.catalogue_create_open() }) !== null);
    expect(commands).toHaveLength(2);

    // Failed metadata refresh keeps the draft locked after Review new until deliberate successful reload.
    const metadata = albumFixture('invalid');
    let unavailable = true;
    let loads = 0;
    const transport = {
      ...metadata.transport,
      load: async () => {
        loads++;
        return loads > 1 && unavailable
          ? { ok: false as const, reason: 'unavailable' as const }
          : metadata.transport.load();
      },
    };
    const locked = await ready(metadata, { transport });
    await fillTerms(locked);
    await date(locked);
    await click(locked, m.album_create());
    await until(() => locked.textContent!.includes(m.album_missing()));
    await click(locked, m.catalogue_create_review_new());
    expect(locked.querySelector('fieldset')!.matches(':disabled')).toBe(true);
    expect(loads).toBe(2);
    unavailable = false;
    metadata.setScenario('ready');
    await click(locked, m.correction_reload());
    await until(() => !locked.querySelector('fieldset')!.matches(':disabled'));
    expect(loads).toBe(3);
    expect(textbox(locked, m.catalogue_create_label()).value).toBe(longName);
    expect(writes(metadata)).toHaveLength(1);

    // Removed property definitions preserve their row, native anchor and visible stale warning.
    const missing = albumFixture('invalid');
    let refresh = false;
    const missingTransport = {
      ...missing.transport,
      load: async () => {
        if (refresh) delete missing.release.properties['schema:datePublished'];
        return missing.transport.load();
      },
    };
    const missingScope = await ready(missing, { transport: missingTransport });
    await fillTerms(missingScope);
    const missingRow = await date(missingScope);
    refresh = true;
    await click(missingScope, m.album_create());
    await until(() => missingRow.textContent!.includes(m.correction_stale()));
    expect(missingRow.isConnected).toBe(true);
    expect(missingRow.textContent).toContain(m.guide_missing());
    expect(missingScope.querySelector<HTMLAnchorElement>('a[href^="#album-row-"]')!.hash).toBe(`#${missingRow.id}`);
    expect(writes(missing)).toHaveLength(1);

    const recovery = albumFixture('reader-unavailable');
    const saved = await ready(recovery);
    await fillTerms(saved);
    await click(saved, m.album_create());
    await until(() => saved.textContent!.includes(m.catalogue_create_reader_unavailable()));
    expect(within(saved).queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    expect(within(saved).getByText(albumId, { selector: 'code' }).textContent).toBe(albumId);
    const readCount = () => recovery.calls.filter((call) => call.path === `/v1/subjects/${albumId}`).length;
    expect(readCount()).toBe(1);
    await settle();
    expect(readCount()).toBe(1);
    recovery.setScenario('concealed');
    await click(saved, m.catalogue_create_retry());
    await until(() => saved.textContent!.includes(m.catalogue_create_concealed()));
    expect(readCount()).toBe(2);
    expect(within(saved).queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    recovery.setScenario('ready');
    await click(saved, m.catalogue_create_retry());
    await until(() => within(saved).queryByRole('link', { name: m.catalogue_create_open() }) !== null);
    expect(readCount()).toBe(3);
    expect(writes(recovery)).toHaveLength(1);

    // Operation: supplied term/initial-fact presentation.
    // Touches: supplied rows and effective definitions only; no related-population enumeration.
    // Bound: 1/8/64 scalar facts plus one term, at most 32 per property and below the native 512-total bound.
    // Growth check: exact controls/value retention, constant frame overhead and unchanged fixture reads.
    for (const count of [1, 8, 64]) {
      const growth = albumFixture();
      let traversals = 0;
      growth.publicRead.related = new Proxy(growth.publicRead.related, {
        ownKeys(target) {
          traversals++;
          return Reflect.ownKeys(target);
        },
      });
      const growing = await ready(growth);
      await replace(textbox(growing, m.catalogue_create_label()), 'Growth album');
      const baseline = structuredClone(growth.calls);
      const searchCount = searches.length;
      const statements = [];
      for (let index = 0; index < count; index++) {
        const property = index % 2 ? 'schema:sameAs' : 'schema:inLanguage';
        const value = index % 2 ? `https://artist.example/identity/${index}` : `en-${String(index).padStart(3, '0')}`;
        const row = await add(growing, property);
        await replace(textbox(row, index % 2 ? m.correction_url() : m.correction_value()), value);
        expect(textbox(row, index % 2 ? m.correction_url() : m.correction_value()).value).toBe(value);
        if (index % 2) expect(within(row).getByText(value, { selector: 'p' }).textContent).toBe(value);
        statements.push({
          property: { id: property },
          value: { type: 'value' as const, content: value },
          qualifiers: [],
          references: [],
          rank: 'normal' as const,
        });
        frame(row, 3);
      }
      expect(
        albumDraft(
          growth.release,
          [{ language: 'en', label: 'Growth album', description: '', aliases: '' }],
          statements,
        ).errors,
      ).toEqual([]);
      expect(growing.querySelectorAll('fieldset[id^="album-row-"]')).toHaveLength(count);
      expect(growing.querySelectorAll('[data-content-item-slot="title"]')).toHaveLength(count + 2);
      expect(growth.calls).toEqual(baseline);
      expect(searches.length).toBe(searchCount);
      expect(traversals).toBe(0);
    }

    for (const scenario of ['empty', 'unavailable', 'loading'] as const) {
      const absent = albumFixture(scenario);
      await show(page(absent));
      if (scenario === 'loading') await settle();
      else
        await until(() =>
          host.textContent!.includes(scenario === 'empty' ? m.album_missing() : m.correction_unavailable()),
        );
      expect(host.querySelector('form')).toBeNull();
      expect(writes(absent)).toHaveLength(0);
      const calls = structuredClone(absent.calls);
      await settle();
      expect(absent.calls).toEqual(calls);
    }
    const signedOut = albumFixture();
    const disabled = await ready(signedOut, { session: 'signed-out' });
    expect(disabled.textContent).toContain(m.catalogue_create_signed_out());
    expect(disabled.querySelector('fieldset')!.matches(':disabled')).toBe(true);
    expect((within(disabled).getByRole('button', { name: m.album_create() }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes(signedOut)).toHaveLength(0);

    // Reader changes retire actual positive writes and queued native events, including late failure/throw.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const retired = albumFixture();
      const gate = deferred<typeof delivery>();
      const entered = deferred<void>();
      let hold = true;
      const guarded = {
        ...retired.transport,
        create: async (command: Parameters<typeof retired.transport.create>[0]) => {
          const result = await retired.transport.create(command);
          if (!hold) return result;
          hold = false;
          entered.resolve();
          const outcome = await gate.promise;
          if (outcome === 'throw') throw new Error('Retired Album delivery');
          return outcome === 'failure' ? { ok: false as const, reason: 'unavailable' as const } : result;
        },
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          key={delivery}
          address="album-creation"
          observed={{ state: 'signed-in', subject: reader, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }}
        >
          <AlbumProfile locale="en" session="signed-in" transport={guarded} search={search(retired)} />
        </CandidateReaderBoundary>
      );
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
      await until(() => !!host.querySelector('form'));
      await replace(textbox(host, m.catalogue_create_label()), 'Retired album');
      const oldSubmit = queuedSubmit(host.querySelector('form')!);
      await click(host, m.album_create());
      await entered.promise;
      expect(writes(retired)).toHaveLength(1);
      expect(host.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
      await act(async () => oldSubmit({ preventDefault() {} }));
      expect(writes(retired)).toHaveLength(1);
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await until(() => !!host.querySelector('form'));
      const calls = structuredClone(retired.calls);
      outside.focus();
      await act(async () => {
        oldSubmit({ preventDefault() {} });
        gate.resolve(delivery);
      });
      await settle();
      expect(retired.calls).toEqual(calls);
      expect(window.document.activeElement).toBe(outside);
      expect(host.textContent).not.toContain(m.catalogue_create_created());
      expect(within(host).queryByRole('button', { name: m.catalogue_create_retry() })).toBeNull();
      await replace(textbox(host, m.catalogue_create_label()), 'Fresh album');
      await click(host, m.album_create());
      await until(() => host.textContent!.includes(m.catalogue_create_created()));
      expect(writes(retired)).toHaveLength(2);
      expect(writes(retired)[1]!.key).not.toBe(writes(retired)[0]!.key);
    }
    // A held definitions read cannot populate a retired Query or disturb a fresh editor.
    const readFixture = albumFixture();
    const readGate = deferred<void>();
    const readEntered = deferred<void>();
    let holdRead = true;
    const readTransport = {
      ...readFixture.transport,
      load: async () => {
        const result = await readFixture.transport.load();
        if (holdRead) {
          holdRead = false;
          readEntered.resolve();
          await readGate.promise;
        }
        return result;
      },
    };
    const reading = (reader: string) => (
      <CandidateReaderBoundary
        address="album-definitions"
        observed={{ state: 'signed-in', subject: reader, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }}
      >
        <AlbumProfile locale="en" session="signed-in" transport={readTransport} search={search(readFixture)} />
      </CandidateReaderBoundary>
    );
    await show(reading('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
    await readEntered.promise;
    const retiredQuery = client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'album-profile' && query.state.fetchStatus === 'fetching')
      .at(-1)!;
    expect(retiredQuery).toBeDefined();
    await show(reading('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
    await until(() => !!host.querySelector('form'));
    const calls = structuredClone(readFixture.calls);
    outside.focus();
    await act(async () => readGate.resolve());
    await settle();
    expect(retiredQuery.state.data).toBeUndefined();
    expect(readFixture.calls).toEqual(calls);
    expect(window.document.activeElement).toBe(outside);
    expect(host.querySelector('form')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}, 60_000);
