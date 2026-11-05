import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Release } from '@rezics/definitions';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import type { AlbumCommand } from '../src/features/catalogue/album-profile';
import definitions from '../src/kernel/recorded/definitions-release.json';

test('Album and Game reconcile offered choices without reviving intent or changing authored rows and locks', async () => {
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
  const { GameInitialFacts } = await import('../src/features/catalogue/game-profile-fields');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', testing));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testing));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    client = new QueryClient();
  const property = 'schema:inLanguage';
  try {
    for (const album of [true, false]) {
      const type = album ? 'schema:MusicAlbum' : 'schema:VideoGame';
      let release = structuredClone(definitions.release) as Release,
        disabled = false;
      let rows: { key: string; statement: StatementInput }[] = [];
      const commands: AlbumCommand[] = [];
      const paint = () =>
        root.render(
          <QueryClientProvider client={client}>
            {album ? (
              <AlbumProfileCreate
                release={release}
                metadataCurrent={() => true}
                onReload={async () => {}}
                locale="en"
                enabled={!disabled}
                search={async () => []}
                transport={{
                  load: async () => ({ ok: true, release, public: null }),
                  read: async () => ({ state: 'unavailable' }),
                  create: async (command) => {
                    if (!commands.length) Object.assign(command, { credential: 'original-credential' });
                    commands.push(command);
                    return { ok: false, reason: 'unavailable' };
                  },
                }}
              />
            ) : (
              <>
                <input aria-label="Retained names" defaultValue="Game · ゲーム" />
                <GameInitialFacts
                  type={type}
                  release={release}
                  locale="en"
                  search={async () => []}
                  statements={rows}
                  disabled={disabled}
                  change={(next) => {
                    rows = next;
                    paint();
                  }}
                />
              </>
            )}
          </QueryClientProvider>,
        );
      const render = () => act(async () => paint());
      const chooser = () => within(host).getByRole('combobox', { name: m.character_add_fact() }) as HTMLSelectElement;
      const add = () =>
        within(host).getByRole('button', { name: m.correction_add(), exact: true }) as HTMLButtonElement;
      const select = () => act(async () => user.selectOptions(chooser(), property));
      const clickAdd = () => act(async () => user.click(add()));
      const facts = () => [
        ...host.querySelectorAll<HTMLElement>(album ? 'fieldset[id^="album-row-"]' : '[data-slot="game-initial-fact"]'),
      ];
      await render();
      if (album)
        await act(async () =>
          user.type(
            within(host).getByRole('textbox', { name: m.catalogue_create_label(), exact: true }),
            'Album · アルバム',
          ),
        );
      await select();
      await clickAdd();
      const first = facts()[0]!;
      await act(async () =>
        user.type(within(first).getByRole('textbox', { name: m.correction_value(), exact: true }), 'ja'),
      );
      const controls = [...first.querySelectorAll('input, textarea, select')];
      await select();
      release = structuredClone(release);
      release.properties[property]!.multivalued = false;
      await render();
      expect(chooser().value).toBe('');
      expect(add().disabled).toBe(true);
      expect([...chooser().options].some((option) => option.value === property)).toBe(false);
      expect(within(host).getByText(m.initial_field_choice_withdrawn())).toBeDefined();
      expect(chooser().getAttribute('aria-describedby')).toBeTruthy();
      release = structuredClone(release);
      release.properties[property]!.multivalued = true;
      await render();
      expect(chooser().value).toBe('');
      expect(add().disabled).toBe(true);
      await select();
      await clickAdd();
      expect(facts()).toHaveLength(2);
      expect(facts()[0]).toBe(first);
      expect([...first.querySelectorAll('input, textarea, select')]).toEqual(controls);
      expect((controls[0] as HTMLInputElement).value).toBe('ja');
      await select();
      const original = release;
      release = structuredClone(release);
      release.types[type]!.properties = release.types[type]!.properties.filter((id) => id !== property);
      await render();
      expect(chooser().value).toBe('');
      expect(add().disabled).toBe(true);
      expect(facts()).toHaveLength(2);
      release = original;
      await render();
      expect(chooser().value).toBe('');
      expect(add().disabled).toBe(true);
      await select();
      disabled = true;
      await render();
      expect(chooser().matches(':disabled')).toBe(true);
      expect(add().matches(':disabled')).toBe(true);
      await clickAdd();
      expect(facts()).toHaveLength(2);
      disabled = false;
      await render();
      expect(add().disabled).toBe(false);
      if (album) {
        await act(async () =>
          user.type(within(facts()[1]!).getByRole('textbox', { name: m.correction_value(), exact: true }), 'fr'),
        );
        const submit = () =>
          act(async () => {
            host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
          });
        await submit();
        expect(commands).toHaveLength(1);
        const sealed = structuredClone(commands[0]);
        expect(add().matches(':disabled')).toBe(true);
        await clickAdd();
        await submit();
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual(sealed);
        expect(facts()).toHaveLength(2);
        expect(within(host).getByRole('textbox', { name: m.catalogue_create_label(), exact: true }).value).toBe(
          'Album · アルバム',
        );
      } else {
        const authored = structuredClone(rows);
        rows = Array.from({ length: 32 }, (_, index) => ({ ...authored[index % 2]!, key: `slot-${index}` }));
        await render();
        expect(chooser().value).toBe(property);
        expect(add().disabled).toBe(true);
        await clickAdd();
        expect(rows).toHaveLength(32);
        expect(within(host).getByRole('textbox', { name: 'Retained names' }).value).toBe('Game · ゲーム');
      }
      await act(async () => root.render(null));
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
