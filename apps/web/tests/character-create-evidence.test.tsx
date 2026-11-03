import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { CharacterCommand, CharacterTransport } from '../src/features/catalogue/character-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

test('Character create reviews complete evidence, reuses citations, and associates independently', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/character' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { characterProfileFixture, characterCreatedId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  const fixture = characterProfileFixture();
  const release = structuredClone(fixture.release);
  release.properties['schema:height']!.qualifiers = ['schema:inLanguage'];
  const commands: CharacterCommand[] = [];
  let createMode: 'ok' | 'unknown' | 'invalid' = 'ok';
  let reads = 0;
  const transport: CharacterTransport = {
    ...fixture.transport,
    load: async (address) => {
      const read = await fixture.transport.load(address);
      if (!read.ok) return read;
      return { ...read, release };
    },
    create: async (command) => {
      commands.push(structuredClone(command));
      if (createMode === 'unknown') return { ok: false, reason: 'unavailable' };
      if (createMode === 'invalid')
        return {
          ok: false,
          reason: 'invalid',
          errors: [{ pointer: '/statements/schema:height/0/value/content/amount', code: 'out_of_range' }],
        };
      return { ok: true, id: characterCreatedId, reader: { state: 'unavailable' } };
    },
    read: async (id) => {
      reads++;
      if (reads === 1) return { state: 'unavailable' };
      return { state: 'ready', href: `/en/subjects/${id}/traveler` };
    },
  };
  const click = (name: string) => act(async () => user.click(canvas.getByRole('button', { name })));
  const replace = (element: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(element);
      if (value) await user.type(element, value);
    });
  const valueUrl = (row: Element) =>
    within(row.querySelector('[id$="-fact"]') as HTMLElement).getByRole('textbox', {
      name: m.correction_url(),
    }) as HTMLInputElement;
  const submit = async () => {
    if (canvas.queryByRole('button', { name: m.correction_retry() })) return click(m.correction_retry());
    if (canvas.queryByRole('button', { name: m.character_create() })) return click(m.character_create());
    await click(m.character_create_review());
    if (canvas.queryByRole('button', { name: m.character_create() })) await click(m.character_create());
  };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address="character-evidence"
            observed={{ state: 'signed-in', subject: 'fixture-reader', csrfToken: 'original-epoch' }}
          >
            <CharacterProfile
              {...fixture.props}
              work={fixture.work.publicRead.subject.id}
              locale="en"
              session="signed-in"
              transport={transport}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await replace(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Traveler');
    await click(m.catalogue_create_add_language());
    await replace(canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!, 'ja');
    await replace(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '旅人');
    await replace(canvas.getAllByRole('textbox', { name: m.catalogue_create_aliases() })[1]!, '旅の人');
    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:height');
      await user.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    });
    const height = host.querySelector('[data-slot="character-initial-fact"]') as HTMLElement;
    await replace(within(height).getByRole('textbox', { name: m.correction_amount() }), '+170');
    await act(async () =>
      user.selectOptions(
        within(height).getByRole('combobox', { name: m.correction_unit() }),
        'http://www.wikidata.org/entity/Q174728',
      ),
    );
    await act(async () =>
      user.selectOptions(within(height).getByRole('combobox', { name: m.candidate_rank() }), 'preferred'),
    );
    await act(async () =>
      user.selectOptions(
        within(height).getByRole('combobox', { name: m.correction_add_qualifier() }),
        'schema:inLanguage',
      ),
    );
    await act(async () =>
      user.click(within(height.querySelector('[id$="-qualifiers"]') as HTMLElement).getByRole('button', { name: m.correction_add() })),
    );
    await replace(within(height).getByRole('textbox', { name: m.correction_value() }), 'ja');
    await replace(
      within(height.querySelector('[id$="-references"]') as HTMLElement).getByRole('textbox', {
        name: m.correction_url(),
      }),
      'https://example.org/height',
    );
    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url');
      await user.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    });
    const urlRow = host.querySelectorAll('[data-slot="character-initial-fact"]')[1] as HTMLElement;
    await replace(valueUrl(urlRow), 'https://example.org/character');
    await act(async () =>
      user.click(
        within(height).getByRole('button', {
          name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
        }),
      ),
    );
    await act(async () => user.click(canvas.getAllByRole('checkbox')[0]!));
    await click(m.facts_reuse_apply());
    createMode = 'invalid';
    await click(m.character_create_review());
    expect(canvas.getByRole('region', { name: m.character_create_review_title() }).textContent).toContain('旅人');
    expect(canvas.getByRole('region', { name: m.character_create_review_title() }).textContent).toContain(
      'https://example.org/height',
    );
    await click(m.character_create());
    const amount = within(height).getByRole('textbox', { name: m.correction_amount() });
    const repair = canvas
      .getByRole('region', { name: m.character_create_correction_summary() })
      .querySelector('a') as HTMLAnchorElement;
    await act(async () => user.click(repair));
    expect(window.document.activeElement).toBe(amount);
    await replace(amount, '+171');
    createMode = 'unknown';
    await submit();
    expect(commands).toHaveLength(2);
    const unknown = structuredClone(commands[1]);
    await click(m.correction_retry());
    expect(commands[2]).toEqual(unknown);
    createMode = 'ok';
    await click(m.correction_retry());
    await waitFor(() => expect(host.querySelector('[data-slot="character-created"]')).toBeTruthy());
    expect(commands.filter((command) => command.key === unknown!.key)).toHaveLength(3);
    expect(commands.at(-1)!.item).toMatchObject({
      type: 'wd:Q95074',
      labels: { en: 'Traveler', ja: '旅人' },
      aliases: { ja: ['旅の人'] },
      statements: {
        'schema:height': [
          {
            rank: 'preferred',
            value: { type: 'value', content: { amount: '+171', unit: 'http://www.wikidata.org/entity/Q174728' } },
            qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }],
            references: [
              {
                parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/height' } }],
              },
            ],
          },
        ],
        'schema:url': [
          {
            value: { type: 'value', content: 'https://example.org/character' },
            references: [
              {
                parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/height' } }],
              },
            ],
          },
        ],
      },
    });
    expect(host.querySelector('[data-slot="character-created"]')!.textContent).toContain(characterCreatedId);
    expect(host.textContent).toContain(m.catalogue_create_reader_unavailable());
    await click(m.correction_retry());
    expect(reads).toBe(2);
    expect(commands.at(-1)!.key).toBe(unknown!.key);
    expect(host.querySelector('[data-slot="character-associate"]')).toBeTruthy();
    const stale = characterProfileFixture();
    let sealed = 0;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address="character-evidence-stale"
            observed={{ state: 'signed-in', subject: 'fixture-reader', csrfToken: 'original-epoch' }}
          >
            <CharacterProfile
              {...stale.props}
              locale="en"
              session="signed-in"
              transport={{
                ...stale.transport,
                create: async (command) => {
                  sealed++;
                  return stale.transport.create(command);
                },
              }}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await replace(await canvas.findByRole('textbox', { name: m.catalogue_create_label() }), 'Holder');
    await click(m.character_create_review());
    await replace(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Changed holder');
    expect(host.textContent).toContain(m.character_create_review_stale());
    await click(m.character_create_review());
    await click(m.character_create());
    expect(sealed).toBe(1);
    expect(stale.calls.find((call) => call.method === 'POST' && call.path === '/v1/subjects')?.body).toMatchObject({
      labels: { en: 'Changed holder' },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    await window.happyDOM.close();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
