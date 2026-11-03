import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Release } from '@rezics/definitions';
import type { ScreenCommand } from '../src/features/catalogue/screen-profile';
import recorded from '../src/kernel/recorded/definitions-release.json';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('standalone Screen creation reviews evidence, copies references, and retries unknown delivery without a second subject', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/screen' });
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
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { ScreenProfile } = await import('../src/features/catalogue/screen-profile-view');
  const { screenName } = await import('../src/features/catalogue/screen-profile');
  const { screenProfileFixture } = await import('../src/kernel/fake/catalogue-screen-profile');
  const { catalogueCreatedId } = await import('../src/kernel/fake/catalogue-create');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document, delay: null });
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const canvas = () => within(host);
  const name = (property: string) => screenName(recorded.release as Release, property, 'en').text;
  const row = (property: string) =>
    canvas().getAllByRole('heading', { name: name(property), level: 3 }).at(-1)!.closest('section')! as HTMLElement;
  async function render(node: ReactNode, subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10') {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject, csrfToken: 'token' }}
            address={`screen-create-review:${subject}`}
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  }
  async function choose(type: string) {
    await waitFor(() => expect(canvas().getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined());
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), type),
    );
  }
  async function add(property: string) {
    const select = canvas().getByRole('combobox', { name: m.character_add_fact() });
    await act(async () => user.selectOptions(select, property));
    const addButton = [...select.closest('fieldset')!.querySelectorAll('button')].find(
      (button) => button.textContent === m.correction_add() && !button.closest('section'),
    )!;
    await act(async () => user.click(addButton));
    return row(property);
  }
  function citation(scope: HTMLElement) {
    return within(within(scope).getByRole('group', { name: `${m.correction_references()} 1` })).getByRole('textbox', {
      name: m.correction_url(),
    }) as HTMLInputElement;
  }
  async function fillUrl(scope: HTMLElement, value: string, source: string) {
    const input = within(scope).getAllByRole('textbox', { name: m.correction_url() })[0]!;
    await act(async () => {
      await user.clear(input);
      await user.type(input, value);
      await user.type(citation(scope), source);
    });
  }
  async function confirm() {
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-screen-create-review]')).not.toBeNull();
    expect(host.textContent).toContain(m.screen_profile_review_membership());
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
  }
  try {
    const fixture = screenProfileFixture();
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        transport={fixture.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:Movie');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed film'));
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_aliases() }), 'Picture'),
    );
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_add_language() })));
    await act(async () => user.type(host.querySelector<HTMLInputElement>('#create-language-1')!, 'ja'));
    await act(async () => user.type(host.querySelector<HTMLInputElement>('#create-label-1')!, '映画'));
    const urlRow = await add('schema:url');
    const languageRow = await add('schema:inLanguage');
    await fillUrl(urlRow, 'https://example.org/film', 'https://example.org/film-source');
    await act(async () => user.type(within(languageRow).getByRole('textbox', { name: m.correction_value() }), 'ja'));
    await act(async () =>
      user.click(
        within(urlRow).getByRole('button', {
          name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
        }),
      ),
    );
    const panel = host.querySelector('[data-fact-reuse]')!;
    expect(panel.textContent).toContain('https://example.org/film-source');
    await act(async () => user.click(within(panel).getByRole('checkbox', { name: name('schema:inLanguage') })));
    await act(async () => user.click(within(panel).getByRole('button', { name: m.facts_reuse_apply() })));
    expect(within(languageRow).getAllByRole('group', { name: /Citations/ })).toHaveLength(2);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(fixture.creation.calls.some((call) => call.method === 'POST')).toBe(false);
    const reviewed = host.querySelector('[data-screen-create-review]')!;
    expect(reviewed.textContent).toContain('schema:Movie');
    expect(reviewed.textContent).toContain('Reviewed film');
    expect(reviewed.textContent).toContain('映画');
    expect(reviewed.textContent).toContain('Picture');
    expect(reviewed.textContent).toContain('https://example.org/film-source');
    expect(reviewed.textContent).toContain(m.candidate_rank_normal());
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    const movie = fixture.creation.calls.find((call) => call.method === 'POST')!.body as ScreenCommand['item'];
    expect(movie.type).toBe('schema:Movie');
    expect(movie.statements['schema:inLanguage']![0]!.references).toHaveLength(2);
    expect(movie.statements['schema:url']![0]!.rank).toBe('normal');
    expect(movie.statements['schema:inLanguage']![0]!.references[1]).toEqual(
      movie.statements['schema:url']![0]!.references[0],
    );

    const switched = screenProfileFixture();
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        transport={switched.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:Movie');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Kept film'));
    await fillUrl(await add('schema:url'), 'https://example.org/movie-draft', 'https://example.org/movie-cite');
    await choose('schema:Episode');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Kept episode'));
    await fillUrl(await add('schema:url'), 'https://example.org/episode-draft', 'https://example.org/episode-cite');
    await confirm();
    await waitFor(() => expect(switched.creation.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const episode = switched.creation.calls.find((call) => call.method === 'POST')!.body as ScreenCommand['item'];
    expect(episode.type).toBe('schema:Episode');
    expect(JSON.stringify(episode)).toContain('https://example.org/episode-draft');
    expect(JSON.stringify(episode)).not.toContain('https://example.org/movie-draft');

    const repaired = screenProfileFixture();
    const commands: ScreenCommand[] = [];
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        search={async () => []}
        onNavigate={() => {}}
        transport={{
          ...repaired.transport,
          create: async (command) => {
            commands.push(structuredClone(command));
            if (commands.length === 1)
              return {
                ok: false as const,
                reason: 'invalid' as const,
                errors: [
                  { pointer: '/statements/schema:url/0/references/0/parts/0/value/content', code: 'invalid_format' },
                ],
              };
            return repaired.transport.create(command);
          },
        }}
      />,
    );
    await choose('schema:Movie');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Repair nested'));
    const repairUrl = await add('schema:url');
    const repairLanguage = await add('schema:inLanguage');
    await fillUrl(repairUrl, 'https://example.org/url', 'https://example.org/bad');
    await act(async () => user.type(within(repairLanguage).getByRole('textbox', { name: m.correction_value() }), 'en'));
    const languageCitation = citation(repairLanguage).id;
    await confirm();
    const link = await waitFor(() =>
      canvas().getByRole('link', { name: new RegExp(name('schema:url')) }),
    );
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).toBe(citation(repairUrl).id);
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).not.toBe(languageCitation);
    await act(async () => user.click(within(repairUrl).getByRole('button', { name: m.relation_remove() })));
    await act(async () => user.click(within(repairUrl).getByRole('button', { name: m.relation_remove() })));
    expect(host.querySelector(`#${CSS.escape(repairUrl.id)}`)).toBeNull();
    expect(citation(repairLanguage).id).toBe(languageCitation);
    await confirm();
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]!.item.statements).not.toHaveProperty('schema:url');
    expect(commands[1]!.key).not.toBe(commands[0]!.key);

    const staleReuse = screenProfileFixture();
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        transport={staleReuse.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:Movie');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Stale copy'));
    const source = await add('schema:url');
    const destination = await add('schema:inLanguage');
    await fillUrl(source, 'https://example.org/source', 'https://example.org/cite-one');
    await act(async () => user.type(within(destination).getByRole('textbox', { name: m.correction_value() }), 'en'));
    await act(async () =>
      user.click(
        within(source).getByRole('button', {
          name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
        }),
      ),
    );
    await act(async () =>
      user.click(within(host.querySelector('[data-fact-reuse]')!).getByRole('checkbox', { name: name('schema:inLanguage') })),
    );
    await act(async () => {
      await user.clear(citation(source));
      await user.type(citation(source), 'https://example.org/cite-two');
    });
    expect(host.querySelector('[data-fact-reuse]')!.textContent).toContain(m.facts_reuse_stale());
    await act(async () =>
      user.click(within(host.querySelector('[data-fact-reuse]')!).getByRole('button', { name: m.candidate_cancel() })),
    );
    expect(within(destination).getAllByRole('group', { name: /Citations/ })).toHaveLength(1);
    expect(host.querySelector('[data-fact-reuse]')).toBeNull();

    const lost = screenProfileFixture('uncertain');
    await render(
      <ScreenProfile locale="en" session="signed-in" transport={lost.transport} search={async () => []} onNavigate={() => {}} />,
    );
    await choose('schema:Movie');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Uncertain film'));
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
    const first = lost.creation.calls.filter((call) => call.method === 'POST');
    expect(first).toHaveLength(1);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    const posts = lost.creation.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(posts[1]?.body).toEqual(posts[0]?.body);

    const unread = screenProfileFixture('reader-unavailable');
    let reads = 0;
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        search={async () => []}
        onNavigate={() => {}}
        transport={{
          ...unread.transport,
          read: async (id) => {
            reads++;
            return unread.transport.read(id);
          },
        }}
      />,
    );
    await choose('schema:Movie');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Unread film'));
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_reader_unavailable()));
    expect(unread.creation.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    unread.creation.setScenario('ready');
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(unread.creation.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(unread.creation.calls.filter((call) => call.method === 'GET').map((call) => call.path)).toEqual([
      `/v1/subjects/${catalogueCreatedId}`,
      `/v1/subjects/${catalogueCreatedId}`,
    ]);
    expect(reads).toBe(1);
    expect(canvas().getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toContain(
      catalogueCreatedId,
    );

    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        transport={unread.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
      'replacement-reader',
    );
    expect(host.textContent).not.toContain(m.catalogue_create_created());

    const fromSeries = screenProfileFixture();
    const parent = '00000000-0000-4000-8000-000000000301';
    await render(
      <ScreenProfile
        locale="en"
        session="signed-in"
        search={async () => []}
        onNavigate={() => {}}
        transport={{
          ...fromSeries.transport,
          load: async () => {
            const result = await fromSeries.transport.load();
            if (!result.ok) return result;
            const series = structuredClone(fromSeries.facts.date.publicRead);
            series.subject.id = parent;
            series.subject.type = 'schema:TVSeries';
            series.subject.labels = { en: 'Parent series' };
            return { ...result, seriesId: parent, series };
          },
        }}
      />,
    );
    await waitFor(() => expect(canvas().getByRole('textbox', { name: m.catalogue_create_label() })).toBeDefined());
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Series episode'));
    expect(canvas().queryByRole('combobox', { name: m.catalogue_create_type() })).toBeNull();
    expect(host.querySelector('#create-type')?.textContent).toMatch(/episode/i);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-screen-create-review]')).toBeNull();
    await waitFor(() => expect(fromSeries.creation.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    expect((fromSeries.creation.calls.find((call) => call.method === 'POST')!.body as ScreenCommand['item']).type).toBe(
      'schema:Episode',
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 45_000);
