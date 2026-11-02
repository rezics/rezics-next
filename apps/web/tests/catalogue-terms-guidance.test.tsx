import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type {
  TermField,
  TermsCommand,
  TermsFailure,
  TermsSnapshot,
  TermsTransport,
} from '../src/features/catalogue/subject-terms';

test('Multilingual terms show actionable field-specific corrections without changing invalid admission or command recovery', async () => {
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
  const { patchedTerms } = await import('../src/features/catalogue/subject-terms');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

  try {
    // Data language and interface language are independent in the actual default page.
    for (const locale of ['en', 'zh-Hant']) {
      const options = { locale: locale as never };
      const snapshot: TermsSnapshot = {
        subject: {
          id: '00000000-0000-4000-8000-00000000c003',
          type: 'schema:Movie',
          revision: 7,
          labels: { en: 'Original film', ja: '元の映画' },
          descriptions: { en: 'Original description', ja: '元の説明' },
          aliases: { en: ['Working title'], ja: ['別名'] },
        },
        etag: '"7"',
        href: `/${locale}/subjects/example`,
        session: 'terms-read',
      };
      const commands: TermsCommand[] = [];
      let serverFailure: TermsFailure | undefined;
      let lost = false;
      const transport: TermsTransport = {
        read: async () => ({ state: 'ready', snapshot }),
        submit: async (command) => {
          commands.push(structuredClone(command));
          if (serverFailure) return serverFailure;
          if (!lost) {
            lost = true;
            return { ok: false, reason: 'unavailable' };
          }
          return {
            ok: true,
            id: command.id,
            revision: 8,
            reader: {
              state: 'ready',
              snapshot: {
                ...snapshot,
                etag: '"8"',
                subject: { ...snapshot.subject, ...patchedTerms(snapshot.subject, command.patch), revision: 8 },
              },
            },
          };
        },
      };
      client.setQueryData(['catalogue-terms', snapshot.subject.id, locale], { state: 'ready', snapshot });
      const publishSnapshot = (next: TermsSnapshot) =>
        act(async () => {
          client.setQueriesData(
            { queryKey: ['catalogue-terms', snapshot.subject.id, locale] },
            { state: 'ready', snapshot: next },
          );
        });
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <SubjectTermsPage
              key={locale}
              id={snapshot.subject.id}
              locale={locale}
              session="signed-in"
              transport={transport}
            />
          </QueryClientProvider>,
        ),
      );
      const control = (part: string) => {
        const field = part.replace(/^terms-/, '').replace(/-mode$/, '');
        const label =
          field === 'language'
            ? m.catalogue_create_language({}, options)
            : field === 'new-language'
              ? m.catalogue_terms_new_language({}, options)
              : field === 'labels'
                ? m.catalogue_create_label({}, options)
                : field === 'descriptions'
                  ? m.catalogue_create_description({}, options)
                  : m.catalogue_create_aliases({}, options);
        const scope = ['labels', 'descriptions', 'aliases'].includes(field)
          ? [...host.querySelectorAll('fieldset')].find(
              (fieldset) => fieldset.querySelector('legend')?.textContent === label,
            )!
          : host;
        const associated = [...scope.querySelectorAll('label')].find(
          (element) => element.textContent === (part.endsWith('-mode') ? m.catalogue_terms_action({}, options) : label),
        );
        return window.document.getElementById(associated?.htmlFor ?? '') as unknown as HTMLInputElement;
      };
      const button = (text: string) =>
        [...host.querySelectorAll('button')].find((button) => button.textContent === text)!;
      const click = (text: string) =>
        act(async () => {
          await user.click(button(text));
        });
      const clickElement = (element: Element) => act(async () => user.click(element));
      const dialog = () => window.document.querySelector('[role="alertdialog"]')!;
      const dialogButton = (text: string) =>
        [...dialog().querySelectorAll('button')].find((candidate) => candidate.textContent === text)!;
      const select = (id: string, value: string) =>
        act(async () => {
          await user.selectOptions(control(id), value);
        });
      const replace = (id: string, value: string) =>
        act(async () => {
          await user.clear(control(id));
          if (value) await user.type(control(id), value);
        });
      const mode = (field: TermField, value: string) => select(`terms-${field}-mode`, value);
      const language = (value: string) => select('terms-language', value);
      const save = () => click(m.catalogue_terms_save({}, options));
      const described = (id: string) => {
        const ids = control(id).getAttribute('aria-describedby')?.split(' ') ?? [];
        expect(ids.length).toBeGreaterThan(0);
        return ids
          .map((id) => {
            const element = window.document.getElementById(id);
            expect(element).not.toBeNull();
            return element!.textContent;
          })
          .join(' ');
      };
      const correction = (id: string, message: string) => {
        expect(control(id).getAttribute('aria-invalid')).toBe('true');
        expect(described(id)).toContain(message);
      };

      await replace('terms-new-language', 'english!');
      await click(m.catalogue_create_add_language({}, options));
      correction('terms-new-language', m.catalogue_terms_validation_language({}, options));
      const languageErrorId = control('terms-new-language').getAttribute('aria-describedby')!;
      await replace('terms-new-language', 'en-US');
      await click(m.catalogue_create_add_language({}, options));
      expect(window.document.getElementById(languageErrorId)).toBeNull();

      // A populated added language stays local through Cancel and Escape, then only its tab and draft are removed.
      await language('ja');
      await mode('descriptions', 'set');
      await replace('terms-descriptions', '日本語の草稿');
      await language('en-US');
      await mode('aliases', 'set');
      await replace('terms-aliases', 'Added alias');
      const removeLanguage = m.catalogue_create_remove_language({}, options);
      const removeOpener = button(removeLanguage);
      await click(removeLanguage);
      expect(dialog().textContent).toContain(m.catalogue_terms_discard_help({}, options));
      const cancelLabel = m.candidate_cancel({}, options);
      expect(dialog().querySelector('button')?.textContent).toBe(cancelLabel);
      expect(window.document.activeElement).toBe(dialogButton(cancelLabel));
      expect(control('terms-aliases').closest('fieldset')?.disabled).toBe(true);
      expect(control('terms-language').disabled).toBe(true);
      expect(button(m.catalogue_terms_save({}, options)).disabled).toBe(true);
      await act(async () => user.keyboard('{Escape}'));
      expect(window.document.activeElement).toBe(removeOpener);
      expect(control('terms-aliases').value).toBe('Added alias');
      await click(removeLanguage);
      await publishSnapshot({ ...snapshot, session: 'replacement-reader' });
      expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(control('terms-aliases').value).toBe('Added alias');
      await publishSnapshot(snapshot);
      expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(control('terms-aliases').value).toBe('Added alias');
      await click(removeLanguage);
      await clickElement(dialogButton(cancelLabel));
      expect(window.document.activeElement).toBe(removeOpener);
      expect(control('terms-aliases').value).toBe('Added alias');
      await click(removeLanguage);
      await clickElement(dialogButton(removeLanguage));
      expect(control('terms-language').value).toBe('en');
      expect(window.document.activeElement).toBe(control('terms-language'));
      expect(control('terms-aliases')).toBeNull();
      expect(commands).toHaveLength(0);
      await language('ja');
      expect(control('terms-descriptions').value).toBe('日本語の草稿');

      // A blank added scaffold is still removable immediately.
      await replace('new-language', 'en-US');
      await click(m.catalogue_create_add_language({}, options));
      await click(removeLanguage);
      expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(control('terms-language').value).toBe('en');
      expect(window.document.activeElement).toBe(control('terms-language'));
      await replace('new-language', 'en-US');
      await click(m.catalogue_create_add_language({}, options));

      // Explicit removal edits and populated stored-language corrections require confirmation too.
      await language('en');
      const discardEnglish = m.catalogue_terms_discard_language({ language: 'en' }, options);
      const discardOpener = button(discardEnglish);
      await mode('labels', 'remove');
      await click(discardEnglish);
      await clickElement(dialogButton(cancelLabel));
      expect(control('terms-labels-mode').value).toBe('remove');
      expect(window.document.activeElement).toBe(discardOpener);
      await mode('labels', 'keep');
      await mode('labels', 'set');
      await replace('terms-labels', 'Temporary title');
      await click(discardEnglish);
      await clickElement(dialogButton(cancelLabel));
      expect(control('terms-labels').value).toBe('Temporary title');
      await click(discardEnglish);
      await act(async () => user.keyboard('{Escape}'));
      expect(window.document.activeElement).toBe(discardOpener);
      expect(control('terms-labels').value).toBe('Temporary title');
      await click(discardEnglish);
      await clickElement(dialogButton(discardEnglish));
      expect(control('terms-labels').value).toBe('Original film');
      expect(window.document.activeElement).toBe(control('terms-language'));
      expect(commands).toHaveLength(0);
      await language('en-US');

      await mode('labels', 'set');
      await save();
      correction('terms-labels', m.catalogue_terms_validation_name({}, options));
      expect(commands).toHaveLength(0);
      await language('en');
      await mode('labels', 'set');
      // /labels/en-US must never mark /labels/en by prefix coincidence.
      await save();
      expect(control('terms-labels').getAttribute('aria-invalid')).toBe('false');
      await language('en-US');
      correction('terms-labels', m.catalogue_terms_validation_name({}, options));
      await mode('labels', 'keep');
      await language('ja');
      await mode('descriptions', 'set');
      await replace('terms-descriptions', ' 日本語の草稿');
      await save();
      correction('terms-descriptions', m.catalogue_terms_validation_description({}, options));
      await replace('terms-descriptions', '日本語の草稿');
      await language('en');
      await replace('terms-labels', '');
      await save();
      correction('terms-labels', m.catalogue_terms_validation_name({}, options));
      await replace('terms-labels', 'Corrected title');
      await mode('aliases', 'set');
      for (const [value, message] of [
        ['Same\nSame', m.catalogue_terms_validation_alias_unique({}, options)],
        ['First\n', m.catalogue_terms_validation_alias({}, options)],
        ['x'.repeat(251), m.catalogue_terms_validation_alias({}, options)],
        [
          Array.from({ length: 33 }, (_, i) => `Alias ${i}`).join('\n'),
          m.catalogue_terms_validation_alias_count({}, options),
        ],
      ]) {
        await replace('terms-aliases', value!);
        await save();
        correction('terms-aliases', message!);
        expect(described('terms-aliases')).toContain(m.catalogue_terms_alias_limits({}, options));
        expect(control('terms-aliases').value).toBe(value!);
        expect(commands).toHaveLength(0);
      }
      await replace('terms-aliases', 'First\nSecond');
      await mode('labels', 'remove');
      await language('ja');
      expect(control('terms-descriptions').value).toBe('日本語の草稿');
      await mode('labels', 'remove');
      await save();
      expect(control('terms-labels')).toBeNull();
      correction('terms-labels-mode', m.catalogue_terms_validation_name_required({}, options));
      expect(commands).toHaveLength(0);
      await mode('labels', 'keep');
      await language('en');
      await mode('labels', 'set');
      expect(control('terms-labels').value).toBe('Corrected title');

      // Do not reinterpret an unsupported or unexplained server reason as a local text error.
      for (const [code, message] of [
        ['unsupported', m.catalogue_terms_validation_unsupported({}, options)],
        ['invalid_format', m.catalogue_terms_validation_unknown({}, options)],
      ] as const) {
        serverFailure = { ok: false, reason: 'invalid', errors: [{ pointer: '/labels/en', code }] };
        await save();
        correction('terms-labels', message);
        await replace('terms-labels', 'Corrected title');
      }
      serverFailure = undefined;
      await save();
      expect(host.textContent).toContain(m.catalogue_terms_uncertain({}, options));
      expect(control('terms-labels').closest('fieldset')?.disabled).toBe(true);
      const uncertain = commands.at(-1)!;
      expect(uncertain).toMatchObject({
        etag: snapshot.etag,
        session: snapshot.session,
        patch: {
          labels: { en: 'Corrected title' },
          descriptions: { ja: '日本語の草稿' },
          aliases: { en: ['First', 'Second'] },
        },
      });
      await click(m.catalogue_create_retry({}, options));
      expect(commands.at(-1)).toEqual(uncertain);
      expect(host.textContent).toContain(m.catalogue_terms_saved({}, options));
      expect(host.textContent).toContain('元の映画');
      expect(host.textContent).toContain('日本語の草稿');
      expect(host.textContent).toContain('別名');
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
