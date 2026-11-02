import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Release } from '@rezics/definitions';
import type { ScreenRow } from '../src/features/catalogue/screen-profile-fields';
import definitions from '../src/kernel/recorded/definitions-release.json';

test('Screen citation removal preserves private drafts, stable targets, focus and command locks', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/screen' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLTextAreaElement HTMLButtonElement Element Node Text NodeFilter Document ShadowRoot Event KeyboardEvent FocusEvent MouseEvent PointerEvent CSS DocumentFragment DOMParser MutationObserver ResizeObserver Range DOMRect'.split(
    ' ',
  ))
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
    key: 'draft',
    statement: {
      ...snak('schema:inLanguage', 'ja'),
      rank: 'normal',
      qualifiers: [snak('schema:position', '2')],
      references: [
        {
          parts: ['', 'https://example.org/selected']
            .map((url) => snak('schema:url', url))
            .concat(snak('schema:name', 'Source')),
        },
        { parts: [snak('schema:name', 'Unrelated source')] },
        { parts: [snak('schema:url', 'https://example.org/survivor')] },
      ],
    },
  };
  const sibling = { ...initial, key: 'sibling', statement: { ...initial.statement, references: [] } };
  let rows = [initial, sibling],
    disabled = false,
    changes = 0;
  const props = { type: 'schema:Movie', release, locale: 'en', search: async () => [] };
  const change = (next: ScreenRow[]) => {
    rows = next;
    changes++;
    paint();
  };
  const paint = () => root.render(<ScreenInitialFields {...props} rows={rows} disabled={disabled} change={change} />);
  const render = () => act(async () => paint());
  const remove = (scope: HTMLElement) => within(scope).getByRole('button', { name: m.relation_remove() });
  const click = (element: HTMLElement) => act(async () => user.click(element));
  const address = (path: string) =>
    screenCreationControl(`/statements/schema:inLanguage/0${path}`, rows, release, 'en')!.id;
  try {
    await render();
    const [empty, selected, survivor] = [...host.querySelectorAll<HTMLElement>('[data-screen-citation]')] as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    const selectedId = address('/references/0/parts/1/value/content'),
      survivorId = address('/references/2/parts/0/value/content'),
      qualifierId = address('/qualifiers/0/value/content');
    const selectedInput = window.document.getElementById(selectedId)! as unknown as HTMLInputElement;
    const survivorInput = window.document.getElementById(survivorId),
      qualifierInput = window.document.getElementById(qualifierId);
    await click(remove(selected));
    const cancel = within(selected).getByRole('button', { name: m.candidate_cancel() });
    expect(window.document.activeElement).toBe(cancel);
    await click(cancel);
    expect(rows[0]).toBe(initial);
    expect(window.document.getElementById(selectedId)).toBe(selectedInput);
    expect(window.document.activeElement).toBe(remove(selected));
    await click(remove(selected));
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(remove(selected));
    await click(remove(selected));
    await click(remove(empty));
    expect(address('/references/0/parts/0/value/content')).toBe(selectedId);
    expect(window.document.activeElement).toBe(selectedInput);
    await act(async () => {
      await user.clear(selectedInput);
      await user.type(selectedInput, 'https://example.org/edited');
    });
    const retained = rows[0]!.statement;
    await click(remove(selected));
    expect(rows[0]!.statement).toEqual({
      ...retained,
      references: [
        { ...retained.references[0], parts: [retained.references[0]!.parts[1]] },
        ...retained.references.slice(1),
      ],
    });
    expect(rows[0]!.statement.qualifiers).toBe(retained.qualifiers);
    expect(rows[0]!.statement.references[1]).toBe(retained.references[1]);
    expect(rows[1]).toBe(sibling);
    expect(window.document.getElementById(qualifierId)).toBe(qualifierInput);
    expect(window.document.getElementById(survivorId)).toBe(survivorInput);
    expect(window.document.activeElement).toBe(survivorInput);
    await click(remove(survivor));
    const sealed = rows,
      before = changes;
    disabled = true;
    await render();
    expect(remove(survivor).disabled).toBe(true);
    await click(remove(survivor));
    expect(rows).toBe(sealed);
    expect(changes).toBe(before);
    disabled = false;
    await render();
    const fieldset = host.querySelector('fieldset')!;
    fieldset.disabled = true;
    await act(async () => {
      remove(survivor).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(rows).toBe(sealed);
    fieldset.disabled = false;
    await click(remove(survivor));
    expect(rows[0]!.statement.references).toEqual(sealed[0]!.statement.references.slice(0, 2));
    expect(window.document.activeElement).toBe(window.document.getElementById(address('/value/content')));
    const scaffold = host.querySelector<HTMLInputElement>('[data-screen-citation] input')!;
    await act(async () => user.type(scaffold, 'https://example.org/new'));
    await act(async () => user.clear(scaffold));
    expect(host.querySelector('[data-screen-citation] input')).toBe(scaffold);
    expect(rows[0]!.statement.references.at(-1)!.parts[0]!.value).toEqual({ type: 'value', content: '' });
    await click(remove(scaffold.closest('[data-screen-citation]')!));
    expect(rows[0]!.statement.references).toEqual(sealed[0]!.statement.references.slice(0, 2));
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
