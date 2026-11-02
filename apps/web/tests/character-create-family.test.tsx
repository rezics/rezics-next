import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { CharacterCommand, CharacterTransport } from '../src/features/catalogue/character-profile';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// Production consumer with supplied generated-client responses. This does not establish browser geometry,
// native authorization, SSR or current-reading acceptance; those keep their existing independent witnesses.
test('Character creation keeps multilingual identity, initial facts, correction and exact recovery in one family', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/character' });
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
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const { CharacterProfile } = await import('../src/features/catalogue/character-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { characterProfileFixture, characterCreatedId } =
    await import('../src/kernel/fake/catalogue-character-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  let generation = 0;
  type Fixture = ReturnType<typeof characterProfileFixture>;
  const render = async (
    fixture: Fixture,
    transport = fixture.transport,
    signedIn = true,
    pair = false,
    fresh = true,
  ) => {
    if (fresh) generation++;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address={`character-family-${generation}`}
            observed={
              signedIn
                ? { state: 'signed-in', subject: 'character-family-reader', csrfToken: 'original-epoch' }
                : { state: 'signed-out', csrfToken: null }
            }
          >
            <CharacterProfile
              {...fixture.props}
              locale="en"
              session={signedIn ? 'signed-in' : 'signed-out'}
              transport={transport}
            />
            {pair && <CharacterProfile {...fixture.props} locale="en" transport={transport} />}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const canvas = () => within(host);
  const control = (name: string) => canvas().getByRole('textbox', { name }) as HTMLInputElement;
  const click = (name: string) => act(async () => user.click(canvas().getByRole('button', { name })));
  const replace = (element: HTMLElement, text: string) =>
    act(async () => {
      await user.clear(element);
      if (text) await user.type(element, text);
    });
  const name = async (text = 'A new traveler') => {
    const field = await canvas().findByRole('textbox', { name: m.catalogue_create_label() });
    await replace(field, text);
  };
  const add = async (property: string) =>
    act(async () => {
      await user.selectOptions(canvas().getByRole('combobox', { name: m.character_initial_fact() }), property);
      await user.click(canvas().getByRole('button', { name: m.character_add_fact() }));
    });
  const submit = () => click(m.character_create());
  const writes = (fixture: Fixture) =>
    fixture.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects');
  const capture = (input: HTMLInputElement) => {
    const key = Object.keys(input).find((key) => key.startsWith('__reactProps$'))!;
    const change = Reflect.get(input, key).onChange;
    return (value: string) => act(async () => change({ target: { value } }));
  };
  try {
    // Deliver actual mounted scalar callbacks after the private list has changed.
    const incarnation = characterProfileFixture();
    let incarnationLoads = 0;
    await render(incarnation, {
      ...incarnation.transport,
      load: async (address) =>
        ++incarnationLoads === 2 ? { ok: false, reason: 'unavailable' } : incarnation.transport.load(address),
    });
    await name('Incarnation draft');
    await add('schema:url');
    await replace(control(m.correction_url()), 'https://example.org/first');
    await add('schema:url');
    const survivor = canvas().getAllByRole('textbox', { name: m.correction_url() })[1] as HTMLInputElement;
    const survivorId = survivor.id;
    const editSurvivor = capture(survivor);
    await add('schema:url');
    const removedInput = canvas().getAllByRole('textbox', { name: m.correction_url() })[2] as HTMLInputElement;
    const editRemoved = capture(removedInput);
    const remove = async (input: HTMLInputElement) => {
      const row = within(input.closest('[data-slot="character-initial-fact"]')! as HTMLElement);
      await act(async () => user.click(row.getByRole('button', { name: m.recipe_remove_field() })));
      await act(async () => user.click(row.getByRole('button', { name: m.recipe_remove_field() })));
    };
    await remove(control(m.correction_url()));
    await editSurvivor('https://example.org/survivor');
    expect(canvas().getAllByRole('textbox', { name: m.correction_url() })).toHaveLength(2);
    expect(control(m.correction_url()).id).toBe(survivorId);
    expect(control(m.correction_url()).value).toBe('https://example.org/survivor');
    await editSurvivor('https://example.org/replaced-incarnation');
    expect(control(m.correction_url()).value).toBe('https://example.org/survivor');
    await remove(removedInput);
    await add('schema:url');
    await editRemoved('https://example.org/removed-incarnation');
    expect(
      canvas()
        .getAllByRole('textbox', { name: m.correction_url() })
        .map((row) => (row as HTMLInputElement).value),
    ).toEqual(['https://example.org/survivor', '']);
    const beforeUnavailable = capture(control(m.correction_url()));
    await click(m.correction_reload());
    await beforeUnavailable('https://example.org/unavailable-reading');
    expect(survivor.value).toBe('https://example.org/survivor');
    await click(m.correction_reload());
    await beforeUnavailable('https://example.org/retired-reading');
    expect(control(m.correction_url()).value).toBe('https://example.org/survivor');

    const ready = characterProfileFixture();
    await render(ready);
    await name();
    const search = canvas().getByRole('link', { name: m.catalogue_create_search() });
    expect(search.getAttribute('href')).toBe('/en/search?q=A%20new%20traveler');
    expect(host.querySelector('form')!.getAttribute('aria-label')).toBe(m.character_create_correction_form());
    expect(control(m.catalogue_create_language()).getAttribute('aria-describedby')).toContain('language-help');
    await click(m.catalogue_create_add_language());
    const languages = canvas().getAllByRole('textbox', { name: m.catalogue_create_language() });
    expect(window.document.activeElement).toBe(languages[1]);
    await replace(languages[1]!, 'ja');
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '旅人');
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_aliases() })[1]!, '旅の人\n旅行者');
    expect(canvas().getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!.getAttribute('lang')).toBe('ja');
    await click(m.catalogue_create_add_language());
    await act(async () =>
      user.click(canvas().getAllByRole('button', { name: m.catalogue_create_remove_language() })[0]!),
    );
    expect(canvas().getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(3);
    await click(m.candidate_cancel());
    expect(canvas().getAllByRole('textbox', { name: m.catalogue_create_label() })[1]).toHaveProperty('value', '旅人');
    await act(async () =>
      user.click(canvas().getAllByRole('button', { name: m.catalogue_create_remove_language() })[0]!),
    );
    await act(async () =>
      user.click(canvas().getAllByRole('button', { name: m.catalogue_create_remove_language() })[0]!),
    );
    // Removing the middle row preserves its successor and moves focus within the same terms editor.
    expect(canvas().getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(2);
    expect(window.document.activeElement).toBe(
      canvas().getAllByRole('textbox', { name: m.catalogue_create_language() })[1],
    );
    await click(m.catalogue_create_remove_language());
    await click(m.catalogue_create_add_language());
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!, 'ja');
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_label() })[1]!, '旅人');
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_aliases() })[1]!, '旅の人\n旅行者');
    await add('schema:url');
    expect(window.document.activeElement).toBe(host.querySelector('[data-slot="character-initial-fact"] > div'));
    await replace(control(m.correction_url()), 'https://example.org/traveler');
    await add('schema:height');
    await replace(control(m.correction_amount()), '+170');
    await act(async () =>
      user.selectOptions(
        canvas().getByRole('combobox', { name: m.correction_unit() }),
        'http://www.wikidata.org/entity/Q174728',
      ),
    );
    const facts = host.querySelectorAll('[data-slot="character-initial-fact"]');
    const heightId = control(m.correction_amount()).id;
    await act(async () =>
      user.click(within(facts[0] as HTMLElement).getByRole('button', { name: m.recipe_remove_field() })),
    );
    await act(async () =>
      user.click(within(facts[0] as HTMLElement).getByRole('button', { name: m.recipe_remove_field() })),
    );
    expect(control(m.correction_amount()).id).toBe(heightId);
    expect(window.document.activeElement).toBe(host.querySelector('[data-slot="character-initial-fact"] > div'));
    await submit();
    await waitFor(() => expect(canvas().getByRole('link', { name: m.candidate_view_public() })).toBeDefined());
    expect(writes(ready)).toHaveLength(1);
    expect(writes(ready)[0]!.body).toMatchObject({
      type: 'wd:Q95074',
      labels: { en: 'A new traveler', ja: '旅人' },
      aliases: { ja: ['旅の人', '旅行者'] },
      statements: {
        'schema:height': [
          { value: { type: 'value', content: { amount: '+170', unit: 'http://www.wikidata.org/entity/Q174728' } } },
        ],
      },
    });
    expect((writes(ready)[0]!.body as { statements: object }).statements).not.toHaveProperty('schema:url');
    const reader = canvas().getByRole('link', { name: m.candidate_view_public() });
    expect(reader.getAttribute('href')).toBe(`/en/subjects/${characterCreatedId}/a-new-traveler`);
    expect(canvas().getByRole('link', { name: m.character_correct() }).getAttribute('href')).toBe(
      `${reader.getAttribute('href')}/character`,
    );
    expect(host.querySelector('[data-slot="character-created"]')!.textContent).toContain(m.character_created());
    const readback = host.querySelector('[data-slot="character-created"]')!;
    expect(readback.querySelector('details')!.open).toBe(false);
    expect(readback.querySelector('code')!.textContent).toBe(characterCreatedId);
    expect(host.querySelector('form')).toBeNull();

    const invalid = characterProfileFixture();
    await render(invalid);
    await name('Correction draft');
    await add('schema:height');
    await replace(control(m.correction_amount()), '+');
    await submit();
    const amount = control(m.correction_amount());
    const correction = canvas()
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === `#${encodeURIComponent(amount.id)}`)!;
    await act(async () => user.click(correction));
    expect(window.document.activeElement).toBe(amount);
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(writes(invalid)).toHaveLength(0);
    expect(control(m.catalogue_create_label()).value).toBe('Correction draft');

    // Removing an earlier same-property fact cannot retarget the surviving correction.
    await add('schema:height');
    const secondAmount = canvas().getAllByRole('textbox', { name: m.correction_amount() })[1] as HTMLInputElement;
    await replace(secondAmount, '+');
    await submit();
    const firstFact = within(host.querySelector('[data-slot="character-initial-fact"]') as HTMLElement);
    await act(async () => user.click(firstFact.getByRole('button', { name: m.recipe_remove_field() })));
    await click(m.candidate_cancel());
    expect(canvas().getAllByRole('textbox', { name: m.correction_amount() })).toHaveLength(2);
    await act(async () => user.click(firstFact.getByRole('button', { name: m.recipe_remove_field() })));
    await act(async () => user.click(firstFact.getByRole('button', { name: m.recipe_remove_field() })));
    const survivingCorrection = canvas()
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === `#${encodeURIComponent(secondAmount.id)}`)!;
    await act(async () => user.click(survivingCorrection));
    expect(window.document.activeElement).toBe(secondAmount);
    expect(secondAmount.value).toBe('+');
    await click(m.catalogue_create_add_language());
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_language() })[1]!, 'fr');
    await submit();
    await click(m.catalogue_create_remove_language());
    await click(m.catalogue_create_remove_language());
    expect(secondAmount.getAttribute('aria-invalid')).toBe('true');
    expect(
      canvas()
        .getAllByRole('link')
        .some((link) => link.getAttribute('href') === survivingCorrection.getAttribute('href')),
    ).toBe(true);

    // A real production refresh keeps the draft and safely retires controls removed from the release.
    const refresh = characterProfileFixture();
    const supplied = await refresh.transport.load({});
    if (!supplied.ok) throw new Error('Expected supplied release');
    const removed = structuredClone(supplied);
    delete removed.release.properties['schema:url'];
    let loads = 0;
    const rejected: CharacterCommand[] = [];
    const refreshTransport: CharacterTransport = {
      ...refresh.transport,
      load: async () => {
        loads++;
        if (loads === 2) throw new Error('Metadata refresh unavailable');
        return loads === 1 ? supplied : removed;
      },
      create: async (command) => {
        rejected.push(structuredClone(command));
        return {
          ok: false,
          reason: 'invalid',
          refreshDefinitions: true,
          errors: [{ pointer: '/statements/schema:url/0/value', code: 'unsupported' }],
        };
      },
    };
    await render(refresh, refreshTransport);
    await name('Retained metadata draft');
    await add('schema:url');
    await replace(control(m.correction_url()), 'https://example.org/retained');
    const retiredMetadataEdit = capture(control(m.correction_url()));
    await submit();
    await waitFor(() => expect(loads).toBe(2));
    expect(control(m.catalogue_create_label()).value).toBe('Retained metadata draft');
    expect(control(m.correction_url()).value).toBe('https://example.org/retained');
    expect(host.textContent).not.toContain(m.catalogue_create_uncertain());
    const recovery = within(host.querySelector('[data-slot="character-create-recovery"]') as HTMLElement);
    await act(async () => user.click(recovery.getByRole('button', { name: m.correction_reload() })));
    expect(loads).toBe(3);
    expect(host.textContent).toContain(m.correction_stale());
    expect(canvas().queryByRole('textbox', { name: m.correction_url() })).toBeNull();
    await retiredMetadataEdit('https://example.org/obsolete-metadata');
    expect(rejected[0]!.item.statements['schema:url']![0]!.value).toEqual({
      type: 'value',
      content: 'https://example.org/retained',
    });
    expect(host.querySelector('[data-slot="character-initial-fact"] code')!.textContent).toContain(
      'https://example.org/retained',
    );
    await click(m.recipe_remove_field());
    await click(m.recipe_remove_field());
    expect(host.querySelector('[data-slot="character-initial-fact"]')).toBeNull();

    for (const scenario of ['uncertain', 'denied', 'reader-unavailable', 'concealed'] as const) {
      const fixture = characterProfileFixture(scenario);
      await render(fixture);
      await name('Recovery draft');
      await add('schema:url');
      await replace(control(m.correction_url()), 'https://example.org/recovery');
      const beforeCommand = capture(control(m.correction_url()));
      await submit();
      if (scenario === 'uncertain') {
        await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
        expect(control(m.catalogue_create_label()).closest('fieldset[disabled]')).not.toBeNull();
        const remove = canvas().getByRole('button', { name: m.recipe_remove_field() }) as HTMLButtonElement;
        expect(remove.disabled || remove.closest('fieldset[disabled]') !== null).toBe(true);
        await act(async () => user.click(remove));
        await beforeCommand('https://example.org/late-uncertain');
        expect(control(m.correction_url()).value).toBe('https://example.org/recovery');
        const original = structuredClone(writes(fixture)[0]);
        await click(m.correction_retry());
        await waitFor(() => expect(canvas().getByRole('link', { name: m.candidate_view_public() })).toBeDefined());
        expect(writes(fixture)).toEqual([original, original]);
      } else if (scenario === 'denied') {
        await waitFor(() => expect(host.textContent).toContain(m.correction_denied()));
        expect(control(m.catalogue_create_label()).value).toBe('Recovery draft');
        expect(control(m.catalogue_create_label()).closest('fieldset[disabled]')).toBeNull();
        expect(canvas().queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
      } else {
        await waitFor(() =>
          expect(host.textContent).toContain(
            scenario === 'concealed' ? m.catalogue_create_concealed() : m.catalogue_create_reader_unavailable(),
          ),
        );
        expect(host.textContent).toContain(characterCreatedId);
        await click(m.correction_retry());
        expect(writes(fixture)).toHaveLength(1);
        expect(
          fixture.calls.filter((call) => call.method === 'GET' && call.path === `/v1/subjects/${characterCreatedId}`),
        ).toHaveLength(2);
        expect(canvas().queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
      }
    }
    // A recovered ordinary read opens the returned identity without sending another creation command.
    const recovered = characterProfileFixture('reader-unavailable');
    const readIds: string[] = [];
    await render(recovered, {
      ...recovered.transport,
      read: async (id) => {
        readIds.push(id);
        return { state: 'ready', href: `/en/subjects/${id}/recovered-traveler` };
      },
    });
    await name('Recovered traveler');
    await submit();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_reader_unavailable()));
    await click(m.correction_retry());
    expect(readIds).toEqual([characterCreatedId]);
    expect(canvas().getByRole('link', { name: m.candidate_view_public() }).getAttribute('href')).toBe(
      `/en/subjects/${characterCreatedId}/recovered-traveler`,
    );
    expect(writes(recovered)).toHaveLength(1);

    const conflict = characterProfileFixture();
    const attempts: CharacterCommand[] = [];
    const conflicting: CharacterTransport = {
      ...conflict.transport,
      create: async (command) => {
        attempts.push(structuredClone(command));
        return attempts.length === 1 ? { ok: false, reason: 'conflict' } : conflict.transport.create(command);
      },
    };
    await render(conflict, conflicting);
    await name('Conflict draft');
    await submit();
    expect(host.textContent).toContain(m.catalogue_create_conflict());
    expect((canvas().getByRole('button', { name: m.correction_retry() }) as HTMLButtonElement).disabled).toBe(true);
    await click(m.catalogue_create_review_new());
    expect(control(m.catalogue_create_label()).value).toBe('Conflict draft');
    await submit();
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]!.item).toEqual(attempts[0]!.item);
    expect(attempts[1]!.key).not.toBe(attempts[0]!.key);

    for (const scenario of ['loading', 'unavailable', 'stale'] as const) {
      await render(characterProfileFixture(scenario));
      expect(canvas().queryByRole('textbox', { name: m.catalogue_create_label() })).toBeNull();
    }
    const pair = characterProfileFixture();
    await render(pair, pair.transport, true, true);
    await waitFor(() =>
      expect(canvas().getAllByRole('form', { name: m.character_create_correction_form() })).toHaveLength(2),
    );
    const ids = [...host.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    await replace(canvas().getAllByRole('textbox', { name: m.catalogue_create_label() })[0]!, 'Independent first');
    expect((canvas().getAllByRole('textbox', { name: m.catalogue_create_label() })[1] as HTMLInputElement).value).toBe(
      '',
    );

    const retired = characterProfileFixture();
    let finish!: (result: CreateResult) => void;
    let reads = 0;
    const delayed: CharacterTransport = {
      ...retired.transport,
      create: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      read: async () => {
        reads++;
        return { state: 'unavailable' };
      },
    };
    await render(retired, delayed);
    await name('Retired private draft');
    await add('schema:url');
    await replace(control(m.correction_url()), 'https://example.org/pending');
    const beforePending = capture(control(m.correction_url()));
    await submit();
    await beforePending('https://example.org/late-pending');
    expect(control(m.correction_url()).value).toBe('https://example.org/pending');
    await render(retired, delayed, false, false, false);
    await act(async () =>
      finish({ ok: true, id: characterCreatedId, reader: { state: 'ready', href: '/en/retired-reader' } }),
    );
    expect(host.innerHTML).not.toContain('Retired private draft');
    expect(host.innerHTML).not.toContain('/en/retired-reader');
    expect(canvas().queryByRole('textbox', { name: m.catalogue_create_label() })).toBeNull();
    expect(reads).toBe(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(oldLocale, { reload: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 60_000);
