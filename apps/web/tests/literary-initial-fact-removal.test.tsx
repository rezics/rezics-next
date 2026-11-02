import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';

test('Literary removal preserves full rows and stable siblings through Cancel, retirement and current locks', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/literary' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
  ])
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { InitialFacts } = await import('../src/features/catalogue/literary-profile-view');
  const { literaryRelease, literaryWords } = await import('../src/kernel/fake/catalogue-literary-profile');
  const { m } = await import('../src/paraglide/messages.js');
  type Row = ComponentProps<typeof InitialFacts>['rows'][number];
  const complete: Row = { id: 'complete', statement: structuredClone(literaryWords) };
  complete.statement.qualifiers = [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }];
  complete.statement.references.push(structuredClone(complete.statement.references[0]!));
  const sibling: Row = {
    id: 'sibling',
    statement: {
      ...structuredClone(literaryWords),
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: 'ja' },
    },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let rows: Row[] = [],
    disabled = false,
    release = literaryRelease;
  const paint = () =>
    root.render(
      <form>
        <input aria-label="Terms" defaultValue="Private title" />
        <InitialFacts
          type="schema:Book"
          read={{ ok: true, release, current: null }}
          locale="en"
          disabled={disabled}
          rows={rows}
          change={(next) => {
            rows = next;
            paint();
          }}
        />
      </form>,
    );
  const render = () => act(async () => paint());
  const region = (row: Row) => host.querySelector<HTMLElement>(`#literary-fact-${row.id}`)!;
  const button = (scope: ParentNode, name: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
  const remove = (row: Row) => button(region(row), m.literary_remove_fact());
  const click = (node: HTMLElement) => act(async () => node.click());
  try {
    for (const citationOnly of [false, true]) {
      const selected = structuredClone(complete);
      if (citationOnly) selected.statement.value = { type: 'value', content: '' };
      rows = [selected, sibling];
      await render();
      const survivor = region(sibling),
        control = survivor.querySelector('input')!;
      const before = structuredClone(rows);
      await click(remove(selected));
      expect(window.document.activeElement).toBe(button(region(selected), m.candidate_cancel()));
      await click(button(region(selected), m.candidate_cancel()));
      expect(rows).toEqual(before);
      expect(window.document.activeElement).toBe(remove(selected));
      await click(remove(selected));
      await act(async () =>
        button(region(selected), m.candidate_cancel()).dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
      expect(window.document.activeElement).toBe(remove(selected));
      await click(remove(selected));
      await click(remove(selected));
      expect(rows).toEqual([before[1]!]);
      expect(region(sibling)).toBe(survivor);
      expect(survivor.querySelector('input')).toBe(control);
      expect(control.id).not.toBe('');
      expect(survivor.contains(window.document.activeElement as unknown as Node)).toBe(true);
      expect(host.querySelector<HTMLInputElement>('[aria-label="Terms"]')!.value).toBe('Private title');
    }
    rows = [complete, sibling];
    await render();
    await click(remove(complete));
    const retained = region(complete),
      before = structuredClone(rows);
    release = structuredClone(literaryRelease);
    delete release.properties['schema:wordCount'];
    await render();
    expect(region(complete)).toBe(retained);
    expect(retained.textContent).toContain(m.correction_stale());
    await click(button(retained, m.candidate_cancel()));
    expect(rows).toEqual(before);
    expect(window.document.activeElement).toBe(remove(complete));
    await click(remove(complete));
    const confirm = remove(complete);
    const handler = Reflect.get(
      confirm,
      Object.keys(confirm).find((key) => key.startsWith('__reactProps$'))!,
    ).onClick;
    disabled = true;
    await render();
    expect(confirm.disabled).toBe(true);
    await act(async () => handler());
    expect(rows).toEqual(before);
    disabled = false;
    await render();
    await click(remove(complete));
    expect(rows).toEqual([sibling]);
    rows = [
      {
        id: 'empty',
        statement: { property: { id: 'schema:wordCount' }, value: { type: 'value', content: '' }, references: [] },
      },
    ];
    await render();
    await click(remove(rows[0]!));
    expect(rows).toEqual([]);
    expect(window.document.activeElement).toBe(host.querySelector('select'));
    expect(button(host, m.candidate_cancel())).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
