import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';

test('retired Manga facts stay inspectable and local removal preserves every other draft', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/manga' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
    'Element', 'Node', 'Text', 'NodeFilter', 'Document', 'ShadowRoot', 'Event', 'KeyboardEvent', 'FocusEvent',
    'MouseEvent', 'PointerEvent', 'CSS', 'DocumentFragment', 'DOMParser', 'MutationObserver', 'ResizeObserver',
    'Range', 'DOMRect',
  ]) globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
  const { mangaFixture } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const fixture = mangaFixture();
  const authorId = '00000000-0000-4000-8000-00000000a001';
  const search = async () => [{ id: authorId, title: 'Retained author label', types: ['schema:Person'] }];
  const show = (session = 'signed-in') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MangaProfileEditor locale="en" session={session} transport={fixture.transport} search={search} />
        </QueryClientProvider>,
      ),
    );
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(predicate()).toBe(true);
  };
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const select = (scope: HTMLElement, name: string, value: string) =>
    act(async () => user.selectOptions(within(scope).getByRole('combobox', { name }), value));
  const input = (scope: HTMLElement, name: string) => within(scope).getByRole('textbox', { name }) as HTMLInputElement;
  const replace = (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      if (value) await user.type(control, value);
    });
  const title = (property: string) => fixture.release.properties[property]!.labels.en!;
  const add = async (scope: HTMLElement, group: string, property: string) => {
    const picker = within(scope).getByRole('combobox', { name: group });
    await select(scope, group, property);
    await click(picker.closest('section')!, m.correction_add());
    return within(scope).getByRole('region', { name: title(property) });
  };

  try {
    await show();
    await until(() => !!host.querySelector('select') && !(host.querySelector('fieldset') as HTMLFieldSetElement).disabled);
    await replace(input(host, m.catalogue_create_label()), 'Retained series draft');
    const author = await add(host, m.manga_creators(), 'schema:author');
    const target = within(author).getByRole('combobox', { name: title('schema:author') });
    await act(async () => user.type(target, 'Retained'));
    await until(
      () =>
        within(window.document.body as unknown as HTMLElement).queryByRole('option', {
          name: 'Retained author label',
        }) !== null,
    );
    await act(async () => {
      target.focus();
      await user.keyboard('{ArrowDown}{Enter}');
    });
    await select(author, m.correction_add_qualifier(), 'schema:position');
    await click(author, m.relation_add_qualifier());
    await replace(input(author, m.correction_value()), '2');
    await replace(input(author, m.relation_citation()), 'https://example.org/retired-citation');
    const seriesLanguage = await add(host, m.manga_publication(), 'schema:inLanguage');
    await replace(input(seriesLanguage, m.correction_value()), 'ja');
    await select(host, m.manga_grain(), 'schema:PublicationVolume');
    const sibling = await add(host, m.manga_publication(), 'schema:isbn');
    await replace(input(sibling, m.correction_value()), '9781234567897');
    await select(host, m.manga_grain(), 'schema:ComicSeries');

    fixture.release.types['schema:ComicSeries']!.properties = fixture.release.types[
      'schema:ComicSeries'
    ]!.properties.filter((id) => id !== 'schema:author');
    await click(host, m.manga_title());
    await until(() => host.textContent!.includes(m.correction_stale()));
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const panel = window.document.getElementById(author.id)! as unknown as HTMLElement;
    const snapshot = panel.querySelector('pre')!.textContent!;
    expect(snapshot).toContain('schema:author');
    expect(snapshot).toContain('schema:position');
    expect(snapshot).toContain(authorId);
    expect(snapshot).toContain('https://example.org/retired-citation');
    expect(panel.textContent).not.toContain('Retained author label');
    expect(panel.textContent).toContain(m.correction_stale());
    const feedback = host.querySelector<HTMLAnchorElement>(`a[href="#${author.id}"]`)!;
    expect(feedback).not.toBeNull();

    const remove = m.recipe_remove_field();
    await click(panel, remove);
    expect(window.document.activeElement).toBe(within(panel).getByRole('button', { name: m.candidate_cancel() }));
    await click(panel, m.candidate_cancel());
    expect(window.document.getElementById(author.id)).toBe(panel);
    expect(panel.querySelector('pre')!.textContent).toBe(snapshot);
    expect(host.querySelector(`a[href="#${author.id}"]`)).toBe(feedback);
    await click(panel, remove);
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(within(panel).getByRole('button', { name: remove }));
    expect(window.document.getElementById(author.id)).toBe(panel);

    await click(panel, remove);
    await show('signed-out');
    expect(within(panel).getByRole('button', { name: remove }).matches(':disabled')).toBe(true);
    expect(window.document.getElementById(author.id)).toBe(panel);
    await show();
    await click(panel, m.candidate_cancel());
    const callsBeforeRemoval = fixture.calls.length;
    await click(panel, remove);
    await click(panel, remove);
    expect(window.document.getElementById(author.id)).toBeNull();
    expect(window.document.activeElement).toBe(within(host).getByRole('button', { name: m.manga_title() }));
    expect(within(host).getByRole('region', { name: title('schema:isbn') })).toBe(sibling);
    expect(fixture.calls).toHaveLength(callsBeforeRemoval);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await select(host, m.manga_grain(), 'schema:ComicSeries');
    expect(input(within(host).getByRole('region', { name: title('schema:inLanguage') }), m.correction_value()).value).toBe('ja');
    expect(input(host, m.catalogue_create_label()).value).toBe('Retained series draft');
    await select(host, m.manga_grain(), 'schema:PublicationVolume');
    expect(input(within(host).getByRole('region', { name: title('schema:isbn') }), m.correction_value()).value).toBe('9781234567897');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
