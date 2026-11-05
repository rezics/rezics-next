import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonRead, AddonTransport } from '../src/features/catalogue/addon-profile';
import type { CreateResult, CreateSubjectCommand } from '../src/features/catalogue/create-subject';
import type { GameItem } from '../src/features/catalogue/game-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN: mounted actual components and canonical HTTP fixtures, with explicit failure seams.
// Widths express review intent; DOM assertions are not geometry, native, SSR or physical growth proof.
// Cost: one frame/action around already bounded facts, O(supplied rows/text), constant overhead per group.
// Staging adds zero IO; the 1/8/32 witness preserves the metadata-pair/write/reader request count.
// Existing shared reference-choice enumeration remains unchanged; no hidden population traversal is added.
test('add-on initial creation preserves explicit bases, independent corrections, evidence and exact creation ownership', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/addon' });
  const extraIO: string[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
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
    fetch: (async (input: RequestInfo | URL) => {
      extraIO.push(String(input));
      throw new Error('Initial creation presentation must not acquire data');
    }) as typeof fetch,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { AddonProfileCreate } = await import('../src/features/catalogue/addon-profile-create');
  const { AddonProfile } = await import('../src/features/catalogue/addon-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { addonBase, addonType, addonFields } = await import('../src/features/catalogue/addon-profile');
  const { addonProfileFixture, addonWorkId, addonCreatedId, addonPlatformId } =
    await import('../src/kernel/fake/catalogue-addon-profile');
  const { pageText } = await import('../src/features/pages/data');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let generation = 0;
  const created: Extract<CreateResult, { ok: true }>[] = [];
  const received = (result: Extract<CreateResult, { ok: true }>) => {
    created.push(result);
  };
  async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(predicate()).toBe(true);
  }
  async function render(node: ReactNode, fresh = true, retired = false) {
    if (fresh) {
      await act(async () => root.render(null));
      client.clear();
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      generation++;
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address={`addon-creation:${generation}`}
            observed={
              retired
                ? { state: 'signed-out', csrfToken: null }
                : { state: 'signed-in', subject: 'original-reader', csrfToken: 'original-csrf' }
            }
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const forms = () => [...host.querySelectorAll<HTMLFormElement>('form')];
  const group = (scope: ParentNode = host) => scope.querySelector<HTMLElement>('[data-slot="addon-initial-facts"]')!;
  const rows = (scope: ParentNode = host) => [
    ...group(scope).querySelectorAll<HTMLElement>(':scope > fieldset > section'),
  ];
  const click = (name: string, scope: HTMLElement = host) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  async function confirm(scope: HTMLElement = host) {
    await click(m.catalogue_create_submit(), scope);
    if (scope.querySelector('[data-addon-create-review]')) await click(m.catalogue_create_submit(), scope);
  }
  async function input(element: HTMLElement, value: string) {
    await act(async () => {
      const prototype =
        element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  async function terms(scope: HTMLElement = host, label = 'Northern lights') {
    // Native shared term IDs are intentionally unchanged; scope each independent form explicitly.
    await input(scope.querySelector('input[id="create-label-0"]')!, label);
    await input(scope.querySelector('input[id="create-language-0"]')!, 'en');
  }
  async function add(property: string, scope: HTMLElement = host) {
    await act(async () =>
      user.selectOptions(within(group(scope)).getByRole('combobox', { name: m.character_add_fact() }), property),
    );
    await act(async () => user.click(within(group(scope)).getAllByRole('button', { name: m.correction_add() })[0]!));
    return rows(scope).at(-1)!;
  }
  async function part(row: HTMLElement, label: string, property: string) {
    const select = within(row).getByRole('combobox', { name: label });
    await act(async () => user.selectOptions(select, property));
    await click(m.correction_add(), select.closest('[data-slot="field"]')!.parentElement!);
  }
  function direct(
    read: Extract<AddonRead, { ok: true }>,
    transport: AddonTransport,
    search = addonProfileFixture().props.search,
  ) {
    return (
      <AddonProfileCreate
        read={read}
        locale="en"
        session="signed-in"
        transport={transport}
        search={search}
        onCreated={received}
      />
    );
  }
  try {
    for (const width of [390, 1280]) {
      window.happyDOM.setWindowSize({ width, height: 900 });
      host.style.width = `${width}px`;
      const fixture = addonProfileFixture();
      const read = await fixture.transport.load({ work: addonWorkId });
      if (!read.ok) throw new Error('Expected supplied work');
      const baseline = fixture.calls.length;
      const commands: CreateSubjectCommand[] = [];
      let searches = 0;
      const transport = {
        ...fixture.transport,
        create: async (command: CreateSubjectCommand) => {
          commands.push(structuredClone(command));
          return fixture.transport.create(command);
        },
      };
      await render(
        direct(read, transport, async (text, signal) => {
          searches++;
          return fixture.props.search(text, signal);
        }),
      );
      await until(() => forms().length === 1);
      expect(host.querySelectorAll('h1')).toHaveLength(0);
      const frame = group();
      expect(frame.getAttribute('aria-label')).toBe(m.game_profile_initial());
      expect(frame.className).toContain('group relative isolate');
      expect(frame.className).toContain('min-w-0');
      expect(frame.className).toContain('[overflow-wrap:anywhere]');
      expect(frame.className).not.toMatch(/bg-card|border-border|truncate|line-clamp/);
      expect(frame.querySelector('fieldset > legend')?.textContent).toBe(m.game_profile_initial());
      expect(frame.closest('form')).toBe(forms()[0]!);
      expect(rows()).toHaveLength(0);
      expect(searches).toBe(0);
      const action = within(frame).getByRole('button', { name: m.addon_use_base() });
      expect(action.getAttribute('type')).toBe('button');
      expect(action.className).toContain('min-h-11');
      expect(action.className).toContain('min-w-11');
      expect(action.className).toContain('md:pointer-fine:min-h-8');
      expect(action.className).toContain('whitespace-normal');
      expect(action.className).toContain('focus-visible:outline-2');
      action.focus();
      await act(async () => user.keyboard('{Enter}'));
      expect(rows()).toHaveLength(1);
      expect(within(frame).queryByRole('button', { name: m.addon_use_base() })).toBeNull();
      // No action remains to insert a second identical supplied native base.
      const baseRow = rows()[0]!;
      expect(baseRow.querySelector('h2')?.textContent).toBe(
        pageText(read.release.properties[addonBase]!.labels, 'en').text,
      );
      await click(m.recipe_remove_field(), baseRow);
      expect(rows()).toHaveLength(0);
      await click(m.addon_use_base());
      expect(rows()).toHaveLength(1);
      expect(within(frame).queryByRole('button', { name: m.addon_use_base() })).toBeNull();
      await terms();
      const description = '追加作品の説明 — 설명 — وصف '.repeat(6);
      await input(host.querySelector('input[id="create-description-0"]')!, description);
      await input(host.querySelector('textarea[id="create-aliases-0"]')!, 'Northern lights alternate\n北の光');
      await click(m.catalogue_create_add_language());
      await input(host.querySelector('input[id="create-language-1"]')!, 'ja');
      await input(host.querySelector('input[id="create-label-1"]')!, '北の光');
      const platform = await add('schema:gamePlatform');
      const platformLabel = pageText(read.release.properties['schema:gamePlatform']!.labels, 'en').text;
      await act(async () => user.type(within(platform).getByRole('combobox', { name: platformLabel }), 'platform'));
      await until(() => !!window.document.querySelector('[role="listbox"]'));
      const options = within(within(window.document.body as unknown as HTMLElement).getByRole('listbox')).getAllByRole(
        'option',
      );
      expect(options).toHaveLength(1);
      expect(options[0]!.textContent).toContain('Desktop platform');
      expect(options[0]!.textContent).not.toContain('Harbor Studio');
      await act(async () => user.click(options[0]!));
      await part(platform, m.correction_add_qualifier(), 'schema:inLanguage');
      await input(within(platform).getByRole('textbox', { name: m.correction_value() }), 'ja');
      await click(m.correction_add_reference(), platform);
      await part(platform, m.correction_add_part(), 'schema:url');
      const url = `https://example.org/evidence/${'NorthernLights'.repeat(40)}?language=ja`;
      await input(within(platform).getByRole('textbox', { name: m.correction_url() }), url);
      expect((within(platform).getByRole('textbox', { name: m.correction_url() }) as HTMLInputElement).value).toBe(url);
      expect(fixture.calls).toHaveLength(baseline);
      await confirm();
      await until(() => !!within(host).queryByRole('link', { name: m.catalogue_create_open() }));
      const item = commands[0]!.item as GameItem;
      expect(item.type).toBe(addonType);
      expect(item.labels).toEqual({ en: 'Northern lights', ja: '北の光' });
      expect(item.descriptions.en).toBe(description.trim());
      expect(item.aliases.en).toEqual(['Northern lights alternate', '北の光']);
      expect(item.statements[addonBase]).toEqual([
        {
          property: { id: addonBase },
          value: { type: 'value', content: addonWorkId },
          qualifiers: [],
          references: [],
          rank: 'normal',
        },
      ]);
      expect(item.statements['schema:gamePlatform']).toEqual([
        {
          property: { id: 'schema:gamePlatform' },
          value: { type: 'value', content: addonPlatformId },
          qualifiers: [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }],
          references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }] }],
          rank: 'normal',
        },
      ]);
      expect(created.at(-1)).toMatchObject({ id: addonCreatedId, reader: { state: 'ready' } });
      expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      expect(fixture.calls.length - baseline).toBe(4); // metadata pair, one write, exact public reader
      expect(searches).toBe(1);
    }

    // Supplied work is context, never an automatic assertion; absent work exposes no supplied-base action.
    for (const supplied of [true, false]) {
      const fixture = addonProfileFixture();
      const read = await fixture.transport.load(supplied ? { work: addonWorkId } : {});
      if (!read.ok) throw new Error('Expected creation read');
      await render(direct(read, fixture.transport));
      await until(() => forms().length === 1);
      expect(!!within(host).queryByRole('button', { name: m.addon_use_base() })).toBe(supplied);
      await terms();
      await confirm();
      await until(() => !!within(host).queryByRole('link', { name: m.catalogue_create_open() }));
      const body = fixture.calls.find((call) => call.method === 'POST')!.body as GameItem;
      expect(body.statements[addonBase]).toBeUndefined();
    }

    // Full fallback metadata retains its supplied language inside an RTL container.
    const localized = addonProfileFixture();
    const localizedRead = await localized.transport.load({ work: addonWorkId });
    if (!localizedRead.ok) throw new Error('Expected localized creation read');
    const localizedRelease = structuredClone(localizedRead.release);
    const localizedName = `منصة اللعبة 遊戲平台 ${'PlatformOhneLeerzeichen'.repeat(12)}`;
    const localizedMeaning = '説明を省略しません。 وصف كامل للمنصة والأدلة. '.repeat(8).trim();
    localizedRelease.properties['schema:gamePlatform']!.labels = { ar: localizedName };
    localizedRelease.properties['schema:gamePlatform']!.descriptions = { ar: localizedMeaning };
    host.dir = 'rtl';
    await render(direct({ ...localizedRead, release: localizedRelease }, localized.transport));
    await until(() => forms().length === 1);
    const choice = within(group()).getByRole('option', { name: localizedName });
    expect(choice.getAttribute('lang')).toBe('ar');
    const localizedRow = await add('schema:gamePlatform');
    const localizedHeading = within(localizedRow).getByRole('heading', { name: localizedName });
    expect(localizedHeading.getAttribute('lang')).toBe('ar');
    expect(localizedHeading.textContent).toBe(localizedName);
    expect(within(localizedRow).getByText(localizedMeaning).getAttribute('lang')).toBe('ar');
    expect(localizedRow.closest('[dir="rtl"]')).toBe(host);
    expect(localized.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    host.removeAttribute('dir');

    // Two live forms use distinct facts targets; no attempt to rewrite foreign shared term IDs.
    const pair = addonProfileFixture();
    const read = await pair.transport.load({ work: addonWorkId });
    if (!read.ok) throw new Error('Expected pair read');
    await render(
      <>
        {direct(read, pair.transport)}
        {direct({ ...read, work: null }, addonProfileFixture().transport)}
      </>,
    );
    await until(() => forms().length === 2);
    const targets = forms().map((form) => group(form));
    expect(targets[0]!.id).not.toBe(targets[1]!.id);
    for (const [index, form] of forms().entries()) {
      await terms(form, `Independent ${index}`);
      const row = await add('schema:inLanguage', form);
      expect(rows(forms()[1 - index]!)).toHaveLength(index === 0 ? 0 : 1);
      await input(within(row).getByRole('textbox', { name: m.correction_value() }), 'invalid language');
      const field = within(row).getByRole('textbox', { name: m.correction_value() });
      await confirm(form);
      await until(() => !!within(form).queryByRole('alert'));
      const correction = within(within(form).getByRole('alert')).getByRole('link');
      expect(decodeURIComponent(correction.getAttribute('href')!.slice(1))).toBe(field.id);
      expect(decodeURIComponent(correction.getAttribute('href')!.slice(1))).not.toBe(targets[index]!.id);
      expect(decodeURIComponent(correction.getAttribute('href')!.slice(1))).not.toBe(targets[1 - index]!.id);
      await act(async () => {
        correction.focus();
        await user.keyboard('{Enter}');
      });
      expect(window.document.activeElement).toBe(field);
      expect(form.contains(window.document.activeElement as unknown as Node)).toBe(true);
      expect(correction.textContent).not.toContain('/statements');
      await act(async () =>
        user.click(
          within(within(form).getByRole('alert')).getByText(m.catalogue_creation_technical_details(), {
            selector: 'summary',
          }),
        ),
      );
      // Diagnostics retain the exact pointer in native details, independently of the human correction name.
      expect(form.textContent).toContain('/statements/schema:inLanguage/0/value/content');
      await input(within(row).getByRole('textbox', { name: m.correction_value() }), 'ja');
      expect(rows(form)).toHaveLength(1);
    }
    expect(pair.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const beforeRecovery = created.length;
    for (const form of forms()) {
      await confirm(form);
      await until(() => !form.isConnected);
    }
    expect(created.length - beforeRecovery).toBe(2);
    expect(pair.calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    // Released multiplicity and target admission come from the real controls, not fixture-only commands.
    await render(direct(read, pair.transport));
    await until(() => forms().length === 1);
    const select = within(group()).getByRole('combobox', { name: m.character_add_fact() }) as HTMLSelectElement;
    expect(
      [...select.options]
        .filter((option) => option.value)
        .map((option) => option.value)
        .sort(),
    ).toEqual(addonFields(read.release).sort());
    await add('schema:url');
    expect([...select.options].some((option) => option.value === 'schema:url')).toBe(false);
    await add('schema:sameAs');
    expect([...select.options].some((option) => option.value === 'schema:sameAs')).toBe(true);
    expect([...select.options].some((option) => option.value === 'schema:name')).toBe(false);
    const citationRow = rows()[1]!;
    for (let index = 0; index < 16; index++) await click(m.correction_add_reference(), citationRow);
    expect(
      (within(citationRow).getByRole('button', { name: m.correction_add_reference() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(citationRow.querySelectorAll('fieldset')).toHaveLength(16);
    const ineligible = structuredClone(read.release);
    ineligible.types[addonType]!.properties = ineligible.types[addonType]!.properties.filter(
      (property) => property !== addonBase,
    );
    await render(direct({ ...read, release: ineligible }, pair.transport));
    await until(() => !!within(host).queryByRole('button', { name: m.addon_use_base() }));
    expect((within(host).getByRole('button', { name: m.addon_use_base() }) as HTMLButtonElement).disabled).toBe(true);

    // Supplied-data growth at the real 32-row maximum: no lookups, refill or population traversal.
    for (const count of [1, 8, 32]) {
      const fixture = addonProfileFixture();
      const current = await fixture.transport.load({});
      if (!current.ok) throw new Error('Expected growth read');
      const baseline = fixture.calls.length;
      await render(direct(current, fixture.transport));
      await until(() => forms().length === 1);
      await terms();
      for (let index = 0; index < count; index++) {
        const row = await add('schema:sameAs');
        await input(
          within(row).getByRole('textbox', { name: m.correction_url() }),
          `https://example.org/identity/${index}`,
        );
      }
      expect(rows()).toHaveLength(count);
      expect(fixture.calls).toHaveLength(baseline);
      if (count === 32) {
        await act(async () =>
          user.selectOptions(within(group()).getByRole('combobox', { name: m.character_add_fact() }), 'schema:sameAs'),
        );
        expect(
          (within(group()).getAllByRole('button', { name: m.correction_add() })[0] as HTMLButtonElement).disabled,
        ).toBe(true);
      }
      await confirm();
      await until(() => !!within(host).queryByRole('link', { name: m.catalogue_create_open() }));
      expect(
        (fixture.calls.find((call) => call.method === 'POST')!.body as GameItem).statements['schema:sameAs'],
      ).toHaveLength(count);
      expect(fixture.calls.length - baseline).toBe(4);
    }

    // Refresh failure retains both drafts. Recovery uses the shared form's existing metadata retry.
    const refresh = addonProfileFixture();
    const refreshRead = await refresh.transport.load({ work: addonWorkId });
    if (!refreshRead.ok) throw new Error('Expected refresh read');
    const addresses: unknown[] = [];
    const refreshCommands: CreateSubjectCommand[] = [];
    await render(
      direct(refreshRead, {
        ...refresh.transport,
        create: async (command) => {
          refreshCommands.push(structuredClone(command));
          return {
            ok: false,
            reason: 'invalid',
            refreshDefinitions: true,
            errors: [{ pointer: '/statements/schema:inLanguage/0/value/content', code: 'invalid_format' }],
          };
        },
        load: async (address) => {
          addresses.push(address);
          return { ok: false, reason: 'denied' };
        },
      }),
    );
    await until(() => forms().length === 1);
    await terms();
    const fact = await add('schema:inLanguage');
    await input(within(fact).getByRole('textbox', { name: m.correction_value() }), 'ja');
    await confirm();
    await until(() => host.textContent!.includes(m.catalogue_create_unavailable()));
    expect(forms()).toHaveLength(0);
    expect(addresses).toEqual([{ work: addonWorkId }]);
    await click(m.catalogue_create_retry());
    await until(() => forms().length === 1);
    expect((host.querySelector('input[id="create-label-0"]') as HTMLInputElement).value).toBe('Northern lights');
    expect((within(rows()[0]!).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement).value).toBe(
      'ja',
    );
    expect(refreshCommands).toHaveLength(1);

    // The parent owns invalid/stale/denied/unavailable metadata distinctions and no form is fabricated.
    for (const reason of ['invalid', 'stale', 'denied', 'unavailable'] as const) {
      const fixture = addonProfileFixture();
      await render(
        <AddonProfile
          {...fixture.props}
          locale="en"
          transport={{ ...fixture.transport, load: async () => ({ ok: false, reason }) }}
        />,
      );
      await until(() => !!within(host).queryByRole('alert'));
      expect(forms()).toHaveLength(0);
      const message =
        reason === 'invalid'
          ? m.correction_invalid()
          : reason === 'stale'
            ? m.correction_stale()
            : reason === 'denied'
              ? m.correction_denied()
              : m.correction_unavailable();
      expect(host.textContent).toContain(message);
      expect(fixture.calls).toHaveLength(0);
    }
    const stale = addonProfileFixture('stale');
    expect(await stale.transport.load({})).toEqual({ ok: false, reason: 'unavailable' });
    const empty = structuredClone(read.release);
    empty.types[addonType]!.labels = {};
    await render(direct({ ...read, release: empty }, pair.transport));
    await until(() => host.textContent!.includes(m.catalogue_create_empty()));
    expect(forms()).toHaveLength(0);

    for (const scenario of ['denied', 'invalid', 'uncertain', 'ready', 'reader-unavailable', 'concealed'] as const) {
      const fixture = addonProfileFixture(scenario);
      const current = await fixture.transport.load(scenario === 'uncertain' ? { work: addonWorkId } : {});
      if (!current.ok) throw new Error('Expected current creation definitions');
      const commands: CreateSubjectCommand[] = [];
      await render(
        direct(current, {
          ...fixture.transport,
          create: async (command) => {
            commands.push(structuredClone(command));
            return fixture.transport.create(command);
          },
        }),
      );
      await until(() => forms().length === 1);
      await terms();
      if (scenario === 'uncertain') {
        await click(m.addon_use_base());
        const optional = await add('schema:inLanguage');
        await input(within(optional).getByRole('textbox', { name: m.correction_value() }), 'ja');
      }
      await confirm();
      if (scenario === 'uncertain') {
        await until(() => host.textContent!.includes(m.catalogue_create_uncertain()));
        expect(host.querySelector('input')!.closest('fieldset[disabled]')).not.toBeNull();
        await click(m.catalogue_create_retry());
        await until(() => !!within(host).queryByRole('link', { name: m.catalogue_create_open() }));
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual(commands[0]);
        const writes = fixture.calls.filter((call) => call.method === 'POST');
        expect(writes).toHaveLength(2);
        expect(writes[1]!.key).toBe(writes[0]!.key);
        expect(writes[1]!.body).toEqual(writes[0]!.body);
      } else if (scenario === 'denied' || scenario === 'invalid') {
        await until(() => !!within(host).queryByRole('alert'));
        expect(host.textContent).toContain(
          scenario === 'denied' ? m.catalogue_create_denied() : m.catalogue_create_invalid(),
        );
        expect((host.querySelector('input[id="create-label-0"]') as HTMLInputElement).value).toBe('Northern lights');
      } else {
        await until(() => host.textContent!.includes(m.catalogue_create_created()));
        const state = scenario === 'ready' ? 'ready' : scenario === 'concealed' ? 'concealed' : 'unavailable';
        expect(created.at(-1)).toMatchObject({ ok: true, id: addonCreatedId, reader: { state } });
        if (state === 'ready') {
          expect(within(host).getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(
            `/en/subjects/${addonCreatedId}/northern-lights`,
          );
        } else {
          expect(within(host).queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();
          expect(host.textContent).toContain(
            state === 'concealed' ? m.catalogue_create_concealed() : m.catalogue_create_reader_unavailable(),
          );
          const before = fixture.calls.length;
          await click(m.catalogue_create_retry());
          expect(fixture.calls.length - before).toBe(1);
          expect(fixture.calls.at(-1)!.path).toBe(`/v1/subjects/${addonCreatedId}`);
        }
        expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      }
    }

    // Retiring the native editor boundary discards a late success and its callback; no new identity is made.
    const retiring = addonProfileFixture();
    const retiringRead = await retiring.transport.load({});
    if (!retiringRead.ok) throw new Error('Expected retirement read');
    let finish!: (result: CreateResult) => void;
    const pending = new Promise<CreateResult>((resolve) => {
      finish = resolve;
    });
    const beforeCreated = created.length;
    await render(direct(retiringRead, { ...retiring.transport, create: () => pending }));
    await until(() => forms().length === 1);
    await terms();
    await confirm();
    await render(null, false, true);
    await act(async () =>
      finish({ ok: true, id: addonCreatedId, reader: { state: 'ready', href: '/en/subjects/retired' } }),
    );
    expect(created).toHaveLength(beforeCreated);
    expect(host.innerHTML).not.toContain(addonCreatedId);
    expect(forms()).toHaveLength(0);
    expect(extraIO).toEqual([]);
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
}, 30_000);
