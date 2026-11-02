import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Release } from '@rezics/definitions';
import type { ScreenRow } from '../src/features/catalogue/screen-profile-fields';
import definitions from '../src/kernel/recorded/definitions-release.json';

test('Screen row removal recovers complete drafts, preserves stable siblings and obeys current locks', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en/catalogue/screen' });
  const globals: Record<string, unknown> = { IS_REACT_ACT_ENVIRONMENT: true, window, document: window.document };
  for (const key of ['navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
    'Element', 'Node', 'Text', 'NodeFilter', 'Document', 'ShadowRoot', 'Event', 'KeyboardEvent', 'FocusEvent',
    'MouseEvent', 'PointerEvent', 'CSS', 'DocumentFragment', 'DOMParser', 'MutationObserver', 'ResizeObserver', 'Range', 'DOMRect'])
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globals[key] = Reflect.get(window, key).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { ScreenInitialFields, screenCreationControl, screenRowId } = await import('../src/features/catalogue/screen-profile-fields');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host), release = definitions.release as Release;
  const row = (key: string, content = ''): ScreenRow => ({ key, statement: {
    property: { id: 'schema:inLanguage' }, value: { type: 'value', content }, qualifiers: [], references: [], rank: 'normal',
  } });
  const complete = row('complete', 'ja');
  complete.statement.qualifiers = [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }];
  complete.statement.references = ['first', 'second'].map((name) => ({ parts: [
    { property: { id: 'schema:url' }, value: { type: 'value', content: `https://example.org/${name}` } },
  ] }));
  let rows: ScreenRow[] = [], disabled = false, changes = 0;
  const paint = () => root.render(<form><input aria-label="Name" defaultValue="Sibling terms" />
    <ScreenInitialFields type="schema:Movie" rows={rows} release={release} locale="en" search={async () => []}
      disabled={disabled} change={(next) => { changes++; rows = next; paint(); }} /></form>);
  const render = () => act(async () => paint());
  const region = (item: ScreenRow) => host.querySelector<HTMLElement>(`#${screenRowId(item)}`)!;
  const remove = (item: ScreenRow) => within(region(item)).getAllByRole('button', { name: m.relation_remove() }).at(-1)!;
  const click = (button: HTMLElement) => act(async () => user.click(button));
  const control = (index: number, path: string) => screenCreationControl(`/statements/schema:inLanguage/${index}${path}`, rows, release, 'en')!.id;
  try {
    for (const selected of [complete, { ...complete, key: 'qualifier', statement: { ...complete.statement, value: row('').statement.value, references: [] } },
      { ...complete, key: 'citation', statement: { ...complete.statement, value: row('').statement.value, qualifiers: [] } }]) {
      const sibling = { ...complete, key: 'sibling' };
      rows = [selected, sibling];
      await render();
      const siblingSection = region(sibling);
      const paths = ['/value/content', '/qualifiers/0/value/content', '/references/1/parts/0/value/content'];
      const ids = paths.map((path) => control(1, path));
      const nodes = ids.map((id) => window.document.getElementById(id));
      const value = window.document.getElementById(ids[0]!)! as unknown as HTMLElement;
      await act(async () => { await user.clear(value); await user.type(value, 'fr'); });
      const snapshot = structuredClone(rows);
      await click(remove(selected));
      const cancel = within(region(selected)).getByRole('button', { name: m.candidate_cancel() });
      expect(window.document.activeElement).toBe(cancel);
      await click(cancel);
      expect(rows).toEqual(snapshot);
      expect(window.document.activeElement).toBe(remove(selected));
      await click(remove(selected));
      rows = [rows[1]!, rows[0]!];
      await render();
      await click(remove(selected));
      expect(rows).toEqual([snapshot[1]!]);
      expect(region(sibling)).toBe(siblingSection);
      expect(paths.map((path) => control(0, path))).toEqual(ids);
      expect(ids.map((id) => window.document.getElementById(id))).toEqual(nodes);
      expect(window.document.activeElement).toBe(remove(sibling));
      expect(within(host).getByRole('textbox', { name: 'Name' }).value).toBe('Sibling terms');
    }
    rows = [complete];
    await render();
    await click(remove(complete));
    const sealed = structuredClone(rows), before = changes;
    disabled = true;
    await render();
    expect(remove(complete).disabled).toBe(true);
    await click(remove(complete));
    expect(rows).toEqual(sealed);
    expect(changes).toBe(before);
    disabled = false;
    await render();
    await act(async () => user.keyboard('{Escape}'));
    expect(within(host).queryByRole('button', { name: m.candidate_cancel() })).toBeNull();
    expect(window.document.activeElement).toBe(remove(complete));
    const empty = row('empty');
    rows = [empty, complete];
    await render();
    await click(remove(empty));
    expect(rows).toEqual([complete]);
    expect(region(complete).contains(window.document.activeElement as unknown as Node)).toBe(true);
    rows = [empty];
    await render();
    await click(remove(empty));
    expect(rows).toEqual([]);
    expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: m.correction_add() }));
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
