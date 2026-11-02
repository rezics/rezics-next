import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Release } from '@rezics/definitions';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import definitions from '../src/kernel/recorded/definitions-release.json';

test('Game whole-fact removal preserves complete mounted drafts on Cancel and obeys stable targets and locks', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en/catalogue/game' });
  const globals: Record<string, unknown> = { IS_REACT_ACT_ENVIRONMENT: true, window, document: window.document };
  for (const key of ['navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
    'Element', 'Node', 'Text', 'NodeFilter', 'Document', 'ShadowRoot', 'Event', 'KeyboardEvent', 'FocusEvent',
    'MouseEvent', 'PointerEvent', 'CSS', 'DocumentFragment', 'DOMParser', 'MutationObserver', 'ResizeObserver', 'Range', 'DOMRect'])
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { GameInitialFacts } = await import('../src/features/catalogue/game-profile-fields');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host), release = definitions.release as Release;
  const row = (key: string, content = '', property = 'schema:inLanguage') => ({ key, statement: {
    property: { id: property }, value: { type: 'value', content }, qualifiers: [], references: [], rank: 'normal',
  } as StatementInput });
  const complete = row('complete', 'ja');
  complete.statement.qualifiers = [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'fr' } }];
  complete.statement.references = [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } }] }];
  let rows = [complete], disabled = false, changes = 0;
  const target = { id: '00000000-0000-4000-8000-00000000f103', title: 'Selected platform', types: ['skos:Concept'], typeLabel: 'Concept', cover: null };
  const paint = () => root.render(<form>
    <input aria-label="English name" defaultValue="Game" /><input aria-label="Japanese name" defaultValue="ゲーム" />
    <GameInitialFacts type="schema:VideoGame" release={release} locale="en" search={async () => [target]}
      statements={rows} disabled={disabled} change={(next) => { changes++; rows = next; paint(); }} />
  </form>);
  const render = () => act(async () => paint());
  const region = (key: string) => [...host.querySelectorAll<HTMLElement>('section')].find((section) => section.querySelector(`[id^="game-initial-${key}"]`))!;
  const remove = (key: string) => within(region(key)).getByRole('button', { name: m.recipe_remove_field() });
  const click = (button: HTMLElement) => act(async () => user.click(button));
  try {
    for (const selected of [complete,
      { ...row('qualifier'), statement: { ...row('').statement, qualifiers: complete.statement.qualifiers } },
      { ...row('reference'), statement: { ...row('').statement, references: complete.statement.references } },
      row('item', '', 'schema:gamePlatform'),
    ]) {
      rows = [selected, { ...complete, key: 'sibling' }];
      await render();
      if (selected.key === 'item') {
        const picker = within(region('item')).getByRole('combobox', { name: release.properties['schema:gamePlatform']!.labels.en! });
        await act(async () => user.type(picker, 'platform'));
        await waitFor(() => expect(within(window.document.body).getByRole('option', { name: 'Selected platform Concept' })).toBeDefined());
        await act(async () => user.keyboard('{ArrowDown}{Enter}'));
        expect(rows[0]!.statement.value).toEqual({ type: 'value', content: target.id });
      }
      const snapshot = structuredClone(rows), sibling = region('sibling');
      const controls = [...region(selected.key).querySelectorAll('input, select, textarea, [id]')];
      const siblingControls = [...sibling.querySelectorAll('[id]')];
      await click(remove(selected.key));
      const cancel = within(region(selected.key)).getByRole('button', { name: m.candidate_cancel() });
      expect(window.document.activeElement).toBe(cancel);
      await click(cancel);
      expect(rows).toEqual(snapshot);
      expect(window.document.activeElement).toBe(remove(selected.key));
      expect([...region(selected.key).querySelectorAll('input, select, textarea, [id]')]).toEqual(controls);
      if (selected.key === 'item') expect(within(region('item')).getByRole('combobox').value).toBe('Selected platform');
      await click(remove(selected.key));
      await act(async () => user.keyboard('{Escape}'));
      expect(window.document.activeElement).toBe(remove(selected.key));
      await click(remove(selected.key));
      rows = [rows[1]!, rows[0]!];
      await render();
      await click(remove(selected.key));
      expect(rows).toEqual([snapshot[1]!]);
      expect(region('sibling')).toBe(sibling);
      expect([...sibling.querySelectorAll('[id]')]).toEqual(siblingControls);
      expect(window.document.activeElement).toBe(remove('sibling'));
      expect(within(host).getByRole('textbox', { name: 'Japanese name' }).value).toBe('ゲーム');
      expect(within(host).getByRole('textbox', { name: 'English name' }).value).toBe('Game');
    }
    rows = [complete];
    await render();
    await click(remove('complete'));
    const snapshot = structuredClone(rows), before = changes;
    disabled = true;
    await render();
    expect(remove('complete').disabled).toBe(true);
    // Dispatch bypasses the browser's disabled-click suppression to exercise the current handler guard.
    await act(async () => remove('complete').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(rows).toEqual(snapshot);
    expect(changes).toBe(before);
    disabled = false;
    rows = [row('empty'), complete];
    await render();
    await click(remove('empty'));
    expect(rows).toEqual([complete]);
    expect(region('complete').contains(window.document.activeElement as unknown as Node)).toBe(true);
    rows = [row('empty')];
    await render();
    await click(remove('empty'));
    expect(rows).toEqual([]);
    expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: m.correction_add() }));
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
