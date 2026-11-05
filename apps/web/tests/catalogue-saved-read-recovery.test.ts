import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';

test('A contributor retries only the failed reading after a confirmed save', async () => {
  // Use the same DOM environment as the existing focused composition regressions.
  // Keep both real editors and their generated-client fixture transports.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    DOMParser: window.DOMParser,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Range: window.Range,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { SubjectTermsPage } = await import('../src/features/catalogue/subject-terms-page');
  const { AuthoredField } = await import('../src/features/catalogue/authored-field-view');
  const { catalogueTermsFixture, termsSubjectId } = await import('../src/kernel/fake/catalogue-terms');
  const { authoredFixture, authoredProperty } = await import('../src/kernel/fake/authored-field');
  const { m } = await import('../src/paraglide/messages.js');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const button = (label: string) => {
    const found = Array.from(host.querySelectorAll('button')).find((element: any) => element.textContent === label);
    expect(found, `Expected the actual ${label} action`).toBeDefined();
    return found as HTMLButtonElement;
  };
  const termsControl = (part: string) => {
    const field = part.replace(/^terms-/, '').replace(/-mode$/, '');
    const label =
      field === 'language'
        ? m.catalogue_create_language()
        : field === 'new-language'
          ? m.catalogue_terms_new_language()
          : field === 'labels'
            ? m.catalogue_create_label()
            : field === 'descriptions'
              ? m.catalogue_create_description()
              : m.catalogue_create_aliases();
    const scope = ['labels', 'descriptions', 'aliases'].includes(field)
      ? [...host.querySelectorAll('fieldset')].find(
          (fieldset) => fieldset.querySelector('legend')?.textContent === label,
        )!
      : host;
    const associated = [...scope.querySelectorAll('label')].find(
      (element) => element.textContent === (part.endsWith('-mode') ? m.catalogue_terms_action() : label),
    )!;
    return window.document.getElementById(associated.htmlFor)!;
  };
  const input = async (id: string, value: string) => {
    await act(async () => {
      const element = id.startsWith('terms-') ? termsControl(id) : host.querySelector(`#${id}`)!;
      // Use the native setter so React observes an actual input change.
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    const terms = catalogueTermsFixture('reader-denied');
    let loseRead = false;
    let originalReads = 0;
    let replacementReads = 0;
    let startFirstRetry!: () => void;
    let releaseFirstRetry!: () => void;
    let startSecondRetry!: () => void;
    let releaseSecondRetry!: () => void;
    let startRetiredRetry!: () => void;
    let releaseRetiredRetry!: () => void;
    const firstRetryStarted = new Promise<void>((resolve) => (startFirstRetry = resolve));
    const firstRetryGate = new Promise<void>((resolve) => (releaseFirstRetry = resolve));
    const secondRetryStarted = new Promise<void>((resolve) => (startSecondRetry = resolve));
    const secondRetryGate = new Promise<void>((resolve) => (releaseSecondRetry = resolve));
    const retiredRetryStarted = new Promise<void>((resolve) => (startRetiredRetry = resolve));
    const retiredRetryGate = new Promise<void>((resolve) => (releaseRetiredRetry = resolve));
    const readTerms = mock(async (...args: Parameters<typeof terms.transport.read>) => {
      if (args[0] !== termsSubjectId) {
        if (replacementReads++ === 0) return { state: 'unavailable' } as const;
        return terms.transport.read(...args);
      }
      const attempt = originalReads++;
      if (attempt === 0) throw new TypeError('Initial terms reading temporarily unavailable');
      if (attempt === 1) {
        startFirstRetry();
        await firstRetryGate;
        throw new TypeError('Initial terms reading temporarily unavailable');
      }
      if (attempt === 2) {
        startSecondRetry();
        await secondRetryGate;
        throw new TypeError('Initial terms reading temporarily unavailable');
      }
      if (attempt === 3) {
        startRetiredRetry();
        await retiredRetryGate;
        return terms.transport.read(...args);
      }
      if (loseRead) {
        loseRead = false;
        throw new TypeError('Result reading temporarily unavailable');
      }
      return terms.transport.read(...args);
    });
    const submitTerms = mock(terms.transport.submit);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SubjectTermsPage, {
            id: termsSubjectId,
            locale: 'en',
            session: 'signed-in',
            transport: { read: readTerms, submit: submitTerms },
          }),
        ),
      );
    });
    await act(async () => {
      await Bun.sleep(10);
    });
    expect(host.textContent).toContain(m.catalogue_result_read_unavailable());
    const firstRetry = button(m.catalogue_retry_loading_result());
    await act(async () => {
      firstRetry.focus();
      firstRetry.click();
      firstRetry.click();
      await firstRetryStarted;
    });
    expect(readTerms).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.candidate_loading());
    releaseFirstRetry();
    await act(async () => {
      await Bun.sleep(10);
    });
    expect(host.textContent).toContain(m.catalogue_result_read_unavailable());
    expect(window.document.activeElement).toBe(host.querySelector('[role="alert"]'));

    const outside = window.document.createElement('button');
    outside.textContent = 'Outside focus';
    window.document.body.append(outside);
    const secondRetry = button(m.catalogue_retry_loading_result());
    await act(async () => {
      secondRetry.focus();
      secondRetry.click();
      await secondRetryStarted;
    });
    await act(async () => outside.focus());
    releaseSecondRetry();
    await act(async () => {
      await Bun.sleep(10);
    });
    expect(window.document.activeElement).toBe(outside);

    const retiredRetry = button(m.catalogue_retry_loading_result());
    await act(async () => {
      retiredRetry.focus();
      retiredRetry.click();
      await retiredRetryStarted;
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SubjectTermsPage, {
            id: 'replacement-subject',
            locale: 'en',
            session: 'signed-in',
            transport: { read: readTerms, submit: submitTerms },
          }),
        ),
      );
      await Bun.sleep(10);
    });
    await act(async () => outside.focus());
    releaseRetiredRetry();
    await act(async () => {
      await Bun.sleep(10);
    });
    expect(host.textContent).toContain(m.catalogue_result_read_unavailable());
    expect(window.document.activeElement).toBe(outside);

    const currentRetry = button(m.catalogue_retry_loading_result());
    await act(async () => {
      currentRetry.focus();
      currentRetry.click();
      await Bun.sleep(10);
    });
    expect(host.querySelector('h1')).not.toBeNull();
    expect(window.document.activeElement).toBe(host.querySelector('h1'));

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SubjectTermsPage, {
            id: termsSubjectId,
            locale: 'en',
            session: 'signed-in',
            transport: { read: readTerms, submit: submitTerms },
          }),
        ),
      );
      await Bun.sleep(10);
    });
    await act(async () => {
      const mode = termsControl('terms-labels-mode');
      mode.value = 'set';
      mode.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await input('terms-labels', 'Corrected title');
    await act(async () => button(m.catalogue_terms_save()).click());
    const receipt = await submitTerms.mock.results[0]!.value;
    if (!receipt.ok) throw new Error('Expected a confirmed terms save');
    const originalWrite = structuredClone(terms.calls.find((call) => call.method === 'PATCH'));
    expect(host.textContent).toContain(m.catalogue_terms_saved());
    expect(host.textContent).toContain(m.catalogue_result_read_denied());
    expect(host.textContent).not.toContain(m.catalogue_terms_denied());
    expect(host.querySelector('form')).toBeNull();
    loseRead = true;
    await act(async () => button(m.catalogue_retry_loading_result()).click());
    expect(host.textContent).toContain(m.catalogue_terms_saved());
    expect(host.textContent).toContain(m.catalogue_terms_reader_unavailable());
    expect(readTerms.mock.calls.at(-1)).toEqual([receipt.id, receipt.session]);
    terms.setScenario('ready');
    const beforeRecovery = terms.calls.length;
    await act(async () => button(m.catalogue_retry_loading_result()).click());
    expect(readTerms.mock.calls.at(-1)).toEqual([receipt.id, receipt.session]);
    expect(terms.calls.slice(beforeRecovery)).toMatchObject([
      { method: 'GET', path: `/v1/subjects/${receipt.id}`, session: receipt.session, key: null, etag: null },
    ]);
    expect(host.textContent).toContain(m.catalogue_terms_saved());
    expect(host.textContent).toContain('Corrected title');
    expect(host.textContent).toContain('元の映画');
    expect(host.querySelector('form')).toBeNull();
    expect(submitTerms).toHaveBeenCalledTimes(1);
    expect(terms.calls.filter((call) => call.method === 'PATCH')).toEqual([originalWrite]);

    // Exercise the actual terms composition through stale comparison and uncertain confirmation.
    await act(async () => root.render(null));
    queryClient.clear();
    const staleTerms = catalogueTermsFixture('stale');
    let resumeWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    let pauseWrite = true;
    const submitStale = mock(async (command: Parameters<typeof staleTerms.transport.submit>[0]) => {
      if (pauseWrite) {
        pauseWrite = false;
        await writePending;
      }
      return staleTerms.transport.submit(command);
    });
    const readStale = mock(staleTerms.transport.read);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SubjectTermsPage, {
            id: termsSubjectId,
            locale: 'en',
            session: 'signed-in',
            transport: { read: readStale, submit: submitStale },
          }),
        ),
      );
    });
    await act(async () => {
      await Bun.sleep(10);
    });
    const select = async (id: string, value: string) => {
      await act(async () => {
        const control = termsControl(id);
        control.value = value;
        control.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    };
    await select('terms-labels-mode', 'set');
    await input('terms-labels', 'Phone draft');
    await select('terms-descriptions-mode', 'remove');
    await input('terms-new-language', 'it');
    await act(async () => button(m.catalogue_create_add_language()).click());
    expect(termsControl('terms-language').value).toBe('it');
    await select('terms-aliases-mode', 'set');
    await act(async () => {
      const aliases = termsControl('terms-aliases');
      expect(aliases.tagName).toBe('TEXTAREA');
      expect(aliases.getAttribute('rows')).toBe('3');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        aliases,
        'Primo\nSecondo',
      );
      aliases.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await select('terms-language', 'en');
    expect(termsControl('terms-labels').value).toBe('Phone draft');
    await act(async () => button(m.catalogue_terms_save()).click());
    expect(host.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
    expect(termsControl('terms-language').disabled).toBe(true);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(button(m.catalogue_create_add_language()).disabled).toBe(true);
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(submitStale).toHaveBeenCalledTimes(1);
    await act(async () => {
      resumeWrite();
      await submitStale.mock.results[0]!.value;
    });
    expect(host.textContent).toContain(m.catalogue_terms_stale());
    expect(button(m.catalogue_terms_save()).disabled).toBe(true);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(button(m.catalogue_create_add_language()).disabled).toBe(true);
    expect(termsControl('terms-language').disabled).toBe(false);
    expect(submitStale).toHaveBeenCalledTimes(1);
    const firstCommand = structuredClone(submitStale.mock.calls[0]![0]);
    expect(firstCommand).toMatchObject({
      id: termsSubjectId,
      etag: '"7"',
      session: 'terms-read',
      patch: { labels: { en: 'Phone draft' }, descriptions: { en: null }, aliases: { it: ['Primo', 'Secondo'] } },
    });
    await act(async () => button(m.catalogue_terms_compare()).click());
    expect(host.textContent).toContain('Another editor’s title');
    expect(readStale.mock.calls.at(-1)).toEqual([termsSubjectId, 'terms-read']);
    expect(submitStale).toHaveBeenCalledTimes(1);
    await select('terms-language', 'it');
    expect(termsControl('terms-aliases').value).toBe('Primo\nSecondo');
    await select('terms-language', 'en');
    expect(termsControl('terms-labels').value).toBe('Phone draft');
    staleTerms.setScenario('uncertain');
    const overlap = [...host.querySelectorAll('fieldset')].find(
      (element) => element.querySelector('legend')?.textContent === `en: ${m.catalogue_create_label()}`,
    )!;
    const choice = [...overlap.querySelectorAll('label')].find(
      (element) => element.textContent === m.catalogue_terms_resolve_choice(),
    )!;
    await act(async () => {
      const control = window.document.getElementById(choice.htmlFor) as HTMLSelectElement;
      control.value = 'draft';
      control.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => button(m.catalogue_terms_review()).click());
    await act(async () => button(m.catalogue_terms_confirm()).click());
    expect(host.textContent).toContain(m.catalogue_terms_uncertain());
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(button(m.catalogue_create_add_language()).disabled).toBe(true);
    const confirmedCommand = structuredClone(submitStale.mock.calls[1]![0]);
    expect(confirmedCommand).toMatchObject({ ...firstCommand, key: expect.any(String), etag: '"8"' });
    expect(confirmedCommand.key).not.toBe(firstCommand.key);
    await act(async () => button(m.catalogue_create_retry()).click());
    expect(submitStale.mock.calls[2]![0]).toEqual(confirmedCommand);
    expect(host.textContent).toContain(m.catalogue_terms_saved());
    expect(staleTerms.subject.labels).toEqual({ en: 'Phone draft', ja: '元の映画' });
    expect(staleTerms.subject.descriptions).toEqual({ ja: '元の説明' });
    expect(staleTerms.subject.aliases).toEqual({ en: ['Working title'], ja: ['別名'], it: ['Primo', 'Secondo'] });
    expect(host.querySelector('form')).toBeNull();
    expect(submitStale).toHaveBeenCalledTimes(3);

    // Authored-only associations; the Terms helper and its scenarios stay independent.
    const authoredControl = (name: string) => {
      const label = Array.from(host.querySelectorAll('label')).find(
        (element: any) => element.textContent === name,
      ) as any;
      expect(label, `Expected the actual ${name} label`).toBeDefined();
      const control = window.document.getElementById(label.htmlFor);
      expect(control, `Expected the locally associated ${name} control`).not.toBeNull();
      expect(host.contains(control!)).toBe(true);
      return control!;
    };
    const authoredInput = async (name: string, value: string) => {
      await act(async () => {
        const element = authoredControl(name);
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    const authored = authoredFixture();
    const initial = await authored.transport.read();
    if (!initial.ok || !initial.body?.ok) throw new Error('Expected the authorized current document');
    const originalDocument = initial.body.document;
    let loseAuthoredRead = false;
    const readAuthored = mock(async (...args: Parameters<typeof authored.transport.read>) => {
      if (loseAuthoredRead) {
        loseAuthoredRead = false;
        throw new TypeError('Current text temporarily unavailable');
      }
      return authored.transport.read(...args);
    });
    const propose = mock(authored.transport.propose);
    const review = mock(authored.transport.review);
    const confirm = mock(authored.confirm);
    await act(async () => {
      root.render(
        createElement(AuthoredField, {
          initial,
          locale: 'en',
          transport: { read: readAuthored, propose, review },
          confirm,
        }),
      );
    });
    await act(async () => {
      const editor = host.querySelector('[contenteditable="true"]')!;
      editor.innerHTML = '<p>A quiet story about friendship.</p>';
      editor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await Bun.sleep(180);
      editor.dispatchEvent(new window.FocusEvent('blur'));
    });
    await authoredInput(m.authored_language(), 'en');
    await authoredInput(m.authored_licence(), 'CC-BY-4.0');
    await authoredInput(m.authored_citation(), 'https://example.org/original-notes');
    await act(async () => authoredControl(m.authored_original()).click());
    await act(async () => button(m.correction_submit()).click());
    const proposal = await propose.mock.results[0]!.value;
    if (!proposal.ok) throw new Error('Expected a confirmed authored proposal');
    const originalProposal = structuredClone(authored.calls.find((call) => call.method === 'POST'));
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.textContent).not.toContain(m.candidate_selected());
    authored.documents.delete(originalDocument.id);
    await act(async () => button(m.authored_reload_current_text()).click());
    expect(readAuthored.mock.calls.at(-1)).toEqual([authoredProperty, proposal.session]);
    expect(host.textContent).toContain(m.authored_submitted());
    const selected = host.querySelector(`[aria-label="${m.authored_selected()}"]`)!;
    expect(selected.textContent).toContain(m.authored_body_unavailable());
    expect(selected.textContent).not.toContain('An aviator meets a young traveller in the desert.');
    expect(selected.textContent).not.toContain('A quiet story about friendship.');
    // An open private comparison must not turn a public-text reload into another review read.
    await act(async () => button(m.correction_review()).click());
    const reviewsBeforeReload = review.mock.calls.length;
    expect(reviewsBeforeReload).toBeGreaterThan(0);
    const comparison = await review.mock.results.at(-1)!.value;
    if (!comparison.comparison.ok) throw new Error('Expected the independently authorized comparison');
    loseAuthoredRead = true;
    await act(async () => button(m.authored_reload_current_text()).click());
    const failedReading = readAuthored.mock.calls.at(-1);
    expect(failedReading).toEqual([authoredProperty, comparison.comparison.session]);
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.textContent).toContain(m.catalogue_result_read_unavailable());
    expect(host.querySelector('form')).toBeNull();
    authored.documents.set(originalDocument.id, originalDocument);
    const beforeTextRecovery = authored.calls.length;
    await act(async () => button(m.catalogue_retry_loading_result()).click());
    expect(readAuthored.mock.calls.at(-1)).toEqual(failedReading);
    expect(authored.calls.slice(beforeTextRecovery).every((call) => call.method === 'GET')).toBe(true);
    expect(authored.calls.slice(beforeTextRecovery).filter((call) => call.path.startsWith('/v1/documents/'))).toEqual([
      expect.objectContaining({ path: `/v1/documents/${originalDocument.id}`, authorization: null }),
    ]);
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.querySelector(`[aria-label="${m.authored_selected()}"]`)!.textContent).toContain(
      'An aviator meets a young traveller in the desert.',
    );
    expect(host.textContent).not.toContain(m.candidate_selected());
    expect(authoredControl(m.authored_language()).value).toBe('en');
    expect(authoredControl(m.authored_licence()).value).toBe('CC-BY-4.0');
    expect(authoredControl(m.authored_citation()).value).toBe('https://example.org/original-notes');
    expect(host.querySelector('[contenteditable="true"]')).toBeNull();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(reviewsBeforeReload);
    expect(authored.calls.filter((call) => call.method === 'POST')).toEqual([originalProposal]);
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      expect(m.catalogue_result_read_denied({}, { locale })).not.toBe(m.catalogue_terms_denied({}, { locale }));
      expect(m.authored_reload_current_text({}, { locale })).not.toBe(m.correction_reload({}, { locale }));
      expect(m.catalogue_retry_loading_result({}, { locale }).length).toBeGreaterThan(0);
    }
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15_000);
