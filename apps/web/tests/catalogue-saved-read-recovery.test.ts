import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';

test('A contributor retries only the failed reading after a confirmed save', async () => {
  // Use the same DOM environment as the existing focused composition regressions.
  // Keep both real editors and their generated-client fixture transports.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue', width: 1280, height: 900 });
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
  const input = async (id: string, value: string) => {
    await act(async () => {
      const element = host.querySelector(`#${id}`)!;
      // Use the native setter so React observes an actual input change.
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    const terms = catalogueTermsFixture('reader-denied');
    let loseRead = false;
    const readTerms = mock(async (...args: Parameters<typeof terms.transport.read>) => {
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
    await act(async () => {
      const mode = host.querySelector('#terms-labels-mode')!;
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
    await input('authored-language', 'en');
    await input('authored-licence', 'CC-BY-4.0');
    await input('authored-citation', 'https://example.org/original-notes');
    await act(async () => host.querySelector('#authored-original')!.click());
    await act(async () => button(m.correction_submit()).click());
    const proposal = await propose.mock.results[0]!.value;
    if (!proposal.ok) throw new Error('Expected a confirmed authored proposal');
    const originalProposal = structuredClone(authored.calls.find((call) => call.method === 'POST'));
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.textContent).not.toContain(m.candidate_selected());
    // An open private comparison must not turn a public-text reload into another review read.
    await act(async () => button(m.correction_review()).click());
    const reviewsBeforeReload = review.mock.calls.length;
    expect(reviewsBeforeReload).toBeGreaterThan(0);
    authored.documents.delete(originalDocument.id);
    await act(async () => button(m.authored_reload_current_text()).click());
    expect(readAuthored.mock.calls.at(-1)).toEqual([authoredProperty, proposal.session]);
    expect(host.textContent).toContain(m.authored_submitted());
    const selected = host.querySelector(`[aria-label="${m.authored_selected()}"]`)!;
    expect(selected.textContent).toContain(m.authored_body_unavailable());
    expect(selected.textContent).not.toContain('An aviator meets a young traveller in the desert.');
    expect(selected.textContent).not.toContain('A quiet story about friendship.');
    loseAuthoredRead = true;
    await act(async () => button(m.authored_reload_current_text()).click());
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.textContent).toContain(m.catalogue_result_read_unavailable());
    expect(host.querySelector('form')).toBeNull();
    authored.documents.set(originalDocument.id, originalDocument);
    const beforeTextRecovery = authored.calls.length;
    await act(async () => button(m.catalogue_retry_loading_result()).click());
    expect(readAuthored.mock.calls.at(-1)).toEqual([authoredProperty, proposal.session]);
    expect(authored.calls.slice(beforeTextRecovery).every((call) => call.method === 'GET')).toBe(true);
    expect(authored.calls.slice(beforeTextRecovery).filter((call) => call.path.startsWith('/v1/documents/'))).toEqual([
      expect.objectContaining({ path: `/v1/documents/${originalDocument.id}`, authorization: null }),
    ]);
    expect(host.textContent).toContain(m.authored_submitted());
    expect(host.querySelector(`[aria-label="${m.authored_selected()}"]`)!.textContent).toContain(
      'An aviator meets a young traveller in the desert.',
    );
    expect(host.textContent).not.toContain(m.candidate_selected());
    expect(host.querySelector('#authored-language')!.value).toBe('en');
    expect(host.querySelector('#authored-licence')!.value).toBe('CC-BY-4.0');
    expect(host.querySelector('#authored-citation')!.value).toBe('https://example.org/original-notes');
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
