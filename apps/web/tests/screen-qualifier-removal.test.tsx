import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Release } from '@rezics/definitions';
import type { ScreenRow } from '../src/features/catalogue/screen-profile-fields';
import definitions from '../src/kernel/recorded/definitions-release.json';

test('Screen qualifier removal retains selected drafts, stable siblings, focus and current command locks', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/screen' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
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
  const { ScreenInitialFields, screenCreationControl } =
    await import('../src/features/catalogue/screen-profile-fields');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    release = definitions.release as Release;
  const snak = (id: string, content: string) => ({ property: { id }, value: { type: 'value' as const, content } });
  const initial: ScreenRow = {
    key: 'credit',
    statement: {
      ...snak('schema:director', ''),
      rank: 'normal',
      qualifiers: [snak('schema:position', ''), snak('wdt:P3831', ''), snak('schema:position', '2')],
      references: ['first', 'second'].map((name) => ({ parts: [snak('schema:url', `https://example.org/${name}`)] })),
    },
  };
  const sibling: ScreenRow = {
    key: 'sibling',
    statement: { ...snak('schema:inLanguage', 'ja'), rank: 'normal', references: [] },
  };
  const target = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Retained role',
    types: ['skos:Concept'],
    typeLabel: 'Concept',
    cover: null,
  };
  let rows = [initial, sibling],
    disabled = false,
    changes = 0;
  const paint = () =>
    root.render(
      <ScreenInitialFields
        type="schema:Movie"
        rows={rows}
        release={release}
        locale="en"
        search={async () => [target]}
        disabled={disabled}
        change={(next) => {
          rows = next;
          changes++;
          paint();
        }}
      />,
    );
  const render = () => act(async () => paint());
  const qualifiers = () => [...host.querySelectorAll<HTMLElement>('[data-screen-qualifier]')];
  const remove = (scope: HTMLElement) => within(scope).getByRole('button', { name: m.relation_remove() });
  const click = (element: HTMLElement) => act(async () => user.click(element));
  const address = (path: string) =>
    screenCreationControl(`/statements/schema:director/0${path}`, rows, release, 'en')!.id;
  try {
    await render();
    const [empty, selected, scalar] = qualifiers() as [HTMLElement, HTMLElement, HTMLElement];
    const picker = within(selected).getByRole('combobox');
    await act(async () => {
      await user.type(picker, 'role');
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await click(within(host).getByRole('option', { name: /Retained role/ }));
    const selectedId = address('/qualifiers/1/value/content'),
      scalarId = address('/qualifiers/2/value/content');
    const citationId = address('/references/1/parts/0/value/content');
    const scalarInput = window.document.getElementById(scalarId)! as unknown as HTMLInputElement;
    const citationInput = window.document.getElementById(citationId);
    const snapshot = structuredClone(rows);
    await click(remove(selected));
    const cancel = within(selected).getByRole('button', { name: m.candidate_cancel() });
    expect(window.document.activeElement).toBe(cancel);
    await click(cancel);
    expect(rows).toEqual(snapshot);
    expect(window.document.activeElement).toBe(remove(selected));
    expect(within(selected).getByRole('combobox')).toBe(picker);
    expect(picker.value).toBe('Retained role');
    await click(remove(selected));
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(remove(selected));
    await click(remove(selected));
    await click(remove(empty));
    expect(address('/qualifiers/0/value/content')).toBe(selectedId);
    expect(window.document.activeElement).toBe(picker);
    await act(async () => {
      await user.clear(scalarInput);
      await user.type(scalarInput, '3');
    });
    const retained = rows[0]!.statement;
    await click(remove(selected));
    expect(rows[0]!.statement).toEqual({ ...retained, qualifiers: [retained.qualifiers![1]] });
    expect(rows[0]!.statement.references).toBe(retained.references);
    expect(rows[1]).toBe(sibling);
    expect(address('/qualifiers/0/value/content')).toBe(scalarId);
    expect(window.document.getElementById(scalarId)).toBe(scalarInput);
    expect(window.document.getElementById(citationId)).toBe(citationInput);
    expect(window.document.activeElement).toBe(scalarInput);
    await click(remove(scalar));
    const sealed = structuredClone(rows),
      before = changes;
    disabled = true;
    await render();
    expect(remove(scalar).disabled).toBe(true);
    await click(remove(scalar));
    expect(rows).toEqual(sealed);
    expect(changes).toBe(before);
    disabled = false;
    await render();
    await click(remove(scalar));
    expect(rows[0]!.statement.qualifiers).toEqual([]);
    expect(window.document.activeElement).toBe(host.querySelector('section [role="combobox"]'));
    rows = [initial, sibling];
    disabled = true;
    await render();
    await click(remove(qualifiers()[1]!));
    expect(rows).toEqual([initial, sibling]);
    expect(within(host).queryByRole('button', { name: m.candidate_cancel() })).toBeNull();
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
