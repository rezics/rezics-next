import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { MangaRow } from '../src/features/catalogue/manga-profile-field';

test('Manga draft removal preserves complete rows on Cancel, removes only stable selections and obeys sealing', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/manga' });
  const globals: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
  };
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
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { MangaInitialField } = await import('../src/features/catalogue/manga-profile-field');
  const { mangaFixture } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { blankMangaStatement } = await import('../src/features/catalogue/manga-profile');
  const { newAuthoredField } = await import('../src/features/catalogue/authored-field');
  const { fromPlainText } = await import('@rezics/document');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const fixture = mangaFixture();
  const read = { ok: true as const, release: fixture.release, public: null };
  const blank = (id: string, property = 'schema:inLanguage'): MangaRow => ({
    id,
    statement: blankMangaStatement(property),
  });
  let rows: MangaRow[] = [],
    disabled = false,
    changes = 0;
  const paint = () =>
    root.render(
      <form>
        <input aria-label="Name" defaultValue="Shared terms" />
        <div>
          {rows.map((row) => (
            <MangaInitialField
              key={row.id}
              row={row}
              read={read}
              type="schema:ComicSeries"
              locale="en"
              search={async () => []}
              disabled={disabled}
              feedback={{ id: `manga-row-${row.id}`, errors: [] }}
              onChange={(next) => {
                changes++;
                rows = rows.map((item) => (item.id === row.id ? next : item));
                paint();
              }}
              onRemove={() => {
                rows = rows.filter((item) => item.id !== row.id);
                paint();
              }}
            />
          ))}
          <button type="button">Add field</button>
        </div>
      </form>,
    );
  const render = () => act(async () => paint());
  const region = (id: string) => host.querySelector<HTMLElement>(`#manga-row-${id}`)!;
  const click = (scope: HTMLElement, label: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name: label })));
  const variants: MangaRow[] = [
    {
      ...blank('scalar'),
      statement: {
        ...blankMangaStatement('schema:inLanguage'),
        value: { type: 'value', content: 'ja' },
      },
    },
    {
      ...blank('text', 'schema:abstract'),
      authored: {
        ...newAuthoredField(),
        document: fromPlainText('Original text'),
      },
    },
    {
      ...blank('language', 'schema:abstract'),
      authored: { ...newAuthoredField(), language: 'ja' },
    },
    {
      ...blank('licence', 'schema:abstract'),
      authored: { ...newAuthoredField(), licence: 'CC-BY-4.0' },
    },
    { ...blank('original', 'schema:abstract'), original: true },
    {
      ...blank('qualifier'),
      statement: {
        ...blankMangaStatement('schema:inLanguage'),
        qualifiers: [
          {
            property: { id: 'schema:position' },
            value: { type: 'value', content: '' },
          },
        ],
      },
    },
    {
      ...blank('citation'),
      statement: {
        ...blankMangaStatement('schema:inLanguage'),
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.org/source' },
              },
            ],
          },
        ],
      },
    },
  ];
  try {
    for (const selected of variants) {
      rows = [selected, { ...variants[0]!, id: 'sibling' }];
      disabled = false;
      const snapshot = structuredClone(rows);
      await render();
      const sibling = region('sibling');
      await click(region(selected.id), m.recipe_remove_field());
      const cancel = within(region(selected.id)).getByRole('button', {
        name: m.candidate_cancel(),
      });
      expect(window.document.activeElement).toBe(cancel);
      await click(region(selected.id), m.candidate_cancel());
      expect(rows).toEqual(snapshot);
      expect(window.document.activeElement).toBe(
        within(region(selected.id)).getByRole('button', {
          name: m.recipe_remove_field(),
        }),
      );
      await click(region(selected.id), m.recipe_remove_field());
      rows = [rows[1]!, rows[0]!];
      await render();
      expect(region('sibling')).toBe(sibling);
      expect(
        within(region(selected.id)).getByRole('button', {
          name: m.candidate_cancel(),
        }),
      ).toBeDefined();
      await click(region(selected.id), m.recipe_remove_field());
      expect(rows).toEqual([snapshot[1]!]);
      expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: 'Add field' }));
      expect(within(host).getByRole('textbox', { name: 'Name' }).getAttribute('value')).toBe('Shared terms');
    }
    rows = [variants[0]!];
    await render();
    await click(region('scalar'), m.recipe_remove_field());
    disabled = true;
    await render();
    const sealed = structuredClone(rows);
    await click(region('scalar'), m.recipe_remove_field());
    await act(async () =>
      user.type(
        within(region('scalar')).getByRole('textbox', {
          name: m.correction_value(),
        }),
        'en',
      ),
    );
    expect(rows).toEqual(sealed);
    expect(changes).toBe(0);
    expect(
      within(region('scalar')).getByRole('button', { name: m.recipe_remove_field() }).matches(':disabled'),
    ).toBe(true);
    disabled = false;
    await render();
    await act(async () => user.keyboard('{Escape}'));
    expect(
      within(region('scalar')).queryByRole('button', {
        name: m.candidate_cancel(),
      }),
    ).toBeNull();
    rows = [variants[0]!];
    await render();
    await click(region('scalar'), m.recipe_remove_field());
    const button = within(region('scalar')).getByRole('button', {
      name: m.recipe_remove_field(),
    });
    const oldRemoval = Reflect.get(
      button,
      Object.keys(button).find((key) => key.startsWith('__reactProps$'))!,
    ).onClick;
    rows = [
      {
        ...variants[0]!,
        statement: {
          ...variants[0]!.statement,
          value: { type: 'value', content: 'en' },
        },
      },
    ];
    const replacement = structuredClone(rows);
    await render();
    const focus = window.document.activeElement;
    await act(async () => oldRemoval());
    expect(rows).toEqual(replacement);
    expect(window.document.activeElement).toBe(focus);
    expect(
      within(region('scalar')).queryByRole('button', {
        name: m.candidate_cancel(),
      }),
    ).toBeNull();
    rows = [blank('empty', 'schema:abstract')];
    await render();
    await click(region('empty'), m.recipe_remove_field());
    expect(rows).toEqual([]);
    expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: 'Add field' }));
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
