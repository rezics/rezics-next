import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';

// Authored UNRUN: mounted production interactions and native-shaped call witnesses,
// not native execution, geometry, SSR privacy or whole-feature acceptance proof.
test('independent Terms forms retain stable associations, multilingual drafts and exact recovery commands', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/example/terms', width: 390, height: 844 });
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const first = catalogueTermsFixture('stale');
  const second = catalogueTermsFixture('uncertain');
  const longName = `A long supplied name ${'星'.repeat(220)}`;
  const longAlias = `An unbroken alias ${'a'.repeat(220)}`;
  first.subject.labels.en = longName;
  first.subject.aliases.en = [longAlias, 'Second original alias'];
  const typeLabels = { 'schema:Movie': `Movie ${'long supplied type '.repeat(20)}` };
  const render = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SubjectTermsPage
            id={termsSubjectId}
            locale="en"
            session="signed-in"
            transport={first.transport}
            typeLabels={typeLabels}
          />
          <SubjectTermsPage id={termsSubjectId} locale="en" session="signed-in" transport={second.transport} />
        </QueryClientProvider>,
      ),
    );
  const fieldset = (scope: HTMLElement, name: string) =>
    [...scope.querySelectorAll('fieldset')].find((element) => element.querySelector('legend')?.textContent === name)!;
  const label = (scope: HTMLElement, name: string) =>
    [...scope.querySelectorAll('label')].find((element) => element.textContent === name)!;
  const control = (scope: HTMLElement, name: string) =>
    document.getElementById(label(scope, name).htmlFor)! as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const button = (scope: HTMLElement, name: string) =>
    [...scope.querySelectorAll('button')].find((element) => element.textContent === name)!;
  const click = (scope: HTMLElement, name: string) =>
    act(async () => {
      await user.click(button(scope, name));
    });
  const select = (scope: HTMLElement, name: string, value: string) =>
    act(async () => {
      await user.selectOptions(control(scope, name), value);
    });
  const replace = (scope: HTMLElement, name: string, value: string) =>
    act(async () => {
      await user.clear(control(scope, name));
      if (value) await user.type(control(scope, name), value);
    });
  const ids = () => [...host.querySelectorAll('[id]')].map((element) => element.id).sort();
  const associations = (scope: HTMLElement) => {
    for (const element of scope.querySelectorAll('label')) {
      expect(element.htmlFor).not.toBe('');
      expect(scope.contains(document.getElementById(element.htmlFor))).toBe(true);
    }
    for (const element of scope.querySelectorAll('[aria-describedby], [aria-labelledby]')) {
      for (const attribute of ['aria-describedby', 'aria-labelledby']) {
        for (const id of element.getAttribute(attribute)?.split(' ').filter(Boolean) ?? []) {
          expect(scope.contains(document.getElementById(id))).toBe(true);
        }
      }
    }
    expect(new Set(ids()).size).toBe(ids().length);
  };
  try {
    await render();
    for (let attempt = 0; attempt < 50 && host.querySelectorAll('fieldset').length !== 6; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(host.querySelectorAll('fieldset')).toHaveLength(6);
    const [left, right] = [...host.querySelectorAll<HTMLElement>('article')];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    const a = left!;
    const b = right!;
    expect(first.calls.map((call) => call.method)).toEqual(['GET']);
    expect(second.calls.map((call) => call.method)).toEqual(['GET']);
    expect(a.textContent).toContain(longName);
    expect(a.textContent).toContain(longAlias);
    expect(a.textContent).toContain(typeLabels['schema:Movie']);
    expect(a.querySelectorAll('fieldset')).toHaveLength(3);
    expect(a.querySelectorAll('li')).toHaveLength(0); // A form keeps native form semantics.
    expect(a.textContent).toContain(m.catalogue_terms_no_edits());
    expect(a.textContent).toContain(m.catalogue_terms_original());
    expect(a.textContent).toContain(m.creator_editions_draft());
    associations(a);
    associations(b);
    const initialIds = ids();
    await render();
    expect(ids()).toEqual(initialIds);
    // Every mounted label focuses its own native control, even for identical Subjects.
    for (const scope of [a, b]) {
      for (const element of scope.querySelectorAll('label')) {
        await act(async () => {
          await user.click(element);
        });
        expect(document.activeElement).toBe(document.getElementById(element.htmlFor));
      }
    }
    await act(async () => {
      control(a, m.catalogue_create_language()).focus();
      await user.tab();
    });
    expect(document.activeElement).toBe(control(a, m.catalogue_terms_new_language()));
    const nameA = fieldset(a, m.catalogue_create_label());
    const nameB = fieldset(b, m.catalogue_create_label());
    await select(nameA, m.catalogue_terms_action(), 'set');
    await select(nameB, m.catalogue_terms_action(), 'set');
    const nameId = control(nameA, m.catalogue_create_label()).id;
    await replace(nameA, m.catalogue_create_label(), '');
    await click(a, m.catalogue_terms_save());
    const invalidName = control(nameA, m.catalogue_create_label());
    expect(invalidName.getAttribute('aria-invalid')).toBe('true');
    const errorId = invalidName.getAttribute('aria-describedby')!;
    expect(a.contains(document.getElementById(errorId))).toBe(true);
    expect(document.getElementById(errorId)!.textContent).toBe(m.catalogue_terms_validation_name());
    expect(control(nameA, m.catalogue_terms_action()).getAttribute('aria-describedby')).toBe(errorId);
    expect(control(nameB, m.catalogue_create_label()).getAttribute('aria-invalid')).toBe('false');
    expect(b.textContent).not.toContain(m.catalogue_terms_validation_name());
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    associations(a);
    associations(b);
    const invalidIds = ids();
    await render();
    expect(ids()).toEqual(invalidIds);
    await act(async () => {
      await user.click(label(nameA, m.catalogue_create_label()));
    });
    expect(document.activeElement).toBe(invalidName);
    await replace(nameA, m.catalogue_create_label(), 'First draft');
    expect(document.getElementById(errorId)).toBeNull();
    expect(control(nameA, m.catalogue_create_label()).id).toBe(nameId);
    expect(control(nameB, m.catalogue_create_label()).value).toBe('Original film');
    // Adding a language and switching back preserves that form's drafts and alias order.
    await replace(a, m.catalogue_terms_new_language(), 'it');
    await click(a, m.catalogue_create_add_language());
    expect(a.textContent).toContain(m.catalogue_terms_empty());
    expect(control(b, m.catalogue_create_language()).value).toBe('en');
    const aliasesA = fieldset(a, m.catalogue_create_aliases());
    await select(aliasesA, m.catalogue_terms_action(), 'set');
    await replace(aliasesA, m.catalogue_create_aliases(), 'Primo\nPrimo');
    await click(a, m.catalogue_terms_save());
    const aliasErrorIds = control(aliasesA, m.catalogue_create_aliases()).getAttribute('aria-describedby')!.split(' ');
    expect(aliasErrorIds).toHaveLength(2);
    for (const id of aliasErrorIds) expect(a.contains(document.getElementById(id))).toBe(true);
    expect(document.getElementById(aliasErrorIds[1]!)!.textContent).toBe(m.catalogue_terms_validation_alias_unique());
    expect(b.textContent).not.toContain(m.catalogue_terms_validation_alias_unique());
    expect(first.calls).toHaveLength(1);
    await replace(aliasesA, m.catalogue_create_aliases(), 'Primo\nSecondo');
    const aliases = control(aliasesA, m.catalogue_create_aliases());
    expect(aliases.tagName).toBe('TEXTAREA');
    expect(aliases.getAttribute('rows')).toBe('3');
    const helpId = aliases.getAttribute('aria-describedby')!;
    expect(a.contains(document.getElementById(helpId))).toBe(true);
    expect(document.getElementById(helpId)!.textContent).toBe(m.catalogue_terms_alias_limits());
    const review = () =>
      [...a.querySelectorAll('section')].find((section) =>
        section.textContent?.includes(m.catalogue_terms_unsaved_languages()),
      )!;
    expect(review().textContent).toContain(`en: ${m.catalogue_create_label()}`);
    expect(review().textContent).toContain(`it: ${m.catalogue_create_aliases()}`);
    await click(a, m.catalogue_terms_discard_language({ language: 'it' }));
    expect(control(aliasesA, m.catalogue_terms_action()).value).toBe('keep');
    expect(review().textContent).not.toContain('it:');
    expect(review().textContent).toContain('en:');
    expect(button(a, m.catalogue_create_remove_language()).disabled).toBe(false);
    await click(a, m.catalogue_create_remove_language());
    expect([...a.querySelectorAll('option')].some((option) => option.value === 'it')).toBe(false);
    expect(control(nameA, m.catalogue_create_label()).value).toBe('First draft');
    expect(first.calls).toHaveLength(1);
    // Even an untouched new language remains present across switches and can be removed.
    await replace(a, m.catalogue_terms_new_language(), 'fr');
    await click(a, m.catalogue_create_add_language());
    await select(a, m.catalogue_create_language(), 'en');
    await select(a, m.catalogue_create_language(), 'fr');
    await click(a, m.catalogue_create_remove_language());
    expect([...a.querySelectorAll('option')].some((option) => option.value === 'fr')).toBe(false);
    // Discarding a stored language restores its original and leaves another language's edits intact.
    await replace(a, m.catalogue_terms_new_language(), 'it');
    await click(a, m.catalogue_create_add_language());
    await select(aliasesA, m.catalogue_terms_action(), 'set');
    await replace(aliasesA, m.catalogue_create_aliases(), 'Primo\nSecondo');
    await click(a, `en: ${m.catalogue_create_label()}`);
    await click(a, m.catalogue_terms_discard_language({ language: 'en' }));
    expect(control(nameA, m.catalogue_terms_action()).value).toBe('keep');
    expect(nameA.textContent).toContain(longName);
    expect(review().textContent).not.toContain('en:');
    expect(review().textContent).toContain('it:');
    expect(button(a, m.catalogue_terms_discard_language({ language: 'en' })).disabled).toBe(true);
    expect(button(a, m.catalogue_create_remove_language())).toBeUndefined();
    await select(nameA, m.catalogue_terms_action(), 'set');
    await replace(nameA, m.catalogue_create_label(), 'First draft');
    expect(control(nameA, m.catalogue_create_label()).value).toBe('First draft');
    expect(control(nameA, m.catalogue_create_label()).id).toBe(nameId);
    await select(fieldset(a, m.catalogue_create_description()), m.catalogue_terms_action(), 'remove');
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    for (const scope of [a, b]) {
      for (const element of scope.querySelectorAll('label')) {
        await act(async () => {
          await user.click(element);
        });
        expect(document.activeElement).toBe(document.getElementById(element.htmlFor));
      }
    }
    await click(a, m.catalogue_terms_save());
    expect(a.textContent).toContain(m.catalogue_terms_stale());
    expect(button(a, m.catalogue_terms_save()).disabled).toBe(true);
    const originalCommand = structuredClone(first.calls[1]!);
    expect(originalCommand).toMatchObject({
      method: 'PATCH',
      etag: '"7"',
      session: 'terms-read',
      authorization: 'Bearer fixture',
      body: { labels: { en: 'First draft' }, descriptions: { en: null }, aliases: { it: ['Primo', 'Secondo'] } },
    });
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(1);
    expect(nameA.disabled).toBe(true);
    expect(button(a, m.catalogue_terms_discard_language({ language: 'en' })).disabled).toBe(true);
    expect(nameB.disabled).toBe(false);
    await click(a, m.catalogue_terms_compare());
    expect(first.calls).toHaveLength(3);
    expect(first.calls[2]).toMatchObject({ method: 'GET', session: 'terms-read' });
    expect(a.textContent).toContain(m.catalogue_terms_latest());
    expect(a.textContent).toContain('Another editor’s title');
    expect(nameA.textContent).toContain(longName);
    expect(control(nameA, m.catalogue_create_label()).value).toBe('First draft');
    await select(a, m.catalogue_create_language(), 'it');
    expect(button(a, m.catalogue_create_remove_language()).disabled).toBe(true);
    expect(control(aliasesA, m.catalogue_create_aliases()).value).toBe('Primo\nSecondo');
    await select(a, m.catalogue_create_language(), 'en');
    associations(a);
    associations(b);
    await click(a, m.catalogue_terms_confirm());
    expect(first.calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH', 'GET']);
    expect(first.calls[3]).toMatchObject({ ...originalCommand, etag: '"8"', key: expect.any(String) });
    expect(first.calls[3]!.key).not.toBe(originalCommand.key);
    expect(a.textContent).toContain(m.catalogue_terms_saved());
    expect(a.textContent).toContain('First draft');
    expect(a.textContent).toContain('元の映画');
    expect(a.textContent).toContain('Primo\nSecondo');
    expect(a.querySelector('form')).toBeNull();
    // The other form remains live and uncertain replay retains its exact command.
    await replace(nameB, m.catalogue_create_label(), 'Second draft');
    await click(b, m.catalogue_terms_save());
    expect(b.textContent).toContain(m.catalogue_terms_uncertain());
    expect(nameB.disabled).toBe(true);
    expect(button(b, m.catalogue_terms_discard_language({ language: 'en' })).disabled).toBe(true);
    const uncertainCommand = structuredClone(second.calls[1]!);
    expect(uncertainCommand).toMatchObject({
      method: 'PATCH',
      etag: '"7"',
      session: 'terms-read',
      authorization: 'Bearer fixture',
      body: { labels: { en: 'Second draft' } },
    });
    expect(second.calls).toHaveLength(2);
    second.setScenario('reader-denied');
    await click(b, m.catalogue_create_retry());
    expect(second.calls[2]).toEqual(uncertainCommand);
    expect(second.calls[3]).toMatchObject({ method: 'GET', session: 'terms-write' });
    expect(b.textContent).toContain(m.catalogue_terms_saved());
    expect(b.textContent).toContain(m.catalogue_result_read_denied());
    expect(b.textContent).not.toContain(m.catalogue_terms_denied());
    expect(b.querySelector('form')).toBeNull();
    second.setScenario('ready');
    await click(b, m.catalogue_retry_loading_result());
    expect(second.calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'PATCH', 'GET', 'GET']);
    expect(second.calls[4]).toMatchObject({ method: 'GET', session: 'terms-write', key: null, etag: null });
    expect(b.textContent).toContain('Second draft');
    expect(b.textContent).toContain('元の映画');
    expect(b.textContent).toContain('Working title');
    expect(b.querySelector('form')).toBeNull();
    expect(first.calls).toHaveLength(5);
    const savedIds = ids();
    await render();
    expect(ids()).toEqual(savedIds);
    expect(first.calls).toHaveLength(5);
    expect(second.calls).toHaveLength(5);
    associations(a);
    associations(b);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
