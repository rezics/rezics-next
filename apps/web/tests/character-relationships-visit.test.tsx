import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('cloudflare:workers', () => ({ env: {} }));

import {
  appearanceWorkA,
  characterRelationshipsFixture,
  characterRelationshipsId,
  relatedCharacterId,
} from '../src/kernel/fake/character-relationships';
import {
  advanceCharacterRelationshipsCursor,
  characterRelationshipsVisit,
  createCharacterRelationshipsVisit,
  CHARACTER_RELATIONSHIPS_CURSOR_LIMIT,
  type CharacterRelationshipsOrigin,
  type CharacterRelationshipsVisit as Visit,
} from '../src/features/catalogue/character-relationships/navigation';

async function withHost(run: (host: HTMLElement, render: (node: ReactNode) => Promise<void>) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (node: ReactNode) =>
    act(async () =>
      root.render(
        h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, node),
      ),
    );
  try {
    await run(host, render);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('returns retain bounded current addresses, focus only disclosed row keys, and re-read Previous', async () => {
  const origin: CharacterRelationshipsOrigin = {
    id: characterRelationshipsId,
    locale: 'en',
    context: '00000000-0000-4000-8000-0000000000c7',
    stream: 'inverse:schema:character',
  };
  const cursors = Array.from({ length: CHARACTER_RELATIONSHIPS_CURSOR_LIMIT + 2 }, (_, index) => `cursor-${index}`);
  const bounded = cursors.reduce(
    (state, cursor) => advanceCharacterRelationshipsCursor(state.cursors, state.index, cursor),
    { cursors: [null] as (string | null)[], index: 0 },
  );
  expect(bounded.cursors).toEqual(cursors.slice(-CHARACTER_RELATIONSHIPS_CURSOR_LIMIT));
  expect(bounded.index).toBe(CHARACTER_RELATIONSHIPS_CURSOR_LIMIT - 1);
  expect(
    createCharacterRelationshipsVisit(origin, {
      stream: origin.stream,
      work: appearanceWorkA,
      cursors: [null, ...bounded.cursors.slice(1)],
      index: CHARACTER_RELATIONSHIPS_CURSOR_LIMIT - 1,
      focus: { holder: appearanceWorkA, statement: '00000000-0000-4000-8000-0000000000c8' },
    }),
  ).toMatchObject({ work: appearanceWorkA, index: CHARACTER_RELATIONSHIPS_CURSOR_LIMIT - 1 });
  expect(characterRelationshipsVisit({ version: 1 }, origin)).toBeUndefined();

  const fixture = characterRelationshipsFixture('appearances');
  const initial = await fixture.read();
  if (!initial.ok || !initial.stream) throw new Error('Expected the current appearances stream');
  const firstPage = { ...initial, next: 'opaque-next' };
  const reads: (string | undefined)[] = [];
  const savedVisits: Visit[] = [];
  const transport = {
    ...fixture.transport,
    read: async (_stream?: string, cursor?: string) => {
      reads.push(cursor);
      return cursor ? { ...initial, rows: initial.rows.slice(1), next: null } : firstPage;
    },
  };
  const { CharacterRelationshipsView } = await import('../src/features/catalogue/character-relationships/view');
  const { m } = await import('../src/paraglide/messages.js');
  await withHost(async (host, render) => {
    await render(
      h(CharacterRelationshipsView, {
        id: fixture.id,
        locale: 'en',
        transport,
        search: fixture.search,
        initial: firstPage,
        origin,
        saveVisit: (value: Visit) => savedVisits.push(value),
      }),
    );
    const target = host.querySelector<HTMLElement>('[data-relationship-row="0"] a[href*="/subjects/"]');
    if (!target) throw new Error('Expected a disclosed target link');
    await act(async () => {
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      click.preventDefault();
      target.dispatchEvent(click);
    });
    expect(savedVisits.at(-1)?.focus).toEqual({ holder: appearanceWorkA, statement: firstPage.rows[0]?.statementId });
    expect(savedVisits.at(-1)?.cursors).toEqual([null]);
    await act(async () => findButton(host, m.character_relationships_more()).click());
    expect(reads).toEqual(['opaque-next']);
    expect(savedVisits.at(-1)?.cursors).toEqual([null, 'opaque-next']);
    await act(async () => findButton(host, m.character_relationships_previous()).click());
    expect(reads).toEqual(['opaque-next', undefined]);
    expect(savedVisits.at(-1)?.index).toBe(0);
  });

  const changedVisit = createCharacterRelationshipsVisit(origin, {
    stream: initial.stream.key,
    work: relatedCharacterId,
    cursors: [null],
    index: 0,
    focus: { holder: relatedCharacterId, statement: '00000000-0000-4000-8000-0000000000c9' },
  });
  if (!changedVisit) throw new Error('Expected a validated return address');
  const presentVisit = createCharacterRelationshipsVisit(origin, {
    stream: initial.stream.key,
    work: appearanceWorkA,
    cursors: [null],
    index: 0,
    focus: { holder: appearanceWorkA, statement: firstPage.rows[0]!.statementId },
  });
  if (!presentVisit) throw new Error('Expected a validated current row address');
  await withHost(async (host, render) => {
    await render(
      h(CharacterRelationshipsView, {
        id: fixture.id,
        locale: 'en',
        transport: fixture.transport,
        search: fixture.search,
        initial: firstPage,
        origin,
        visit: presentVisit,
      }),
    );
    expect(document.activeElement).toBe(host.querySelector('[data-relationship-row="0"]'));
  });
  await withHost(async (host, render) => {
    await render(
      h(CharacterRelationshipsView, {
        id: fixture.id,
        locale: 'en',
        transport: fixture.transport,
        search: fixture.search,
        initial: firstPage,
        origin,
        visit: changedVisit,
      }),
    );
    expect(host.textContent).toContain(m.character_relationships_return_changed());
    expect(findButton(host, m.character_relationships_return_current())).toBeTruthy();
  });

  const concealed = characterRelationshipsFixture('spoiler');
  const concealedRead = await concealed.read();
  if (!concealedRead.ok) throw new Error('Expected a concealed association');
  await withHost(async (host, render) => {
    await render(
      h(CharacterRelationshipsView, {
        id: concealed.id,
        locale: 'en',
        transport: concealed.transport,
        search: concealed.search,
        initial: concealedRead,
      }),
    );
    const row = host.querySelector<HTMLElement>('[data-relationship-row="0"]');
    expect(row?.getAttribute('aria-label')).toBe(m.character_relationships_concealed_row());
    expect(row?.hasAttribute('aria-labelledby')).toBe(false);
    expect(row?.querySelector('a[href*="/subjects/"]')).toBeNull();
  });
});

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button as HTMLButtonElement;
}
