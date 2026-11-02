import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { fromMarkdown, fromPlainText, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import type { SubjectRead } from '@rezics/client';
import recordedSubject from '../src/kernel/recorded/subject.json';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const composition = {
  root: { props: {} },
  content: [{ type: 'Summary', props: { id: 'about' } }],
} satisfies CompositionDocument;

function withNodes(nodes: DocumentNode[]) {
  const snapshot = structuredClone(fromPlainText('placeholder'));
  snapshot.doc.content![0]!.content = nodes;
  return snapshot;
}

test('mounted About keeps complete Unicode characters and the full admitted document through disclosure and spoiler journeys', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/reading' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { PageData, dataComponents } = await import('../src/features/pages/data');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { pageDefinitions } = await import('../src/features/pages/layout');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    throw new Error('About reading must use the supplied document without another read');
  }) as typeof fetch;
  let visit = 0;
  async function show(snapshot: DocumentSnapshot, language = 'en', level = 0) {
    const body = structuredClone(recordedSubject) as unknown as SubjectRead;
    const statement = structuredClone(body.subject.statements['schema:abstract']![0]!);
    const documentId = '00000000-0000-4000-8000-000000000010';
    const digest = 'sha256:admitted-about-document';
    statement.value = { type: 'value', content: { language, document: documentId, digest } };
    statement.qualifiers = level
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: `+${level}`, unit: '1' } },
          },
        ]
      : [];
    body.subject.statements = { 'schema:abstract': [statement] };
    body.subject.descriptions = { en: 'Fallback must not replace the admitted rich document.' };
    const supplied = {
      ...body,
      documents: {
        [statement.id]: {
          id: documentId,
          subjectId: body.subject.id,
          candidateId: statement.id,
          language,
          digest,
          availability: 'available',
          body: snapshot,
        },
      },
    };
    const original = structuredClone(supplied);
    const plan = planReads(platformRegistry, composition, { subject: body.subject.id });
    expect(Object.values(plan.reads).every((read) => read.kind === 'subject')).toBe(true);
    const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: supplied }]));
    const page = (
      <QueryClientProvider client={client}>
        <PageData
          key={++visit}
          locale="en"
          readingView="overview"
          subject={body.subject.id}
          document={composition}
          reads={reads}
          reader={{ spoilerLevel: 0, suitability: 'blur' }}
          messages={{
            unknown: 'Unknown',
            none: 'None',
            unlabelled: 'Unlabelled',
            sources: 'Sources',
            aliases: '',
            search: '',
            spoilerShow: 'Show spoilers',
          }}
        >
          <CompositionRender document={composition} definitions={pageDefinitions} components={dataComponents} />
        </PageData>
      </QueryClientProvider>
    );
    await act(async () => root.render(page));
    expect(supplied).toEqual(original);
    expect(host.querySelector('[data-slot="subject-summary"] h2')?.textContent).toBe(
      m.subject_about({}, { locale: 'en' }),
    );
    expect(host.textContent).not.toContain('Fallback must not replace');
    return page;
  }
  const excerpt = () => host.querySelector('details[data-slot="summary-disclosure"] > summary > span')?.textContent;
  const documentBody = () => host.querySelector('[data-slot="document-body"]')!;
  try {
    // Latin/Arabic/Hebrew/Indic marks, supplementary combining marks, emoji modifiers, ZWJ and flags.
    for (const cluster of ['e\u0301', 'ن\u0651', 'ש\u05B8', 'क\u093F', 'a\u{1D165}', '👩🏽‍🚀', '🇫🇷', '1\uFE0F\u20E3']) {
      const prefix = '界'.repeat(419);
      const text = `${prefix}${cluster} final sentence`;
      await show(fromPlainText(text));
      expect(excerpt()).toBe(`${prefix}…`);
      expect(documentBody().textContent).toBe(text);
      const exact = `${'界'.repeat(420 - cluster.length)}${cluster}`;
      await show(fromPlainText(exact));
      expect(host.querySelector('details')).toBeNull();
      expect(documentBody().textContent).toBe(exact);
      await show(fromPlainText(`${exact} beyond the bound`));
      expect(excerpt()).toBe(`${exact}…`);
    }
    // Formatting splits do not create a character boundary in the visible text.
    for (const [base, continuation] of [
      ['e', '\u0301'],
      ['👩', '🏽‍🚀'],
      ['🇫', '🇷'],
      ['a', '\u{1D165}'],
    ]) {
      await show(
        withNodes([
          { type: 'text', text: `${'x'.repeat(420 - base!.length)}${base}` },
          { type: 'text', text: `${continuation} rest`, marks: [{ type: 'bold' }] },
        ]),
      );
      expect(excerpt()).toBe(`${'x'.repeat(420 - base!.length)}…`);
      expect(documentBody().textContent).toContain(`${base}${continuation} rest`);
    }
    const paragraphs = fromMarkdown('第一段 é\n\n第二段 👩🏽‍🚀\n\nالنهاية الكاملة', 'text');
    const page = await show(paragraphs, 'ja');
    expect(excerpt()).toBe('第一段 é 第二段 👩🏽‍🚀…');
    expect(host.querySelector('summary > span')?.getAttribute('lang')).toBe('ja');
    expect(documentBody().parentElement?.getAttribute('lang')).toBe('ja');
    expect(host.textContent).toContain(new Intl.DisplayNames(['en'], { type: 'language' }).of('ja')!);
    const full = documentBody();
    const disclosure = host.querySelector('details[data-slot="summary-disclosure"]')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('summary')?.textContent).toContain(m.subject_summary_expand({}, { locale: 'en' }));
    disclosure.open = true;
    expect(documentBody()).toBe(full);
    expect(full.textContent).toContain('النهاية الكاملة');
    disclosure.open = false;
    expect(documentBody()).toBe(full);
    expect(renderToStaticMarkup(page)).toContain('النهاية الكاملة');
    await show(fromMarkdown('First paragraph.\n\nSecond paragraph.', 'text'));
    expect(host.querySelector('details')).toBeNull();

    const rich = fromMarkdown(
      `Visible é >!secret ending!< ${'a'.repeat(430)} [Complete notes](https://example.test/notes)`,
      'text',
    );
    await show(rich, 'fr', 1);
    expect(host.textContent).not.toContain('Visible');
    expect(host.querySelector('details')).toBeNull();
    const gate = host.querySelector('button')!;
    gate.focus();
    await act(async () => user.keyboard('{Enter}'));
    expect(gate.getAttribute('aria-expanded')).toBe('true');
    expect(gate.textContent).toContain(m.subject_spoiler_hide({}, { locale: 'en' }));
    expect(excerpt()).not.toContain('secret ending');
    expect(host.querySelector('summary a')).toBeNull();
    expect(documentBody().querySelector('a')?.getAttribute('href')).toBe('https://example.test/notes');
    const inline = documentBody().querySelector('button')!;
    await act(async () => user.click(inline));
    expect(documentBody().textContent).toContain('secret ending');
    await act(async () => user.click(gate));
    expect(gate.getAttribute('aria-expanded')).toBe('false');
    expect(requests).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
