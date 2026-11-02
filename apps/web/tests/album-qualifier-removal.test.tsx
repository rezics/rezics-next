import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AlbumCommand, AlbumTransport } from '../src/features/catalogue/album-profile';

test('Album qualifier cancellation, stable correction targets, selective removal and immutable command locks', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/album' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLButtonElement Element Node Text NodeFilter Document ShadowRoot Event KeyboardEvent FocusEvent MouseEvent PointerEvent CSS DocumentFragment DOMParser MutationObserver ResizeObserver Range DOMRect'.split(
    ' ',
  ))
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { AlbumProfileCreate } = await import('../src/features/catalogue/album-profile-create');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { albumFixture, artistId, roleId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', testing));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testing));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    client = new QueryClient();
  const { release, publicRead } = albumFixture();
  const name = (id: string) => release.properties[id]!.labels.en!;
  const commands: AlbumCommand[] = [];
  let enabled = true,
    metadata = true;
  let revision = 'current',
    holder = 0;
  let finish!: (result: Awaited<ReturnType<AlbumTransport['create']>>) => void;
  const invalid = {
    ok: false as const,
    reason: 'invalid' as const,
    errors: [{ pointer: '/statements/schema:contributor/0/qualifiers/0/value/content', code: 'unsupported' }],
  };
  const transport: AlbumTransport = {
    load: async () => ({ ok: true, release, public: null }),
    read: async () => ({ state: 'unavailable' }),
    create: async (command) => {
      commands.push(command);
      if (commands.length === 2) {
        Object.assign(command, { credential: 'original-credential' });
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return invalid;
    },
  };
  const props = {
    release,
    metadataCurrent: () => metadata,
    onReload: async () => {},
    locale: 'en',
    transport,
    search: async (text: string) =>
      [artistId, roleId]
        .filter((id) => publicRead.related[id]!.labels.en!.includes(text))
        .map((id) => ({
          id,
          title: publicRead.related[id]!.labels.en!,
          types: [publicRead.related[id]!.type!],
          typeLabel: '',
          cover: null,
        })),
  };
  const paint = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CatalogueCurrentReading visible ready revision={revision}>
            <AlbumProfileCreate key={holder} {...props} enabled={enabled} />
          </CatalogueCurrentReading>
        </QueryClientProvider>,
      ),
    );
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const select = (scope: HTMLElement, label: string, value: string) =>
    act(async () => user.selectOptions(within(scope).getByRole('combobox', { name: label }), value));
  const type = (scope: HTMLElement, label: string, value: string) =>
    act(async () => user.type(within(scope).getByRole('textbox', { name: label }), value));
  const choose = async (scope: HTMLElement, property: string, id: string) => {
    await act(async () =>
      user.type(within(scope).getByRole('combobox', { name: name(property) }), publicRead.related[id]!.labels.en!),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
  };
  const inputChange = (node: Element) =>
    (
      Reflect.get(
        node,
        Object.keys(node).find((key) => key.startsWith('__reactProps$'))!,
      ) as {
        onChange: (event: { target: { value: string } }) => void;
      }
    ).onChange;
  const pickerChange = (node: Element) => {
    type Fiber = {
      memoizedProps: { search?: unknown; onValueChange?: (items: (typeof selected)[]) => void };
      return?: Fiber;
    };
    let fiber = Reflect.get(
      node,
      Object.keys(node).find((key) => key.startsWith('__reactFiber$'))!,
    ) as Fiber;
    while (typeof fiber.memoizedProps.search !== 'function' || !fiber.memoizedProps.onValueChange)
      fiber = fiber.return!;
    return fiber.memoizedProps.onValueChange;
  };
  const selected = { id: artistId, title: 'Late descriptor', types: [], typeLabel: '', cover: null };
  const remove = (id: string) => `${m.relation_remove()}: ${name(id)}`;
  try {
    await paint();
    await type(host, m.catalogue_create_label(), 'Private Album');
    await select(host, m.character_add_fact(), 'schema:contributor');
    await click(host, m.correction_add());
    const row = host.querySelector<HTMLElement>('fieldset[id^="album-row-"]')!;
    await choose(row, 'schema:contributor', artistId);
    await type(row, m.relation_citation(), 'https://example.test/source');
    await select(row, m.relation_qualifier(), 'wdt:P1932');
    await type(row, name('wdt:P1932'), 'Credited name');
    const original = within(row).getByRole('textbox', { name: name('wdt:P1932') });
    const oldCredit = inputChange(original);
    const oldCitation = inputChange(within(row).getByRole('textbox', { name: m.relation_citation() }));
    const oldArtist = pickerChange(within(row).getByRole('combobox', { name: name('schema:contributor') }));
    await type(row, m.relation_citation(), '/newer');
    await act(async () => oldCredit({ target: { value: 'Current credit' } }));
    expect((original as HTMLInputElement).value).toBe('Current credit');
    expect((within(row).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement).value).toBe(
      'https://example.test/source/newer',
    );
    await act(async () => oldCitation({ target: { value: 'https://example.test/stale' } }));
    expect((within(row).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement).value).toBe(
      'https://example.test/source/newer',
    );
    await select(row, m.relation_qualifier(), 'wdt:P3831');
    await choose(row, 'wdt:P3831', roleId);
    const role = within(row).getByRole('combobox', { name: name('wdt:P3831') });
    const oldRole = pickerChange(role);
    const roleTarget = role.closest('[id^="album-row-"]')!.id;
    await select(row, m.relation_qualifier(), 'schema:position');
    await select(host, m.character_add_fact(), 'schema:sameAs');
    await click(host, m.correction_add());
    const sibling = [...host.querySelectorAll<HTMLElement>('fieldset[id^="album-row-"]')].at(-1)!;
    await type(sibling, m.correction_url(), 'https://example.test/album');
    const oldScalar = inputChange(within(sibling).getByRole('textbox', { name: m.correction_url() }));
    await type(sibling, m.correction_url(), '/newer');
    await act(async () => oldScalar({ target: { value: 'https://example.test/stale' } }));
    expect((within(sibling).getByRole('textbox', { name: m.correction_url() }) as HTMLInputElement).value).toBe(
      'https://example.test/album/newer',
    );
    await click(row, remove('wdt:P1932'));
    await click(row, m.candidate_cancel());
    expect(within(row).getByRole('textbox', { name: name('wdt:P1932') })).toBe(original);
    expect((original as HTMLInputElement).value).toBe('Current credit');
    expect(window.document.activeElement).toBe(within(row).getByRole('button', { name: remove('wdt:P1932') }));
    await click(row, remove('wdt:P3831'));
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(within(row).getByRole('button', { name: remove('wdt:P3831') }));
    await click(row, remove('wdt:P3831'));
    await click(row, remove('schema:position')); // Untouched scaffolding removes immediately.
    await click(row, remove('wdt:P1932'));
    await click(row, remove('wdt:P1932'));
    await act(async () => oldCredit({ target: { value: 'Resurrected' } }));
    expect(within(row).queryByRole('textbox', { name: name('wdt:P1932') })).toBeNull();
    await act(async () => oldArtist([{ ...selected, title: 'Current artist' }]));
    expect(row.textContent).toContain('Current artist');
    const currentArtist = pickerChange(within(row).getByRole('combobox', { name: name('schema:contributor') }));
    await act(async () => oldArtist([selected]));
    expect(row.textContent).not.toContain('Late descriptor');
    expect(window.document.activeElement).toBe(role);
    expect(within(row).getByRole('combobox', { name: name('wdt:P3831') })).toBe(role);
    expect(role.closest('[id^="album-row-"]')!.id).toBe(roleTarget);
    await click(row, m.candidate_cancel());
    await select(row, m.relation_qualifier(), 'wdt:P1932');
    await act(async () => oldCredit({ target: { value: 'Replacement overwritten' } }));
    expect((within(row).getByRole('textbox', { name: name('wdt:P1932') }) as HTMLInputElement).value).toBe('');
    await click(row, remove('wdt:P1932'));
    expect(row.textContent).toContain(publicRead.related[roleId]!.labels.en!);
    await click(row, remove('wdt:P3831'));
    enabled = false;
    await paint();
    await click(row, remove('wdt:P3831'));
    expect(role.isConnected).toBe(true);
    enabled = true;
    metadata = false;
    await paint();
    expect(row.textContent).toContain(roleId);
    expect(row.querySelector('input')).toBeNull();
    metadata = true;
    await paint();
    await click(row, remove('wdt:P3831'));
    await click(host, m.album_create());
    const correction = host.querySelector<HTMLAnchorElement>(`a[href="#${roleTarget}"]`)!;
    expect(correction).not.toBeNull();
    await click(row, remove('wdt:P3831')); // Sealed invalid command.
    await act(async () => user.click(correction));
    expect(row.contains(window.document.activeElement)).toBe(true);
    await click(host, m.album_create());
    const exact = structuredClone(commands[1]);
    await act(async () => currentArtist([selected]));
    expect(row.textContent).not.toContain('Late descriptor');
    await click(row, remove('wdt:P3831')); // Busy command.
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    await click(row, remove('wdt:P3831')); // Uncertain command.
    await act(async () => currentArtist([selected]));
    expect(row.textContent).not.toContain('Late descriptor');
    await click(host, m.catalogue_create_retry());
    expect(commands[2]).toBe(commands[1]);
    expect(commands[2]).toEqual(exact);
    await click(host, m.catalogue_create_review_new());
    await click(row, remove('wdt:P3831'));
    expect(window.document.activeElement).toBe(within(row).getByRole('combobox', { name: m.relation_qualifier() }));
    await click(host, m.album_create());
    const facts = commands.at(-1)!.item.statements;
    await act(async () => oldRole([{ ...selected, id: roleId }]));
    expect(within(row).queryByRole('combobox', { name: name('wdt:P3831') })).toBeNull();
    expect(facts['schema:contributor']![0]!.qualifiers).toEqual([]);
    expect(facts['schema:contributor']![0]!.value).toEqual({ type: 'value', content: artistId });
    expect(facts['schema:contributor']![0]!.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: 'https://example.test/source/newer',
    });
    expect(facts['schema:sameAs']![0]!.value).toEqual({ type: 'value', content: 'https://example.test/album/newer' });
    await click(host, m.catalogue_create_review_new());
    revision = 'replacement-reading';
    await paint();
    await act(async () => currentArtist([selected]));
    expect(row.textContent).not.toContain('Late descriptor');
    const retiredArtist = pickerChange(within(row).getByRole('combobox', { name: name('schema:contributor') }));
    await click(row, m.recipe_remove_field());
    await click(row, m.recipe_remove_field());
    await select(host, m.character_add_fact(), 'schema:contributor');
    await click(host, m.correction_add());
    await act(async () => retiredArtist([selected]));
    expect(host.textContent).not.toContain('Late descriptor');
    holder++;
    await paint();
    await act(async () => retiredArtist([selected]));
    expect(host.querySelector('fieldset[id^="album-row-"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
