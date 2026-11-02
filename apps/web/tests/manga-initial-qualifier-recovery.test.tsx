import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import type { Release } from '@rezics/definitions';
import type { MangaRow } from '../src/features/catalogue/manga-profile-field';
import recorded from '../src/kernel/recorded/definitions-release.json';

test('unsent qualifier correction preserves the assertion, stable controls and sealed confirmation', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/manga' });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
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
    globals[key] = window[key];
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = window[key].bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { MangaInitialField } = await import('../src/features/catalogue/manga-profile-field');
  const { mangaCreateFeedback } = await import('../src/features/catalogue/manga-create-feedback');
  const { newAuthoredField } = await import('../src/features/catalogue/authored-field');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const read = { ok: true as const, release: recorded.release as Release };
  const snak = (id: string, content: string) => ({ property: { id }, value: { type: 'value' as const, content } });
  const target = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Retained creator',
    types: ['schema:Person'],
    typeLabel: 'Person',
    cover: null,
  };
  const initial: MangaRow = {
    id: 'kept',
    original: true,
    authored: newAuthoredField(),
    targets: { 'schema:author': [target], 'wdt:P3831': [{ ...target, title: 'Retained role' }] },
    statement: {
      ...snak('schema:author', target.id),
      rank: 'normal',
      qualifiers: [
        snak('schema:position', ''),
        snak('schema:sameAs', 'https://example.org/credit'),
        snak('wdt:P3831', target.id),
      ],
      references: [{ parts: [snak('schema:url', 'https://example.org/source')] }],
    },
  };
  let current = initial;
  let reject!: () => void;
  const changed = mock();
  const removed = mock();
  function Harness({ disabled }: { disabled: boolean }) {
    const [row, setRow] = useState(initial);
    const [errors, setErrors] = useState([
      { pointer: '/statements/schema:author/0/qualifiers/1/value/content', code: 'invalid_format' as const },
    ]);
    reject = () =>
      setErrors([{ pointer: '/statements/schema:author/0/qualifiers/0/value/content', code: 'invalid_format' }]);
    const feedback = mangaCreateFeedback(errors, [row], [], read, 'en', 'terms', 'schema:ComicSeries');
    return (
      <>
        <MangaInitialField
          row={row}
          read={read}
          type="schema:ComicSeries"
          locale="en"
          search={async () => []}
          disabled={disabled}
          onChange={(next) => {
            changed();
            current = next;
            setRow(next);
            setErrors([]);
          }}
          onRemove={removed}
          feedback={{ id: 'manga-row-kept', errors: feedback }}
        />
        {feedback.map((error) => (
          <a key={error.id} id={error.id} href={`#${error.target}`}>
            {error.label}
          </a>
        ))}
      </>
    );
  }
  const show = (disabled = false) => act(async () => root.render(<Harness disabled={disabled} />));
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const qualifier = (id: string) => host.querySelector<HTMLElement>(`#manga-row-kept-qualifier-${id}`)!;
  const remove = () => m.relation_remove({}, { locale: 'en' });
  const confirm = () => m.contribution_confirm({}, { locale: 'en' });
  const cancel = () => m.action_cancel({}, { locale: 'en' });
  try {
    await show();
    const scalar = qualifier('1').querySelector('input')!;
    const picker = qualifier('2').querySelector('[role="combobox"]')!;
    expect(scalar.getAttribute('aria-invalid')).toBe('true');
    await click(qualifier('0'), remove());
    expect(current.statement).toEqual({ ...initial.statement, qualifiers: initial.statement.qualifiers!.slice(1) });
    expect(current.targets).toBe(initial.targets);
    expect(current.authored).toBe(initial.authored);
    expect(current.original).toBe(true);
    expect(qualifier('1').querySelector('input')).toBe(scalar);
    expect(qualifier('2').querySelector('[role="combobox"]')).toBe(picker);
    expect(host.textContent).toContain('Retained creator');
    expect(host.textContent).toContain('Retained role');
    expect(scalar.hasAttribute('aria-invalid')).toBe(false);
    const add = within(host).getByRole('combobox', { name: m.correction_add_qualifier({}, { locale: 'en' }) });
    expect(window.document.activeElement).toBe(add);
    await act(async () => reject());
    expect(host.querySelector('a')!.getAttribute('href')).toBe(`#${scalar.id}`);
    expect(scalar.getAttribute('aria-describedby')).toBe('terms-error-0');
    await click(qualifier('1'), remove());
    await click(qualifier('1'), cancel());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(window.document.activeElement).toBe(qualifier('1').querySelector('button:last-child'));
    await click(qualifier('1'), remove());
    await show(true);
    await click(qualifier('1'), confirm());
    await click(qualifier('1'), cancel());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(within(qualifier('1')).getByRole('button', { name: confirm() }).matches(':disabled')).toBe(true);
    await show();
    await click(qualifier('1'), confirm());
    expect(current.statement).toEqual({ ...initial.statement, qualifiers: [initial.statement.qualifiers![2]] });
    expect(qualifier('2').querySelector('[role="combobox"]')).toBe(picker);
    expect(window.document.activeElement).toBe(add);
    await act(async () => user.selectOptions(add, 'schema:position'));
    await click(host, m.relation_add_qualifier({}, { locale: 'en' }));
    expect(current.statement.qualifiers!.at(-1)).toEqual(snak('schema:position', ''));
    expect(current.qualifierIds!.at(-1)).not.toBe('0');
    await click(qualifier('2'), remove());
    await click(qualifier('2'), confirm());
    expect(current.targets?.['schema:author']).toBe(initial.targets!['schema:author']);
    expect(current.targets?.['wdt:P3831']).toBeUndefined();
    await act(async () => user.selectOptions(add, 'wdt:P3831'));
    await click(host, m.relation_add_qualifier({}, { locale: 'en' }));
    expect(current.statement.qualifiers!.at(-1)).toEqual(snak('wdt:P3831', ''));
    expect(host.textContent).not.toContain('Retained role');
    expect(removed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
