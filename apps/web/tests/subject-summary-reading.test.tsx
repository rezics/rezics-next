import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import recordedSubject from '../src/kernel/recorded/subject.json';
import * as start from '../.storybook/react-start';
import { summaryReadingFragment } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const composition = {
  root: { props: {} },
  content: [{ type: 'Summary', props: { id: 'about' } }],
} satisfies CompositionDocument;

test('mounted About chooses exact supplied language and candidate, shows selected evidence, and returns to that reading', async () => {
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
    throw new Error('A filled synopsis must not fetch another language or evidence');
  }) as typeof fetch;
  const body = structuredClone(recordedSubject) as any;
  body.subject.type = 'schema:Book';
  const base = structuredClone(body.subject.statements['schema:abstract'][0]);
  const specifications = [
    ['00000000-0000-4000-8000-000000000101', 'en', 'English first synopsis.', 'https://evidence.test/first'],
    ['00000000-0000-4000-8000-000000000102', 'en', `${'Second candidate paragraph. '.repeat(24)}`, 'https://evidence.test/second'],
    ['00000000-0000-4000-8000-000000000103', 'ja', '日本語のあらすじ。', 'https://evidence.test/japanese'],
  ] as const;
  const candidates = specifications.map(([id, language, text, evidence]) => {
    const statement = structuredClone(base);
    const documentId = `document-${id}`;
    const digest = id.replaceAll('-', '').padEnd(64, '0');
    statement.id = id;
    statement.rank = 'preferred';
    statement.value = { type: 'value', content: { document: documentId, digest, language } };
    statement.qualifiers = [];
    statement.references = [{
      parts: [{
        property: { id: 'schema:url', data_type: 'url' },
        value: { type: 'value', content: evidence },
      }],
    }];
    return {
      statement,
      document: {
        id: documentId,
        subjectId: body.subject.id,
        candidateId: id,
        digest,
        language,
        availability: 'available',
        body: fromPlainText(text),
      },
    };
  });
  body.subject.statements = { 'schema:abstract': candidates.map(({ statement }) => statement) };
  body.documents = Object.fromEntries(candidates.map(({ statement, document }) => [statement.id, document]));
  const plan = planReads(platformRegistry, composition, { subject: body.subject.id });
  const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body }]));
  let renderCount = 0;
  async function show(viewer?: {
    state: 'anonymous' | 'account';
    account?: string;
    context: string;
    actions: { statementPropose: 'allowed' | 'denied' | 'unavailable' };
  }) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PageData
            key={++renderCount}
            locale="en"
            readingView="overview"
            subject={body.subject.id}
            document={composition}
            reads={reads}
            reader={{ spoilerLevel: 0, suitability: 'blur' }}
            {...(viewer ? { viewer } : {})}
            messages={{ unknown: 'Unknown', none: 'None', unlabelled: 'Unlabelled', sources: 'Sources', aliases: '', search: '', spoilerShow: 'Show spoilers' }}
          >
            <CompositionRender document={composition} definitions={pageDefinitions} components={dataComponents} />
          </PageData>
        </QueryClientProvider>,
      );
    });
  }
  try {
    await show({ state: 'anonymous', context: body.subject.context, actions: { statementPropose: 'denied' } });
    const select = () => host.querySelector('select') as HTMLSelectElement;
    expect(select().value).toBe(specifications[0][0]);
    expect(host.textContent).toContain('English first synopsis.');
    expect(host.textContent).toContain('https://evidence.test/first');
    expect(host.textContent).not.toContain('https://evidence.test/second');
    expect(host.querySelector('a[href^="/auth/sign-in"]')?.textContent).toBe(m.account_sign_in({}, { locale: 'en' }));

    await act(async () => user.selectOptions(select(), specifications[1][0]));
    expect(select().value).toBe(specifications[1][0]);
    expect(host.textContent).toContain('Second candidate paragraph.');
    expect(host.textContent).toContain('https://evidence.test/second');
    expect(host.textContent).not.toContain('https://evidence.test/first');
    const disclosure = host.querySelector('details') as HTMLDetailsElement;
    await act(async () => user.click(disclosure.querySelector('summary')!));
    expect(disclosure.open).toBe(true);

    await act(async () => user.selectOptions(select(), specifications[2][0]));
    expect(select().value).toBe(specifications[2][0]);
    expect(host.querySelector('[data-slot="document-body"]')?.parentElement?.getAttribute('lang')).toBe('ja');
    expect((host.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    expect(host.textContent).toContain('日本語のあらすじ。');

    const [returnId, returnLanguage] = specifications[1];
    const returnDocument = candidates[1]!.document;
    window.location.hash = summaryReadingFragment({
      candidateId: returnId,
      documentId: returnDocument.id,
      digest: returnDocument.digest,
      language: returnLanguage,
      locale: 'en',
      context: body.subject.context,
      expanded: true,
      focus: 'reading',
    })!;
    await act(async () => window.dispatchEvent(new window.Event('hashchange')));
    expect(select().value).toBe(returnId);
    expect((host.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(window.document.activeElement?.id).toBe('subject-summary-reading');

    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'account-1', csrfToken: null });
    await show({ state: 'account', account: 'account-1', context: body.subject.context, actions: { statementPropose: 'allowed' } });
    expect(host.querySelector('a[href*="/authored?"]')).not.toBeNull();
    await show({ state: 'account', account: 'account-1', context: body.subject.context, actions: { statementPropose: 'denied' } });
    expect(host.textContent).toContain(m.subject_synopsis_advice_refused({}, { locale: 'en' }));
    await show(undefined);
    expect(host.textContent).toContain(m.subject_synopsis_advice_unavailable({}, { locale: 'en' }));
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
