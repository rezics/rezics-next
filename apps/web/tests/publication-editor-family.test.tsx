import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { CreateFailure } from '../src/features/catalogue/create-subject';
import type { PublicationCommand, PublicationTransport } from '../src/features/catalogue/publication-editor';
import type { PublicationScenario } from '../src/kernel/fake/publication-editor';

// A DOM renderer supplies no browser geometry, native or SSR proof.
test('independent publication creation, local corrections, immutable recovery and actual reader results compose the complete family', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/publication' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
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
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useRouterState } =
    await import('@tanstack/react-router');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { PublicationEditor } = await import('../src/features/catalogue/publication-editor-form');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { publicationFixture, publicationCreatedId } = await import('../src/kernel/fake/publication-editor');
  const { publicationProfiles } = await import('../src/features/catalogue/publication-editor');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement, { identifierPrefix: ':publication:' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  const canvas = within(host as unknown as HTMLElement);
  const publisherId = '00000000-0000-4000-8000-00000000e003';
  const searchCalls: string[] = [];
  const search = async (text: string) => {
    searchCalls.push(text);
    return [
      {
        id: publisherId,
        title: 'Supplied publisher',
        types: ['schema:Organization'],
        typeLabel: 'Publisher',
        cover: null,
      },
      {
        id: '00000000-0000-4000-8000-00000000e004',
        title: 'Wrong target',
        types: ['schema:Book'],
        typeLabel: 'Work',
        cover: null,
      },
    ];
  };
  function tracked(scenario: PublicationScenario = 'ready', workType = 'schema:Book') {
    const fixture = publicationFixture(scenario, 'en', workType);
    const commands: PublicationCommand[] = [];
    const navigations: string[] = [];
    let loads = 0;
    const reads: string[] = [];
    const transport: PublicationTransport = {
      load: async () => {
        loads++;
        return fixture.transport.load();
      },
      submit: async (command) => {
        commands.push(structuredClone(command));
        const result = await fixture.transport.submit(command);
        return !result.ok && result.reason === 'unavailable' ? { ...result, refreshDefinitions: true } : result;
      },
      read: async (id) => {
        reads.push(id);
        return fixture.transport.read(id);
      },
    };
    return { fixture, commands, navigations, transport, reads, loads: () => loads };
  }
  type Entry = ReturnType<typeof tracked> & { session?: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable' };
  let entries: Entry[] = [];
  let scene = 0;
  let admitted = true;
  const observed = () =>
    admitted
      ? { state: 'signed-in' as const, subject: 'reader', csrfToken: 'original-credential-epoch' }
      : { state: 'signed-out' as const, csrfToken: null };
  const Scene = () => {
    const destination = useRouterState({ select: (state) => state.location.search.page });
    return destination === 'other' ? null : (
      <CandidateReaderBoundary address={`publication-family-${scene}`} observed={observed()}>
        {admitted &&
          entries.map((entry, index) => (
            <PublicationEditor
              key={index}
              work={entry.fixture.work.subject.id}
              locale="en"
              session={entry.session ?? 'signed-in'}
              transport={entry.transport}
              search={search}
              onNavigate={(href) => entry.navigations.push(href)}
            />
          ))}
      </CandidateReaderBoundary>
    );
  };
  const rootRoute = createRootRoute({ component: Scene });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const draw = async () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
  const mount = async (...next: Entry[]) => {
    scene++;
    entries = next;
    admitted = true;
    await draw();
  };
  const article = (index = 0) => canvas.getAllByRole('article')[index]!;
  const scope = (index = 0) => within(article(index));
  const input = (name: string, index = 0) => scope(index).getByRole('textbox', { name }) as HTMLInputElement;
  const replace = (element: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(element);
      if (value) await user.type(element, value);
    });
  const click = (name: string, index = 0) => act(async () => user.click(scope(index).getByRole('button', { name })));
  const add = (property: string, index = 0) =>
    act(async () => {
      await user.selectOptions(scope(index).getByRole('combobox', { name: m.publication_field() }), property);
      await user.click(scope(index).getByRole('button', { name: m.correction_add() }));
    });
  const ready = async (index = 0) => {
    await scope(index).findByRole('textbox', { name: m.catalogue_create_label() });
    await replace(input(m.catalogue_create_label(), index), 'A distinct edition');
    await act(async () => user.click(scope(index).getByRole('checkbox', { name: m.publication_independent() })));
  };
  const ids = () => [...host.querySelectorAll('[id]')].map((element) => element.id);
  const associations = async (index: number) => {
    const current = article(index);
    for (const label of current.querySelectorAll<HTMLLabelElement>('label[for]')) {
      const control = window.document.getElementById(label.htmlFor);
      expect(control).not.toBeNull();
      expect(current.contains(control)).toBe(true);
    }
    for (const element of current.querySelectorAll('[aria-describedby], [aria-labelledby]')) {
      for (const attribute of ['aria-describedby', 'aria-labelledby']) {
        for (const id of (element.getAttribute(attribute) ?? '').split(' ').filter(Boolean)) {
          expect(current.contains(window.document.getElementById(id))).toBe(true);
        }
      }
    }
    for (const link of current.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      const target = window.document.getElementById(decodeURIComponent(link.hash.slice(1)))!;
      expect(current.contains(target)).toBe(true);
      expect(target.matches('input, select, button, [tabindex="-1"]')).toBe(true);
      // Programmatic focusability only: browser fragment navigation needs a browser witness.
      await act(async () => target.focus());
      expect(window.document.activeElement).toBe(target);
    }
  };
  try {
    const first = tracked();
    const second = tracked();
    first.fixture.work.subject.labels.en = 'Long supplied work ' + '星の図書館'.repeat(24);
    first.fixture.release.types['bf:Instance']!.labels.en = 'Long supplied publication profile ' + '版'.repeat(70);
    first.fixture.release.properties['schema:url']!.labels.en = 'Long supplied citation source ' + '出典'.repeat(40);
    await mount(first, second);
    await scope(0).findByRole('textbox', { name: m.catalogue_create_label() });
    await scope(1).findByRole('textbox', { name: m.catalogue_create_label() });
    const initialIds = ids();
    expect(initialIds.some((id) => id.includes(':publication:'))).toBe(true);
    expect(new Set(initialIds).size).toBe(initialIds.length);
    await associations(0);
    await associations(1);
    const profile = publicationProfiles(first.fixture.release, first.fixture.work.subject.type, 'en')[0]!;
    expect(scope().getByRole('heading', { name: first.fixture.work.subject.labels.en, level: 2 })).toBeDefined();
    expect(scope().getByRole('heading', { name: profile.label, level: 2 }).closest('legend')).not.toBeNull();
    const description = article().querySelector('[id$="-profile-description"]')!;
    expect(description.getAttribute('lang')).toBe(profile.descriptionLang);
    expect(description.textContent).toContain(profile.description);
    if (profile.descriptionLang && profile.descriptionLang !== 'en')
      expect(description.textContent).toContain(m.guide_fallback({ language: profile.descriptionLang }));
    expect(
      scope().getByRole('heading', { name: first.fixture.release.properties['schema:url']!.labels.en, level: 2 }),
    ).toBeDefined();
    const options = scope().getByRole('combobox', { name: m.publication_field() }) as HTMLSelectElement;
    expect([...options.options].map((option) => option.value)).toEqual(['', ...profile.fields]);
    const relations = scope().getByRole('combobox', { name: m.relation_property() }) as HTMLSelectElement;
    expect([...relations.options].map((option) => option.value)).toEqual(profile.relations);
    const back = subjectHref(
      { id: first.fixture.work.subject.id, label: first.fixture.work.subject.labels.en! },
      'en',
    ).href;
    expect(scope().getByRole('link', { name: m.publication_back() }).getAttribute('href')).toBe(back);
    expect(scope().getByRole('link', { name: first.fixture.work.subject.labels.en }).getAttribute('href')).toBe(back);
    expect(scope().getByRole('link', { name: m.publication_search() }).getAttribute('href')).toBe(
      `/en/search?q=${encodeURIComponent(first.fixture.work.subject.labels.en!)}`,
    );
    const beforeValidation = first.fixture.calls.length;
    await replace(input(m.catalogue_create_label(), 1), 'Untouched second draft');
    await click(m.publication_submit());
    expect(scope().getByRole('checkbox', { name: m.publication_independent() }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(scope(1).queryByRole('alert')).toBeNull();
    expect(first.commands).toHaveLength(0);
    expect(first.fixture.calls).toHaveLength(beforeValidation);
    await associations(0);
    await ready();
    await add('schema:isbn');
    await replace(input(m.correction_value()), '978-0-140-44430-8');
    await add('schema:isbn', 1);
    await replace(input(m.correction_value(), 1), 'Second ISBN draft');
    await click(m.relation_remove(), 1);
    await click(m.relation_remove(), 1);
    expect(scope(1).queryByRole('textbox', { name: m.correction_value() })).toBeNull();
    expect(input(m.correction_value()).value).toBe('978-0-140-44430-8');
    const stableIds = ids();
    await draw();
    expect(ids()).toEqual(stableIds);
    expect(first.loads()).toBe(1);
    expect(second.loads()).toBe(1);
    expect(second.fixture.calls).toHaveLength(3);
    expect(input(m.catalogue_create_label(), 1).value).toBe('Untouched second draft');
    await associations(0);
    await associations(1);

    // The real fixture transport proves the exact payload and bounded request sequence for uncertain retry.
    const uncertain = tracked('uncertain');
    await mount(uncertain);
    await ready();
    await add('schema:isbn');
    await replace(input(m.correction_value()), '978-0-140-44430-8');
    await add('schema:datePublished');
    await act(async () => user.selectOptions(scope().getByRole('combobox', { name: m.correction_precision() }), '10'));
    await replace(input(m.correction_year()), '2026');
    await replace(scope().getByRole('spinbutton', { name: m.correction_month() }), '10');
    await add('schema:numberOfPages');
    await replace(input(m.correction_amount()), '+240');
    await act(async () => user.selectOptions(scope().getByRole('combobox', { name: m.correction_unit() }), '1'));
    await replace(input(m.relation_citation()), 'https://publisher.example/edition');
    await click(m.publication_submit());
    await scope().findByRole('heading', { name: m.catalogue_create_uncertain(), level: 2 });
    expect(uncertain.commands).toHaveLength(1);
    const original = uncertain.commands[0]!;
    expect(original.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(original.item).toMatchObject({ type: 'bf:Instance', labels: { en: 'A distinct edition' } });
    expect(Object.keys(original.item.statements)).toEqual([
      'schema:exampleOfWork',
      'schema:isbn',
      'schema:datePublished',
      'schema:numberOfPages',
    ]);
    expect(original.item.statements['schema:exampleOfWork']![0]!.value).toEqual({
      type: 'value',
      content: uncertain.fixture.work.subject.id,
    });
    expect(original.item.statements['schema:datePublished']![0]!.value).toEqual({
      type: 'value',
      content: {
        time: '+2026-10-00T00:00:00Z',
        precision: 10,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      },
    });
    expect(original.item.statements['schema:numberOfPages']![0]!.value).toEqual({
      type: 'value',
      content: { amount: '+240', unit: '1' },
    });
    for (const statements of Object.values(original.item.statements))
      expect(statements[0]!.references).toEqual([
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://publisher.example/edition' } },
          ],
        },
      ]);
    for (const control of article().querySelectorAll('input, select'))
      expect(control.closest('fieldset[disabled]')).not.toBeNull();
    expect(uncertain.fixture.calls).toHaveLength(7); // initial 3 + current work/release 3 + one lost POST
    expect(scope().queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    await draw();
    expect(uncertain.fixture.calls).toHaveLength(7);
    expect(uncertain.commands).toHaveLength(1);
    await click(m.catalogue_create_retry());
    const reader = await scope().findByRole('link', { name: m.catalogue_create_open() });
    expect(reader.getAttribute('href')).toBe(`/en/subjects/${publicationCreatedId}/a-distinct-edition`);
    expect(uncertain.commands).toEqual([original, original]);
    expect(uncertain.loads()).toBe(1); // Even a refresh hint cannot rewrite an uncertain command.
    const posts = uncertain.fixture.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ body: original.item, key: original.key, authorization: 'Bearer fixture' });
    expect(posts[1]).toEqual(posts[0]);
    expect(uncertain.fixture.calls).toHaveLength(12);
    expect(uncertain.fixture.receipts.size).toBe(1);
    expect(uncertain.navigations).toEqual([reader.getAttribute('href')!]);
    expect(
      scope().getByRole('heading', { name: m.catalogue_create_created(), level: 2 }).closest('[role="status"]'),
    ).not.toBeNull();
    expect(article().querySelector('form')).toBeNull();
    await associations(0);

    // A definite refusal points to the exact scalar and citation controls while preserving every other fact.
    const correction = tracked();
    const submitNative = correction.transport.submit;
    const refusal: CreateFailure = {
      ok: false,
      reason: 'invalid',
      errors: [
        { pointer: '/statements/schema:numberOfPages/0/value/content/amount', code: 'out_of_range' },
        { pointer: '/statements/schema:datePublished/0/value/content/precision', code: 'unsupported' },
        { pointer: '/statements/schema:exampleOfWork/0/references', code: 'required' },
      ],
    };
    let firstRefusal = true;
    correction.transport = {
      ...correction.transport,
      submit: async (command) => {
        if (firstRefusal) {
          firstRefusal = false;
          correction.commands.push(structuredClone(command));
          return refusal;
        }
        return submitNative(command);
      },
    };
    await mount(correction);
    await ready();
    await add('schema:datePublished');
    const precision = scope().getByRole('combobox', { name: m.correction_precision() }) as HTMLSelectElement;
    await act(async () => user.selectOptions(precision, '10'));
    await replace(input(m.correction_year()), '2026');
    await replace(scope().getByRole('spinbutton', { name: m.correction_month() }), '10');
    await add('schema:numberOfPages');
    const amount = input(m.correction_amount());
    await replace(amount, '+240');
    await act(async () =>
      user.selectOptions(scope().getByRole('combobox', { name: m.correction_unit() }), '1'),
    );
    await add('schema:publisher');
    const publisherLabel = correction.fixture.release.properties['schema:publisher']!.labels.en!;
    await act(async () => user.type(scope().getByRole('combobox', { name: publisherLabel }), 'Press'));
    const correctionBody = within(window.document.body as unknown as HTMLElement);
    await act(async () =>
      user.click(await correctionBody.findByRole('option', { name: /Supplied publisher/ })),
    );
    await click(m.publication_submit());
    await scope().findByRole('heading', { name: m.catalogue_create_invalid(), level: 2 });
    const citation = input(m.relation_citation());
    const targetFor = (control: HTMLElement) =>
      [...article().querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].find(
        (link) => decodeURIComponent(link.hash.slice(1)) === control.id,
      );
    expect(targetFor(amount)).toBeDefined();
    expect(targetFor(precision)).toBeDefined();
    expect(targetFor(citation)).toBeDefined();
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(precision.getAttribute('aria-invalid')).toBe('true');
    expect(citation.getAttribute('aria-invalid')).toBe('true');
    expect(article().textContent).toContain(m.correction_citation_hint());
    expect(input(m.correction_amount()).value).toBe('+240');
    expect(precision.value).toBe('10');
    expect(article().textContent).toContain('Supplied publisher');
    await associations(0);

    await replace(amount, '+241');
    await act(async () => user.selectOptions(precision, '9'));
    await replace(citation, 'https://publisher.example/edition');
    await click(m.publication_submit());
    await scope().findByRole('link', { name: m.catalogue_create_open() });
    expect(correction.commands).toHaveLength(2);
    expect(correction.commands[1]!.key).not.toBe(correction.commands[0]!.key);
    expect(correction.commands[1]!.item.statements['schema:numberOfPages']![0]!.value).toEqual({
      type: 'value',
      content: { amount: '+241', unit: '1' },
    });
    expect(correction.commands[1]!.item.statements['schema:datePublished']![0]!.value).toMatchObject({
      type: 'value',
      content: { precision: 9 },
    });
    expect(correction.commands[1]!.item.statements['schema:publisher']![0]!.value).toEqual({
      type: 'value',
      content: publisherId,
    });
    expect(correction.commands[1]!.item.statements['schema:exampleOfWork']![0]!.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: 'https://publisher.example/edition',
    });

    for (const scenario of ['reader-unavailable', 'reader-concealed'] as const) {
      const result = tracked(scenario);
      await mount(result);
      await ready();
      await click(m.publication_submit());
      await scope().findByRole('heading', { name: m.catalogue_create_created() });
      expect(scope().queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
      expect(result.navigations).toEqual([]);
      expect(result.fixture.calls).toHaveLength(8);
      result.fixture.setScenario('ready');
      await click(m.catalogue_create_retry());
      expect((await scope().findByRole('link', { name: m.catalogue_create_open() })).getAttribute('href')).toBe(
        `/en/subjects/${publicationCreatedId}/a-distinct-edition`,
      );
      expect(result.commands).toHaveLength(1);
      expect(result.reads).toEqual([publicationCreatedId]);
      expect(result.fixture.calls).toHaveLength(9); // the explicit recovery adds only the ordinary reader GET
    }

    for (const scenario of ['denied', 'invalid', 'conflict'] as const) {
      const refusal = tracked(scenario);
      await mount(refusal);
      await ready();
      await add('schema:isbn');
      await replace(input(m.correction_value()), '978-0-140-44430-8');
      await click(m.publication_submit());
      await scope().findByRole('heading', {
        name:
          scenario === 'denied'
            ? m.catalogue_create_denied()
            : scenario === 'invalid'
              ? m.catalogue_create_invalid()
              : m.catalogue_create_conflict(),
      });
      expect(input(m.catalogue_create_label()).value).toBe('A distinct edition');
      expect(input(m.correction_value()).value).toBe('978-0-140-44430-8');
      expect(refusal.fixture.receipts.size).toBe(0);
      expect(refusal.navigations).toEqual([]);
      await associations(0);
      if (scenario === 'conflict') {
        expect((scope().getByRole('button', { name: m.publication_submit() }) as HTMLButtonElement).disabled).toBe(
          true,
        );
        expect(input(m.catalogue_create_label()).closest('fieldset[disabled]')).not.toBeNull();
        const old = refusal.commands[0]!;
        await click(m.catalogue_create_review_new());
        refusal.fixture.setScenario('ready');
        await click(m.publication_submit());
        await scope().findByRole('link', { name: m.catalogue_create_open() });
        expect(refusal.commands[1]!.key).not.toBe(old.key);
        expect(refusal.commands[1]!.item).toEqual(old.item);
      }
    }

    // A definite definitions refusal reconciles every staged choice before a deliberate new command.
    const recovery = tracked('ready', 'schema:Movie');
    const release = recovery.fixture.release;
    const originalSubmit = recovery.transport.submit;
    const originalLoad = recovery.transport.load;
    let refusals = 0;
    let failRefresh = false;
    const releasedProfile = structuredClone(release.types['rezics:AnimeRelease']!);
    const stagedRelationLabel = release.properties['bf:hasPart']!.labels.en!;
    recovery.transport = {
      ...recovery.transport,
      load: async () => (failRefresh ? { ok: false, reason: 'unavailable' } : originalLoad()),
      submit: async (command) => {
        if (refusals++ > 1) return originalSubmit(command);
        recovery.commands.push(structuredClone(command));
        if (refusals === 1) {
          release.types['rezics:AnimeRelease']!.properties = releasedProfile.properties.filter(
            (property) => !['bf:hasPart', 'schema:inLanguage'].includes(property),
          );
          delete release.properties['bf:hasPart'];
        } else {
          delete release.types['rezics:AnimeRelease'];
          delete release.properties['schema:url'];
          release.properties['schema:publisher']!.targets = ['schema:Person'];
        }
        return { ok: false, reason: 'invalid', refreshDefinitions: true };
      },
    };
    await mount(recovery);
    await ready();
    await replace(input(m.catalogue_create_language()), 'en-GB');
    await act(async () =>
      user.selectOptions(scope().getByRole('combobox', { name: m.relation_property() }), 'bf:hasPart'),
    );
    await add('schema:inLanguage');
    await replace(input(m.correction_value()), 'ja');
    await add('schema:publisher');
    await replace(scope().getByRole('combobox', { name: 'publisher' }), 'Supplied');
    const recoveryPublisher = await within(window.document.body as unknown as HTMLElement).findByRole('option', {
      name: /Supplied publisher/,
    });
    await act(async () => user.click(recoveryPublisher));
    await replace(input(m.relation_citation()), 'https://publisher.example/edition');
    await click(m.publication_submit());
    await scope().findByText(m.publication_definitions_review());
    const recoveryButton = () =>
      scope().getByRole('button', { name: m.catalogue_create_review_new() }) as HTMLButtonElement;
    expect(recoveryButton().disabled).toBe(true);
    expect(scope().getByRole('option', { name: stagedRelationLabel })).toBeDefined();
    expect((scope().getByRole('combobox', { name: m.relation_property() }) as HTMLSelectElement).value).toBe(
      'bf:hasPart',
    );
    expect(article().textContent).toContain('"ja"');
    expect(input(m.catalogue_create_language()).value).toBe('en-GB');
    expect(input(m.relation_citation()).value).toBe('https://publisher.example/edition');
    await click(m.publication_submit());
    expect(recovery.commands).toHaveLength(1);
    await act(async () =>
      user.selectOptions(scope().getByRole('combobox', { name: m.relation_property() }), 'schema:exampleOfWork'),
    );
    const removedFact = scope().getByRole('heading', { name: 'language', level: 3 }).closest('fieldset')!;
    await act(async () => user.click(within(removedFact).getByRole('button', { name: m.relation_remove() })));
    await act(async () => user.click(within(removedFact).getByRole('button', { name: m.relation_remove() })));
    expect(recoveryButton().disabled).toBe(false);
    await click(m.catalogue_create_review_new());
    await click(m.publication_submit());
    await scope().findByText(m.publication_empty());
    const corrected = recovery.commands[1]!;
    expect(corrected.key).not.toBe(recovery.commands[0]!.key);
    expect(corrected.item.labels).toEqual({ 'en-GB': 'A distinct edition' });
    expect(corrected.relation).toBe('schema:exampleOfWork');
    expect(corrected.item.statements['schema:publisher']).toEqual(
      recovery.commands[0]!.item.statements['schema:publisher'],
    );
    expect(corrected.item.statements['schema:inLanguage']).toBeUndefined();
    expect(input(m.catalogue_create_label()).value).toBe('A distinct edition');
    expect(article().textContent).toContain(publisherId);
    expect(input(m.relation_citation()).value).toBe('https://publisher.example/edition');
    // An unavailable reload cannot unlock creation, and a removed profile never hides the draft.
    failRefresh = true;
    await click(m.publication_refresh());
    await scope().findByRole('heading', { name: m.catalogue_create_unavailable() });
    release.types['rezics:AnimeRelease'] = structuredClone(releasedProfile);
    failRefresh = false;
    await click(m.catalogue_create_retry());
    await scope().findByText(m.publication_definitions_review());
    expect(recoveryButton().disabled).toBe(true);
    expect(article().textContent).toContain('Supplied publisher');
    const publisherFact = scope().getByRole('heading', { name: 'publisher', level: 3 }).closest('fieldset')!;
    await act(async () => user.click(within(publisherFact).getByRole('button', { name: m.relation_remove() })));
    await act(async () => user.click(within(publisherFact).getByRole('button', { name: m.relation_remove() })));
    await replace(input(m.relation_citation()), '');
    expect(recoveryButton().disabled).toBe(false);
    await click(m.catalogue_create_review_new());
    await click(m.publication_submit());
    await scope().findByRole('link', { name: m.catalogue_create_open() });
    expect(recovery.commands).toHaveLength(3);
    expect(recovery.commands[2]!.key).not.toBe(corrected.key);
    expect(Object.keys(recovery.commands[2]!.item.statements)).toEqual(['schema:exampleOfWork']);
    expect(searchCalls).toEqual(['Supplied']);
    searchCalls.length = 0;

    // Constructed supplied release/profile tests DOM injectivity independently of native vocabulary acceptance.
    const collision = tracked();
    const suppliedCollision = await collision.fixture.transport.load();
    if (!suppliedCollision.ok) throw new Error('Expected supplied profile');
    const escapedProperty = 'schema:custom/~edition';
    suppliedCollision.release.properties['schema-isbn'] = structuredClone(
      suppliedCollision.release.properties['schema:isbn']!,
    );
    suppliedCollision.release.properties['schema-isbn']!.labels.en = 'A distinct property with a similar spelling';
    suppliedCollision.release.properties[escapedProperty] = structuredClone(
      suppliedCollision.release.properties['schema:isbn']!,
    );
    suppliedCollision.release.properties[escapedProperty]!.labels.en = 'Escaped property';
    suppliedCollision.profiles[0]!.fields.push('schema-isbn');
    suppliedCollision.profiles[0]!.fields.push(escapedProperty);
    suppliedCollision.release.types['bf:Instance']!.properties.push('schema-isbn');
    suppliedCollision.release.types['bf:Instance']!.properties.push(escapedProperty);
    const errors: CreateFailure = {
      ok: false,
      reason: 'invalid',
      errors: [
        { pointer: '/statements/schema:isbn/0/value/content', code: 'invalid_format' },
        { pointer: '/statements/schema-isbn/0/value/content', code: 'invalid_format' },
        { pointer: '/statements/schema:exampleOfWork/0/references/0/parts/0/value/content', code: 'invalid_format' },
        { pointer: '/statements/schema:custom~1~0edition/0/value/content', code: 'invalid_format' },
        { pointer: '/relation', code: 'unsupported' },
        { pointer: '/independent', code: 'required' },
        { pointer: '/labels/en', code: 'invalid_format' },
      ],
    };
    collision.transport = { ...collision.transport, load: async () => suppliedCollision, submit: async () => errors };
    await mount(collision, tracked());
    await ready();
    await add('schema:isbn');
    await replace(input(m.correction_value()), '978-0-140-44430-8');
    await add('schema-isbn');
    await replace(scope().getAllByRole('textbox', { name: m.correction_value() })[1]!, '978-0-140-44430-8');
    await add(escapedProperty);
    const escapedInput = scope().getAllByRole('textbox', { name: m.correction_value() })[2] as HTMLInputElement;
    await replace(escapedInput, 'escaped value');
    await click(m.publication_submit());
    await scope().findByRole('heading', { name: m.catalogue_create_invalid() });
    const fragments = [...article().querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    expect(fragments).toHaveLength(6);
    expect(fragments.some((link) => link.textContent?.includes(m.relation_citation()))).toBe(false);
    expect(article().textContent).toContain(m.correction_error_uneditable());
    const targets = fragments.map((link) => decodeURIComponent(link.hash.slice(1)));
    expect(new Set(targets).size).toBe(6);
    expect(targets).toContain(escapedInput.id);
    expect(new Set(ids()).size).toBe(ids().length);
    await associations(0);
    await associations(1);
    const collisionIds = ids();
    await draw();
    expect(ids()).toEqual(collisionIds);
    await replace(input(m.catalogue_create_language()), 'bad/language');
    await click(m.publication_submit());
    await associations(0);
    expect(
      [...article().querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].some(
        (link) => decodeURIComponent(link.hash.slice(1)) === input(m.catalogue_create_language()).id,
      ),
    ).toBe(true);

    // Supplied film profiles keep their emitted relation order, including the anthology link.
    const film = tracked('ready', 'schema:Movie');
    await mount(film);
    await ready();
    const relation = scope().getByRole('combobox', { name: m.relation_property() }) as HTMLSelectElement;
    expect([...relation.options].map((option) => option.value)).toEqual(['schema:exampleOfWork', 'bf:hasPart']);
    await act(async () => user.selectOptions(relation, 'bf:hasPart'));
    await click(m.publication_submit());
    await scope().findByRole('link', { name: m.catalogue_create_open() });
    expect(film.commands[0]!.relation).toBe('bf:hasPart');
    expect(Object.keys(film.commands[0]!.item.statements)).toEqual(['bf:hasPart']);

    // Retiring the current reader clears drafts and prevents a late native result from opening a reader.
    const retired = tracked();
    let complete!: (result: Awaited<ReturnType<PublicationTransport['submit']>>) => void;
    const late = new Promise<Awaited<ReturnType<PublicationTransport['submit']>>>((resolve) => {
      complete = resolve;
    });
    retired.transport = { ...retired.transport, submit: async () => late };
    await mount(retired);
    await ready();
    await click(m.publication_submit());
    admitted = false;
    await draw();
    await act(async () =>
      complete({ ok: true, id: publicationCreatedId, reader: { state: 'ready', href: '/en/subjects/late-result' } }),
    );
    expect(host.querySelector('form')).toBeNull();
    expect(retired.navigations).toEqual([]);
    admitted = true;
    await draw();
    await scope().findByRole('textbox', { name: m.catalogue_create_label() });
    expect(input(m.catalogue_create_label()).value).toBe('');
    expect(scope().queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
    expect(searchCalls).toEqual([]); // adding/removing ordinary facts never hydrates identity or performs search

    for (const scenario of ['loading', 'empty', 'concealed', 'unavailable'] as const) {
      const state = tracked(scenario);
      await mount(state);
      if (scenario === 'loading') {
        expect(scope().getByRole('status').textContent).toContain(m.catalogue_create_loading());
      } else if (scenario === 'empty') {
        await scope().findByText(m.publication_empty());
        expect(article().textContent).toContain(m.publication_empty());
      } else {
        await scope().findByRole('alert');
        expect(article().textContent).toContain(
          scenario === 'concealed' ? m.catalogue_create_concealed() : m.catalogue_create_unavailable(),
        );
        if (scenario === 'unavailable') {
          await click(m.catalogue_create_retry());
          await scope().findByRole('textbox', { name: m.catalogue_create_label() });
          expect(state.loads()).toBe(2);
        }
      }
      expect(state.commands).toHaveLength(0);
      expect(state.navigations).toEqual([]);
    }
    for (const session of ['unknown', 'signed-out', 'unavailable'] as const) {
      const state: Entry = { ...tracked(), session };
      await mount(state);
      await scope().findByRole('textbox', { name: m.catalogue_create_label() });
      expect(input(m.catalogue_create_label()).closest('fieldset[disabled]')).not.toBeNull();
      expect((scope().getByRole('button', { name: m.publication_submit() }) as HTMLButtonElement).disabled).toBe(true);
      if (session === 'signed-out') {
        expect(scope().getByRole('link', { name: m.account_sign_in() }).getAttribute('href')).toBe(
          `/auth/sign-in?return_to=${encodeURIComponent(`/en/catalogue/publication?work=${state.fixture.work.subject.id}`)}`,
        );
      }
      expect(state.commands).toHaveLength(0);
      expect(state.fixture.calls).toHaveLength(3);
    }
    const invalidWork = tracked();
    invalidWork.transport = { ...invalidWork.transport, load: async () => ({ ok: false, reason: 'invalid' }) };
    await mount(invalidWork);
    await scope().findByRole('alert');
    expect(scope().getByRole('link', { name: m.catalogue_create_search() }).getAttribute('href')).toBe('/en/search');
    expect(article().querySelector('form')).toBeNull();
    expect(invalidWork.fixture.calls).toEqual([]);

    // The unchanged publisher picker filters the supplied results and preserves removal semantics locally.
    const publisher = tracked();
    await mount(publisher);
    await ready();
    await add('schema:publisher');
    const publisherName = publisher.fixture.release.properties['schema:publisher']!.labels.en!;
    const picker = scope().getByRole('combobox', { name: publisherName });
    await act(async () => user.type(picker, 'Press'));
    const optionsInDocument = within(window.document.body as unknown as HTMLElement);
    const choice = await optionsInDocument.findByRole('option', { name: /Supplied publisher/ });
    expect(optionsInDocument.queryByRole('option', { name: /Wrong target/ })).toBeNull();
    expect(searchCalls.at(-1)).toBe('Press');
    expect(publisher.fixture.calls).toHaveLength(3);
    await act(async () => user.click(choice));
    await click(m.relation_remove());
    await click(m.relation_remove());
    await add('schema:publisher');
    const freshPicker = scope().getByRole('combobox', { name: publisherName }) as HTMLInputElement;
    expect(freshPicker.value).toBe('');
    await act(async () => user.type(freshPicker, 'Press'));
    const freshChoice = await optionsInDocument.findByRole('option', { name: /Supplied publisher/ });
    await act(async () => user.click(freshChoice));
    await click(m.publication_submit());
    await scope().findByRole('link', { name: m.catalogue_create_open() });
    expect(publisher.commands[0]!.item.statements['schema:publisher']![0]!.value).toEqual({
      type: 'value',
      content: publisherId,
    });
    expect(publisher.fixture.calls).toHaveLength(8);

    const fallback = tracked();
    fallback.fixture.work.subject.labels = {};
    await mount(fallback);
    await scope().findByRole('textbox', { name: m.catalogue_create_label() });
    expect(scope().getByRole('heading', { name: m.subject_value_unlabelled(), level: 2 })).toBeDefined();
    expect(scope().getByRole('link', { name: m.subject_value_unlabelled() }).getAttribute('href')).toBe(
      subjectHref({ id: fallback.fixture.work.subject.id, label: '' }, 'en').href,
    );

    const body = within(window.document.body as unknown as HTMLElement);
    await act(async () => router.history.push('/?page=other'));
    expect(router.state.location.search).toEqual({ page: 'other' });
    await act(async () => router.history.push('/'));

    const departure = tracked();
    await mount(departure);
    await ready();
    await add('schema:isbn');
    await replace(input(m.correction_value()), '978-0-140-44430-8');
    await add('schema:publisher');
    const publisherName = departure.fixture.release.properties['schema:publisher']!.labels.en!;
    await act(async () => user.type(scope().getByRole('combobox', { name: publisherName }), 'Press'));
    await act(async () => user.click(await body.findByRole('option', { name: /Supplied publisher/ })));
    await replace(input(m.relation_citation()), 'https://publisher.example/edition');
    const snapshot = () =>
      [...article().querySelectorAll('input, select')].map((element) => {
        const control = element as HTMLInputElement;
        return [control.id, control.value, control.checked];
      });
    const originalDraft = snapshot();
    const duplicateSearch = scope().getByRole('link', { name: m.publication_search() });
    expect(duplicateSearch.getAttribute('target')).toBe('_blank');
    const dirtyExit = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyExit);
    expect(dirtyExit.defaultPrevented).toBe(true);

    await act(async () => {
      void router.history.push('/?page=other');
    });
    const leaveDialog = await body.findByRole('alertdialog');
    expect(leaveDialog.textContent).toContain(m.thread_authoring_leave_unsaved());
    await act(async () => user.click(body.getByRole('button', { name: m.thread_authoring_stay() })));
    expect(router.state.location.search).toEqual({});
    expect(snapshot()).toEqual(originalDraft);

    await act(async () => {
      void router.history.push('/?page=other');
    });
    await body.findByRole('alertdialog');
    await act(async () => user.click(body.getByRole('button', { name: m.thread_authoring_leave() })));
    expect(router.state.location.search).toEqual({ page: 'other' });
    expect(host.querySelector('article')).toBeNull();
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
}, 30_000);
