import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { CharacterCommand, CharacterTransport } from '../src/features/catalogue/character-profile';
import type { CreateFailure, CreateResult } from '../src/features/catalogue/create-subject';

// UNRUN authored actual-renderer coverage. This is not native, browser, visual or SSR acceptance.
test('CharacterCreate associates exact corrections, retains drafts and attempts, and falls back honestly as controls retire', async () => {
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
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { CharacterProfileCreate } = await import('../src/features/catalogue/character-profile-create');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { characterProfileFixture } = await import('../src/kernel/fake/catalogue-character-profile');
  const { characterCreateCorrections, characterCorrectionTargets } =
    await import('../src/features/catalogue/character-create-guidance');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const canvas = within(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  let mount = 0;
  const fixture = characterProfileFixture();
  let failure: CreateFailure | undefined;
  const commands: CharacterCommand[] = [];
  const transport: CharacterTransport = {
    ...fixture.transport,
    create: async (command) => {
      commands.push(structuredClone(command));
      return failure ?? fixture.transport.create(command);
    },
  };
  const created: CreateResult[] = [];
  const render = async (
    options: { transport?: CharacterTransport; locale?: string; admitted?: boolean; pair?: boolean } = {},
  ) => {
    const admitted = options.admitted ?? true;
    const locale = options.locale ?? 'en';
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address={`character-correction-${mount}`}
            observed={
              admitted
                ? { state: 'signed-in', subject: 'fixture-reader', csrfToken: 'original-epoch' }
                : { state: 'signed-out', csrfToken: null }
            }
          >
            {admitted && (
              <CharacterProfileCreate
                locale={locale}
                release={fixture.release}
                transport={options.transport ?? transport}
                onCreated={(result) => created.push(result)}
              />
            )}
            {options.pair && (
              <CharacterProfileCreate
                locale={locale}
                release={fixture.release}
                transport={transport}
                onCreated={(result) => created.push(result)}
              />
            )}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  };
  const button = (name: string) => canvas.getByRole('button', { name });
  const click = (name: string) => act(async () => user.click(button(name)));
  const replace = (element: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(element);
      if (value) await user.type(element, value);
    });
  const input = (name: string) => canvas.getByRole('textbox', { name }) as HTMLInputElement;
  const submit = async () => {
    if (canvas.queryByRole('button', { name: m.correction_retry() })) return click(m.correction_retry());
    if (canvas.queryByRole('button', { name: m.character_create() })) return click(m.character_create());
    await click(m.character_create_review());
    if (canvas.queryByRole('button', { name: m.character_create() })) await click(m.character_create());
  };
  const summary = () => canvas.getByRole('region', { name: m.character_create_correction_summary() });
  const links = () => within(summary()).queryAllByRole('link') as HTMLAnchorElement[];
  const technical = () => JSON.parse(host.querySelector('details pre code')!.textContent!);
  const association = async (control: HTMLElement) => {
    const link = links().find((link) => decodeURIComponent(link.hash.slice(1)) === control.id)!;
    expect(link).toBeDefined();
    const item = link.closest('li')!;
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')!.split(' ')).toContain(item.id);
    expect(window.document.getElementById(item.id)).toBe(item);
    await act(async () => {
      link.focus();
      await user.keyboard('{Enter}');
    });
    expect(window.document.activeElement).toBe(control);
    expect(item.textContent).not.toContain('/statements/');
    return item;
  };
  const addFact = async (property: string) =>
    act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), property);
      await user.click(button(m.character_add_fact()));
    });
  try {
    await render();
    const name = input(m.catalogue_create_label());
    const language = input(m.catalogue_create_language());
    const description = input(m.catalogue_create_description());
    await replace(name, '旅人 — Traveler');
    await replace(language, 'en/日本語~');
    await submit();
    expect((await association(language)).textContent).toContain(m.catalogue_create_validation_language());
    expect(technical()).toContainEqual({ pointer: '/labels/en~1日本語~0', code: 'invalid_format' });
    expect(fixture.calls).toHaveLength(0);
    expect(commands).toHaveLength(0);
    await replace(language, 'en');
    await replace(name, '');
    await replace(description, '説明'.repeat(126));
    await submit();
    expect((await association(name)).textContent).toContain(m.catalogue_create_validation_name_required());
    expect((await association(description)).textContent).toContain(m.catalogue_create_validation_description_length());
    expect(description.value).toBe('説明'.repeat(126));
    expect(commands).toHaveLength(0);
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    await act(async () => {
      details.querySelector('summary')!.focus();
      await user.keyboard('{Enter}');
    });
    expect(details.open).toBe(true);
    expect(details.querySelector('code')!.classList.contains('select-all')).toBe(true);
    await replace(name, '旅人 — Traveler');
    await replace(description, 'Same description');
    await click(m.catalogue_create_add_language());
    const languages = canvas.getAllByRole('textbox', { name: m.catalogue_create_language() });
    const names = canvas.getAllByRole('textbox', { name: m.catalogue_create_label() });
    const descriptions = canvas.getAllByRole('textbox', { name: m.catalogue_create_description() });
    await replace(languages[1]!, 'en');
    await replace(names[1]!, '旅人');
    await replace(descriptions[1]!, 'Same description');
    await submit();
    expect((await association(languages[1]!)).textContent).toContain(m.catalogue_create_validation_language_unique());
    await replace(languages[1]!, 'ja');
    await addFact('schema:height');
    await replace(input(m.correction_amount()), '+');
    await submit();
    const amount = input(m.correction_amount());
    const unit = canvas.getByRole('combobox', { name: m.correction_unit() });
    await association(amount);
    await association(unit);
    await replace(amount, '+170');
    await act(async () => user.selectOptions(unit, 'http://www.wikidata.org/entity/Q174728'));
    // Repeat errors share one stable control, but every diagnostic keeps its own unique association.
    failure = {
      ok: false,
      reason: 'invalid',
      errors: [
        { pointer: '/statements/schema:height/0/value/content/amount', code: 'out_of_range' },
        { pointer: '/statements/schema:height/0/value/content/amount', code: 'invalid_format' },
        { pointer: '/statements/schema:height/0/property/id', code: 'unsupported' },
      ],
    };
    await submit();
    await association(amount);
    expect(amount.getAttribute('aria-describedby')!.split(' ')).toHaveLength(2);
    expect(links()).toHaveLength(2);
    expect(technical()).toEqual(failure.errors);
    const beforePresentation = commands.length;
    await act(async () => user.click(links()[0]!));
    expect(commands).toHaveLength(beforePresentation);
    expect(fixture.calls).toHaveLength(0);
    const oldAmountId = amount.id;
    await click(m.recipe_remove_field());
    await click(m.recipe_remove_field());
    await addFact('schema:height');
    const replacement = input(m.correction_amount());
    expect(replacement.id).not.toBe(oldAmountId);
    expect(replacement.getAttribute('aria-invalid')).toBeNull();
    expect(links()).toHaveLength(0);
    expect(summary().textContent).toContain(m.character_create_correction_fallback());
    expect(technical()).toEqual(failure.errors);
    await replace(replacement, '+171');
    await act(async () =>
      user.selectOptions(
        canvas.getByRole('combobox', { name: m.correction_unit() }),
        'http://www.wikidata.org/entity/Q174728',
      ),
    );
    failure = {
      ok: false,
      reason: 'invalid',
      refreshDefinitions: true,
      errors: [
        { pointer: '', code: 'out_of_range' },
        { pointer: '/labels/removed', code: 'required' },
        { pointer: '/labels/en-US', code: 'invalid_format' },
        { pointer: '/statements/schema:height/99/value/content/unit', code: 'unsupported' },
        { pointer: '/future/未対応~1field~0', code: 'unknown_field' },
        { pointer: '/labels/en~2malformed', code: 'invalid_format' },
      ],
    };
    await submit();
    expect(links()).toHaveLength(0);
    expect(technical()).toEqual(failure.errors);
    expect(name.value).toBe('旅人 — Traveler');
    expect(name.getAttribute('aria-invalid')).toBeNull();
    expect(host.textContent).toContain(m.catalogue_create_refresh());
    const invalidCommand = commands.at(-1)!;
    failure = { ok: false, reason: 'conflict', errors: [{ pointer: '/labels/en', code: 'invalid_format' }] };
    await submit();
    const conflictCommand = commands.at(-1)!;
    expect(conflictCommand.key).not.toBe(invalidCommand.key);
    expect(canvas.queryByRole('region', { name: m.character_create_correction_summary() })).toBeNull();
    expect(host.textContent).toContain(m.correction_stale());
    expect(name.closest('fieldset[disabled]')).not.toBeNull();
    expect((button(m.correction_retry()) as HTMLButtonElement).disabled).toBe(true);
    await click(m.catalogue_create_review_new());
    expect(name.value).toBe('旅人 — Traveler');
    failure = { ok: false, reason: 'unavailable', errors: [{ pointer: '/labels/en', code: 'invalid_format' }] };
    await submit();
    const uncertainCommand = commands.at(-1)!;
    expect(uncertainCommand.key).not.toBe(conflictCommand.key);
    expect(canvas.queryByRole('region', { name: m.character_create_correction_summary() })).toBeNull();
    expect(name.getAttribute('aria-invalid')).toBeNull();
    const beforeRerender = commands.length;
    await render();
    expect(commands).toHaveLength(beforeRerender);
    failure = undefined;
    await click(m.correction_retry());
    expect(commands.at(-1)).toEqual(uncertainCommand);
    expect(created.at(-1)).toMatchObject({ ok: true, reader: { state: 'ready' } });
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    // Independent mounts, repeated descriptions and the fact selector must never duplicate DOM IDs.
    mount++;
    await render({ pair: true });
    const ids = [...host.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    await render({ admitted: false });
    expect(host.querySelector('form')).toBeNull();
    await render();
    expect(input(m.catalogue_create_label()).value).toBe('');

    // Current permission retirement fences a late refusal and discards the retired correction state.
    let resolve!: (result: CreateResult) => void;
    const late = new Promise<CreateResult>((done) => {
      resolve = done;
    });
    const delayed = { ...transport, create: async () => late };
    mount++;
    await render({ transport: delayed });
    await replace(input(m.catalogue_create_label()), 'Retired draft');
    await submit();
    await render({ admitted: false });
    await act(async () =>
      resolve({ ok: false, reason: 'invalid', errors: [{ pointer: '/labels/en', code: 'invalid_format' }] }),
    );
    expect(host.querySelector('form')).toBeNull();
    await render();
    expect(input(m.catalogue_create_label()).value).toBe('');
    expect(canvas.queryByRole('region', { name: m.character_create_correction_summary() })).toBeNull();

    // Native statement indices are property-local, even when the visible facts are interleaved.
    mount++;
    await render();
    await replace(input(m.catalogue_create_label()), 'Interleaved facts');
    await addFact('schema:sameAs');
    const valueUrl = (row: Element) =>
      within(row.querySelector('[id$="-fact"]') as HTMLElement).getByRole('textbox', {
        name: m.correction_url(),
      }) as HTMLInputElement;
    await replace(valueUrl(host.querySelector('[data-slot="character-initial-fact"]')!), 'https://example.org/first');
    await addFact('schema:height');
    await replace(input(m.correction_amount()), '+');
    await addFact('schema:sameAs');
    const sameAsRows = [...host.querySelectorAll('[data-slot="character-initial-fact"]')].filter((row) =>
      within(row.querySelector('[id$="-fact"]') as HTMLElement).queryByRole('textbox', { name: m.correction_url() }),
    );
    const secondUrl = valueUrl(sameAsRows[1]!);
    const secondUrlId = secondUrl.id;
    const nativeBefore = fixture.calls.length;
    await submit();
    await association(secondUrl);
    expect(valueUrl(sameAsRows[0]!).getAttribute('aria-invalid')).toBeNull();
    expect(technical()).toContainEqual({
      pointer: '/statements/schema:sameAs/1/value/content',
      code: 'invalid_format',
    });
    await act(async () => user.click(canvas.getAllByRole('button', { name: m.recipe_remove_field() })[0]!));
    await act(async () => user.click(canvas.getAllByRole('button', { name: m.recipe_remove_field() })[0]!));
    const remainingUrl = valueUrl(
      [...host.querySelectorAll('[data-slot="character-initial-fact"]')].find((row) =>
        within(row.querySelector('[id$="-fact"]') as HTMLElement).queryByRole('textbox', { name: m.correction_url() }),
      )!,
    );
    expect(remainingUrl.id).toBe(secondUrlId);
    await association(remainingUrl);
    expect(technical()).toContainEqual({
      pointer: '/statements/schema:sameAs/1/value/content',
      code: 'invalid_format',
    });
    expect(fixture.calls).toHaveLength(nativeBefore);

    // Growth source: many current fields, duplicate descriptions, removed/unknown pointers and long multilingual data.
    // Pure presentation stays bounded to current fields + returned errors and performs no native work.
    const manyTerms = Array.from({ length: 128 }, (_, id) => ({
      id,
      language: `en-x${id}`,
      label: '旅人'.repeat(125),
      description: '同じ説明'.repeat(63),
      aliases: '',
    }));
    const manyFacts = Array.from({ length: 128 }, (_, id) => ({
      id,
      fact: {
        property: { id: 'schema:height' },
        value: { type: 'value' as const, content: { amount: '+170', unit: '1' } },
        qualifiers: [],
        references: [],
        rank: 'normal' as const,
      },
    }));
    const errors = manyTerms.map((term) => ({
      pointer: `/descriptions/${term.language}`,
      code: 'out_of_range' as const,
    }));
    errors.push({ pointer: '/statements/schema:height/127/value/content/amount', code: 'out_of_range' });
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      const all = characterCreateCorrections(errors, manyTerms, manyFacts, fixture.release, locale, 'growth');
      expect(all).toHaveLength(errors.length);
      expect(new Set(all.map((error) => error.id)).size).toBe(errors.length);
      const current = characterCorrectionTargets(
        'growth',
        manyTerms.slice(0, -1),
        manyFacts.slice(0, -1),
        fixture.release,
      );
      expect(current.has(all[127]!.target!)).toBe(false);
      expect(current.has(all[128]!.target!)).toBe(false);
      expect(all[0]!.instruction).not.toContain('undefined');
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
