import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';

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
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(canvas.getAllByRole('heading', { name: m.story_arc_create() })).toHaveLength(1);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(canvas.getByText(m.story_arc_creation_help())).toBeDefined();
    expect(canvas.getByRole('combobox', { name: m.story_arc_choose_existing() })).toBeDefined();
    expect(canvas.queryByRole('combobox', { name: m.catalogue_create_type() })).toBeNull();
    expect(host.querySelector('select#create-type')).toBeNull();
    expect(canvas.queryByText(m.catalogue_create_grain())).toBeNull();
    const arcName = canvas.getByRole('textbox', { name: m.catalogue_create_label() });
    const form = within(arcName.closest('form')!);
    expect(form.getByText(storyArcType)).toBeDefined();
    expect(form.getByText(arc.release.types[storyArcType]!.labels.en!)).toBeDefined();
    expect(form.getByText(arc.release.types[storyArcType]!.descriptions.en!)).toBeDefined();
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
