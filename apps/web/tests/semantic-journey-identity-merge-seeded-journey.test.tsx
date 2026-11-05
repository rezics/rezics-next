import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { PersonReviewTransport } from '../src/features/import-review/person-identity';

const bangumi = '00000000-0000-4000-8000-000000000008';
const vndb = '00000000-0000-4000-8000-000000000007';
const operation = '00000000-0000-4000-8000-000000000100';

test('Person review admits merge through keyboard use on narrow and wide layouts and follows independent public readback', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/imports/review', width: 375, height: 720 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    crypto: globalThis.crypto,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const testing = require(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const { ProviderPersonReview } = await import('../src/features/import-review/person-identity-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });

  const seen: string[] = [];
  let published = false;
  const transport: PersonReviewTransport = {
    async compare(pair) {
      seen.push(`compare:${pair[0].source}:${pair[1].source}`);
      const reads = pair.map((original) => ({
        subject: {
          id: original.subject,
          type: 'schema:Person',
          labels: { en: 'Same credited name', ja: '同一名義' },
          statements: {},
        },
        related: {},
        viewerActions: { state: 'available' as const, actions: [{ action: 'subject:merge', operations: ['subject.merge'] }] },
        reviewedIdentity: {
          subject: original.subject,
          source: original.source,
          externalId: original.externalId,
          revision: 1,
          securityRevision: '1',
          claimTransactionId: operation,
          property: original.source.startsWith('bangumi') ? 'wdt:P6298' : 'wdt:P3180',
          value: original.source.startsWith('bangumi') ? original.externalId.slice(7) : original.externalId,
        },
      }));
      return {
        ok: true as const,
        originals: pair,
        reads: reads as never,
        merge: {
          subjects: [pair[0].subject, pair[1].subject] as [string, string],
          expectedIdentity: { endpoints: reads.map((read) => read.reviewedIdentity) as never },
        },
      };
    },
    async merge() {
      seen.push('merge');
      return { ok: true, admission: { operation: { id: operation } } };
    },
    async publication() {
      seen.push('publication');
      if (!published) return { ok: true as const, state: 'pending' as const };
      return {
        ok: true as const,
        state: 'published' as const,
        read: {
          subject: { id: vndb < bangumi ? vndb : bangumi, type: 'schema:Person', labels: { en: 'Same credited name' } },
        } as never,
      };
    },
  };

  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  const canvas = () => within(host);

  try {
    await act(async () =>
      root.render(createElement(ProviderPersonReview, { transport, current: () => true, canWrite: true, locale: 'en' })),
    );
    expect(host.querySelector('section')?.className).toContain('max-w-4xl');
    expect(host.querySelector('.grid')?.className).toContain('md:grid-cols-2');
    expect(canvas().getByRole('heading', { name: m.person_review_title() })).toBeDefined();
    const bangumiSubject = host.querySelector('input[name="bangumi-subject"]') as HTMLInputElement;
    const bangumiKey = host.querySelector('input[name="bangumi-key"]') as HTMLInputElement;
    const vndbSubject = host.querySelector('input[name="vndb-subject"]') as HTMLInputElement;
    const vndbKey = host.querySelector('input[name="vndb-key"]') as HTMLInputElement;
    await act(async () => {
      bangumiSubject.focus();
      await user.clear(bangumiSubject);
      await user.keyboard(bangumi);
      bangumiKey.focus();
      await user.keyboard('person:1916');
      vndbSubject.focus();
      await user.keyboard(vndb);
      vndbKey.focus();
      await user.keyboard('s224');
    });
    await act(async () => user.click(canvas().getByRole('button', { name: m.person_review_compare() })));
    await waitFor(() => expect(canvas().getByText('bangumi_cross_media · person:1916')).toBeDefined());
    expect(seen).toEqual(['compare:bangumi_cross_media:vndb_cross_media']);
    const citation = canvas().getByLabelText(m.person_review_citation());
    await act(async () => {
      citation.focus();
      await user.keyboard('https://www.aozora.gr.jp/');
    });
    const consent = canvas().getByLabelText(m.person_review_consent());
    await act(async () => {
      consent.focus();
      await user.keyboard(' ');
    });
    await act(async () => user.click(canvas().getByRole('button', { name: m.person_review_confirm() })));
    await waitFor(() => expect(canvas().getByText(m.person_review_admitted())).toBeDefined());
    expect(seen).toEqual(['compare:bangumi_cross_media:vndb_cross_media', 'merge']);
    await act(async () => user.click(canvas().getByRole('button', { name: m.person_review_check_publication() })));
    await waitFor(() => expect(canvas().getByText(m.person_review_publication_pending())).toBeDefined());
    published = true;
    await act(async () => user.click(canvas().getByRole('button', { name: m.person_review_check_publication() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: 'Same credited name' })).toBeDefined());
    expect(host.querySelectorAll('button.min-h-11, a.min-h-11, input, select').length).toBeGreaterThan(0);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    window.dispatchEvent(new Event('resize'));
    expect(host.querySelector('.grid')?.className).toContain('md:grid-cols-2');

    const web = process.env.REZICS_LOCAL_STACK_WEB_ORIGIN;
    const kernel = process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN;
    if (web && kernel) {
      for (const locale of ['en', 'zh-Hant', 'ja']) {
        const page = await fetch(`${web}/${locale}/imports/review`);
        expect([200, 302, 303, 307, 401], `${locale} ${page.status}`).toContain(page.status);
        const intake = await fetch(`${web}/${locale}/catalogue/new`);
        expect([200, 302, 303, 307, 401], `${locale} intake ${intake.status}`).toContain(intake.status);
      }
      const unknown = await fetch(`${kernel}/v1/subjects/${operation}`);
      expect([401, 404, 200, 308]).toContain(unknown.status);
      const merge = await fetch(`${kernel}/v1/subjects:merge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect([400, 401, 403]).toContain(merge.status);
    }
  } finally {
    await act(async () => root.unmount());
    window.close();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
