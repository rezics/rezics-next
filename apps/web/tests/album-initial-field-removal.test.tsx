import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AlbumCommand } from '../src/features/catalogue/album-profile';
import type { CreateResult } from '../src/features/catalogue/create-subject';

test('Album removal preserves populated drafts and correction identities, restores focus and respects sealed commands', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/album' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Text',
    'NodeFilter',
    'Document',
    'ShadowRoot',
    'Event',
    'KeyboardEvent',
    'FocusEvent',
    'MouseEvent',
    'PointerEvent',
    'CSS',
    'DocumentFragment',
    'DOMParser',
    'MutationObserver',
    'ResizeObserver',
    'Range',
    'DOMRect',
  ])
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { AlbumProfileCreate } = await import('../src/features/catalogue/album-profile-create');
  const { albumFixture, artistId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    fixture = albumFixture(),
    commands: AlbumCommand[] = [];
  let enabled = true,
    finish!: (result: CreateResult) => void;
  const transport = {
    ...fixture.transport,
    create: (command: AlbumCommand) => {
      commands.push(command);
      return new Promise<CreateResult>((resolve) => {
        finish = resolve;
      });
    },
  };
  const render = () =>
    act(async () =>
      root.render(
        <AlbumProfileCreate
          release={fixture.release}
          metadataCurrent={() => true}
          onReload={async () => {}}
          locale="en"
          enabled={enabled}
          transport={transport}
          search={async () => [
            { id: artistId, title: 'Selected artist', types: ['schema:Organization'], typeLabel: '', cover: null },
          ]}
        />,
      ),
    );
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const select = (scope: HTMLElement, name: string, value: string) =>
    act(async () => user.selectOptions(within(scope).getByRole('combobox', { name }), value));
  const type = (scope: HTMLElement, name: string, value: string) =>
    act(async () => user.type(within(scope).getByRole('textbox', { name }), value));
  const add = async () => {
    await select(host, m.character_add_fact(), 'schema:contributor');
    await click(host, m.correction_add());
    return [...host.querySelectorAll<HTMLElement>('fieldset[id^="album-row-"]')].at(-1)!;
  };
  const qualifier = async (row: HTMLElement) => {
    await select(row, m.relation_qualifier(), 'wdt:P1932');
    await type(row, fixture.release.properties['wdt:P1932']!.labels.en!, 'Credited name');
  };
  const pick = async (row: HTMLElement) => {
    await act(async () =>
      user.type(
        within(row).getByRole('combobox', { name: fixture.release.properties['schema:contributor']!.labels.en! }),
        'Selected',
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
    expect(row.textContent).toContain('Selected artist');
  };
  try {
    await render();
    await type(host, m.catalogue_create_label(), 'Shared Album terms');
    const empty = await add();
    await click(empty, m.recipe_remove_field());
    expect(empty.isConnected).toBe(false);
    expect(window.document.activeElement?.id).toBe('album-field');
    const complete = await add();
    await pick(complete);
    await qualifier(complete);
    await type(complete, m.relation_citation(), 'https://example.org/credit');
    const citation = await add();
    await type(citation, m.relation_citation(), 'https://example.org/source');
    const qualified = await add();
    await qualifier(qualified);
    await click(host, m.album_create()); // Local validation supplies stable correction targets for blank main values.
    const corrections = [...host.querySelectorAll<HTMLAnchorElement>('a[href^="#album-row-"]')].map(
      (link) => link.hash,
    );
    expect(corrections.some((hash) => hash.startsWith(`#${citation.id}`))).toBe(true);
    for (const row of [complete, citation, qualified]) {
      const snapshot = row.innerHTML;
      await click(row, m.recipe_remove_field());
      expect(window.document.activeElement).toBe(within(row).getByRole('button', { name: m.candidate_cancel() }));
      await click(row, m.candidate_cancel());
      expect(row.innerHTML).toBe(snapshot);
      expect(window.document.activeElement).toBe(within(row).getByRole('button', { name: m.recipe_remove_field() }));
    }
    await click(complete, m.recipe_remove_field());
    await click(complete, m.recipe_remove_field());
    expect(complete.isConnected).toBe(false);
    expect(citation.isConnected && qualified.isConnected).toBe(true);
    expect(citation.contains(window.document.activeElement as unknown as Node)).toBe(true);
    expect([...host.querySelectorAll<HTMLAnchorElement>('a[href^="#album-row-"]')].map((link) => link.hash)).toEqual(
      corrections,
    );
    expect(within(host).getByRole('textbox', { name: m.catalogue_create_label() }).getAttribute('value')).toBe(
      'Shared Album terms',
    );
    for (const row of [citation, qualified]) {
      await click(row, m.recipe_remove_field());
      await click(row, m.recipe_remove_field());
      expect(row.isConnected).toBe(false);
    }
    expect(window.document.activeElement?.id).toBe('album-field');
    const sealed = await add();
    await pick(sealed);
    await qualifier(sealed);
    await type(sealed, m.relation_citation(), 'https://example.org/sealed');
    await click(sealed, m.recipe_remove_field());
    enabled = false;
    await render();
    await click(sealed, m.recipe_remove_field());
    expect(sealed.isConnected).toBe(true);
    enabled = true;
    await render();
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(within(sealed).getByRole('button', { name: m.recipe_remove_field() }));
    await click(sealed, m.recipe_remove_field());
    await click(host, m.album_create());
    expect(commands).toHaveLength(1);
    await click(sealed, m.recipe_remove_field());
    expect(sealed.isConnected).toBe(true);
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    await click(sealed, m.recipe_remove_field());
    expect(sealed.isConnected).toBe(true);
    await click(host, m.catalogue_create_retry());
    expect(commands[1]).toBe(commands[0]);
    expect(commands[0]!.item.statements['schema:contributor']![0]).toMatchObject({
      value: { content: artistId },
      qualifiers: [{ value: { content: 'Credited name' } }],
      references: [{ parts: [{ value: { content: 'https://example.org/sealed' } }] }],
    });
    await act(async () => finish({ ok: true, id: artistId, reader: { state: 'unavailable' } }));
    expect(host.querySelector('form')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
