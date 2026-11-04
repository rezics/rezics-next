import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import type { SubjectRead } from '@rezics/client';
import recording from '../src/kernel/recorded/subject-page.json';
import subjectFixture from '../src/kernel/recorded/subject.json';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
type PublicTextResult = { ok: false } | { ok: true; document: Record<string, unknown> };
const readPublicSubjectDocument = mock(async (_input: unknown): Promise<PublicTextResult> => ({ ok: false }));
mock.module('../src/features/pages/subject-queries.ts', () => ({ readPublicSubjectDocument }));
const { Summary, OverviewContext } = await import('../src/features/pages/overview');

const composition = {
  root: { props: {} },
  content: [{ type: 'Summary', props: { id: 'summary' } }],
} satisfies CompositionDocument;

test('an explicit missing synopsis reports failed retry and accepts only its exact bound response', async () => {
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
  const { sessionQuery } = await import('../src/session/query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('Explicit text retry must use the existing server read');
  }) as typeof fetch;

  const body = structuredClone(subjectFixture) as any;
  body.subject.type = 'schema:Book';
  const template = structuredClone(body.subject.statements['schema:abstract']![0]!);
  const missing = structuredClone(template);
  missing.id = '00000000-0000-4000-8000-000000000201';
  missing.rank = 'preferred';
  missing.value = {
    type: 'value',
    content: { language: 'en', document: 'missing-synopsis', digest: 'b'.repeat(64) },
  };
  missing.references = [];
  const other = structuredClone(missing);
  other.id = '00000000-0000-4000-8000-000000000202';
  other.value = {
    type: 'value',
    content: { language: 'ja', document: 'other-synopsis', digest: 'c'.repeat(64) },
  };
  body.subject.statements = { 'schema:abstract': [missing, other] } as SubjectRead['subject']['statements'];
  const filled = {
    [other.id]: {
      id: 'other-synopsis',
      subjectId: body.subject.id,
      candidateId: other.id,
      digest: 'c'.repeat(64),
      language: 'ja',
      availability: 'available',
      body: fromPlainText('Other language body.'),
    },
  };
  const plan = planReads(platformRegistry, recording.document as CompositionDocument, { subject: body.subject.id });
  const planned = Object.values(plan.reads).find((read) => read.kind === 'subject')!;
  const section = {
    ok: true as const,
    read: planned,
    body: { subject: body.subject, related: body.related, documents: filled },
  };
  const value = {
    locale: 'en',
    subject: body.subject.id,
    subjectLabel: 'Bound work',
    link: ({ href, children, lang, className }: { href: string; children: ReactNode; lang?: string; className?: string }) => (
      <a href={href} lang={lang} className={className}>{children}</a>
    ),
    reader: { spoilerLevel: 0, suitability: 'blur' as const },
    labels: { spoilerShow: 'Show', spoilerHide: 'Hide', documentSpoiler: 'Reveal', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Show',
    details: 'Details',
    cover: 'Cover',
    coverVia: 'via',
    licence: 'Licence',
    source: 'Source',
    sources: 'Sources',
    sections: new Map([['summary', section]]),
    viewer: { state: 'anonymous' as const, context: body.subject.context, actions: { statementPropose: 'denied' as const } },
    relations: {},
    relationNodes: [],
  };

  async function show() {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <OverviewContext.Provider value={value}>
          <Summary id="summary" />
        </OverviewContext.Provider>
      </QueryClientProvider>,
    ));
  }
  try {
    readPublicSubjectDocument.mockReset();
    readPublicSubjectDocument.mockResolvedValue({ ok: false });
    await show();
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe(missing.id);
    expect(host.textContent).toContain('not available yet');
    select.value = other.id;
    await act(async () => select.dispatchEvent(new window.Event('change', { bubbles: true })));
    expect(host.textContent).toContain('Other language body.');
    expect(readPublicSubjectDocument).not.toHaveBeenCalled();
    select.value = missing.id;
    await act(async () => select.dispatchEvent(new window.Event('change', { bubbles: true })));
    const retry = host.querySelector('[data-slot="subject-text-unavailable"] a') as HTMLAnchorElement;
    expect(retry.textContent).toContain('Retry');
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(readPublicSubjectDocument).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('could not be read');

    const exact = {
      id: 'missing-synopsis',
      subjectId: body.subject.id,
      candidateId: missing.id,
      digest: 'b'.repeat(64),
      language: 'en',
      availability: 'available',
      body: fromPlainText('Recovered exact synopsis.'),
    };
    readPublicSubjectDocument.mockResolvedValueOnce({ ok: true, document: exact });
    await act(async () => {
      (host.querySelector('[data-slot="subject-text-unavailable"] a') as HTMLAnchorElement).click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Recovered exact synopsis.');
    expect(host.textContent).not.toContain('not available yet');
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
