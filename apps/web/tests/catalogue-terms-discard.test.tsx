import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';

test('language-local discard preserves other edits and seals recovery commands', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/example/terms' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { SubjectTermsPage } = await import('../src/features/catalogue/subject-terms-page');
  const { catalogueTermsFixture, termsSubjectId } = await import('../src/kernel/fake/catalogue-terms');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  const control = (text: string) =>
    document.getElementById(
      [...host.querySelectorAll('label')].find((node) => node.textContent === text)!.htmlFor,
    )! as HTMLInputElement;
  const click = (text: string) =>
    act(async () => {
      await user.click(button(text));
    });
  const select = (node: Element, value: string) =>
    act(async () => {
      await user.selectOptions(node, value);
    });
  const type = (text: string, value: string) =>
    act(async () => {
      await user.type(control(text), value);
    });
  const mode = (index: number) => host.querySelectorAll('fieldset select')[index]!;
  const summary = () => host.querySelector('section[aria-labelledby$="-unsaved"]')!.textContent;
  try {
    for (const scenario of ['uncertain', 'stale'] as const) {
      const fixture = catalogueTermsFixture(scenario);
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <SubjectTermsPage
              key={scenario}
              id={termsSubjectId}
              locale="en"
              session="signed-in"
              transport={fixture.transport}
            />
          </QueryClientProvider>,
        ),
      );
      for (let attempt = 0; attempt < 50 && !host.querySelector('fieldset'); attempt++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      expect(summary()).toContain(m.catalogue_terms_no_edits());
      await select(mode(0), 'set');
      await type(m.catalogue_create_label(), ' edited');
      await select(control(m.catalogue_create_language()), 'ja');
      await select(mode(1), 'remove');
      expect(summary()).toContain('en');
      expect(summary()).toContain('ja');
      await click('en'); // Summary controls return to the language to review it.
      await click(m.catalogue_terms_discard_language({ language: 'en' }));
      expect(summary()).not.toContain('en');
      expect(summary()).toContain('ja');
      expect(control(m.catalogue_terms_action()).value).toBe('keep');
      expect(button(m.catalogue_create_remove_language())).toBeUndefined();
      await type(m.catalogue_terms_new_language(), 'it');
      await click(m.catalogue_create_add_language());
      await select(mode(2), 'set');
      await type(m.catalogue_create_aliases(), 'Primo');
      await click(m.catalogue_terms_discard_language({ language: 'it' }));
      expect(summary()).not.toContain('it');
      expect(button(m.catalogue_create_remove_language()).disabled).toBe(false);
      await select(control(m.catalogue_create_language()), 'ja');
      await select(control(m.catalogue_create_language()), 'it'); // Empty added languages persist.
      await click(m.catalogue_create_remove_language());
      expect([...host.querySelectorAll('select')][0]!.textContent).not.toContain('it');
      expect(fixture.calls.map((call) => call.method)).toEqual(['GET']);
      await type(m.catalogue_terms_new_language(), 'it');
      await click(m.catalogue_create_add_language());
      await select(mode(0), 'set');
      await type(m.catalogue_create_label(), 'Titolo');
      await click(m.catalogue_terms_save());
      const original = structuredClone(fixture.calls[1]!);
      expect(original.body).toEqual({ labels: { it: 'Titolo' }, descriptions: { ja: null } });
      expect(button(m.catalogue_terms_discard_language({ language: 'it' })).disabled).toBe(true);
      expect(button(m.catalogue_create_remove_language()).disabled).toBe(true);
      await click(m.catalogue_terms_discard_language({ language: 'it' }));
      await click(m.catalogue_create_remove_language());
      expect(fixture.calls).toHaveLength(2);
      if (scenario === 'stale') {
        await click(m.catalogue_terms_compare());
        expect(button(m.catalogue_terms_discard_language({ language: 'it' })).disabled).toBe(true);
        expect(button(m.catalogue_create_remove_language()).disabled).toBe(true);
        await click(m.catalogue_terms_confirm());
        expect(fixture.calls[3]).toMatchObject({ ...original, etag: '"8"', key: expect.any(String) });
        expect(fixture.calls[3]!.key).not.toBe(original.key);
      } else {
        await click(m.catalogue_create_retry());
        expect(fixture.calls[2]).toEqual(original);
      }
      expect(host.textContent).toContain(m.catalogue_terms_saved());
      expect(fixture.subject.labels.en).toBe('Original film');
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
