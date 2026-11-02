import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';

const subject = '00000000-0000-4000-8000-000000000001';
const context = '00000000-0000-4000-8000-000000000002';
const scalar = (content: string) => ({
  id: '00000000-0000-4000-8000-000000000003',
  rank: 'normal',
  property: { id: 'schema:spoiler', data_type: 'string' },
  value: { type: 'value', content },
  qualifiers: [
    {
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    },
  ],
  references: [],
  rezics: { release: 'sha256:0', revision: 1 },
});
const tag = (index: number, content: string) => ({
  ...scalar(content),
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  property: { id: 'schema:keywords', data_type: 'string' },
  qualifiers: scalar(content).qualifiers,
});
const body = (fact: string, tags: string[]) => ({
  subject: {
    id: subject,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:0',
    context,
    resolution: {},
    labels: { en: 'Subject' },
    descriptions: {},
    aliases: {},
    statements: {
      'schema:spoiler': [scalar(fact)],
      'schema:keywords': tags.map((content, index) => tag(index + 1, content)),
    },
  },
  related: {
    'schema:spoiler': { labels: { en: 'Spoiler fact' } },
    'schema:keywords': { labels: { en: 'Tags' } },
  },
});

test('replacing supplied spoiler facts and tags retires consent while unchanged content keeps it', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/subject' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
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
  const first = body('Fact first', ['Tag first']);
  const next = body('Fact accepted next', ['Tag accepted next', 'New accepted tag']);
  const document = {
    root: { props: {} },
    content: [
      { type: 'Summary', props: { id: 'about' } },
      { type: 'Statements', props: { id: 'facts', properties: ['schema:spoiler'] } },
    ],
  } satisfies CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const revealAll = async () => {
    while (true) {
      const reveal = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reveal spoilers');
      if (!reveal) return;
      await act(async () => reveal.click());
    }
  };
  const render = async (read: ReturnType<typeof body>) => {
    const reads = Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: read }]));
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <PageData
            locale="en"
            subject={subject}
            readingView="overview"
            document={document}
            reads={reads}
            reader={{ spoilerLevel: 0, suitability: 'blur' }}
            messages={{
              unknown: 'Unknown',
              none: 'None',
              unlabelled: 'Unlabelled',
              sources: 'Sources',
              aliases: 'Aliases',
              search: 'Search',
              spoilerShow: 'Reveal spoilers',
            }}
          >
            <>
              <dataComponents.Summary id="about" />
              <dataComponents.Statements id="facts" properties={['schema:spoiler']} />
            </>
          </PageData>
        </QueryClientProvider>,
      ),
    );
  };

  try {
    await render(first);
    expect(host.textContent).not.toContain('Fact first');
    expect(host.textContent).not.toContain('Tag first');
    expect([...host.querySelectorAll('button')].filter((button) => button.textContent === 'Reveal spoilers')).toHaveLength(
      2,
    );

    await revealAll();
    expect(host.textContent).toContain('Fact first');
    expect(host.textContent).toContain('Tag first');
    await render(structuredClone(first));
    expect(host.textContent).toContain('Fact first');
    expect(host.textContent).toContain('Tag first');

    await render(next);
    expect(host.textContent).not.toContain('Fact accepted next');
    expect(host.textContent).not.toContain('Tag accepted next');
    expect(host.textContent).not.toContain('New accepted tag');
    expect([...host.querySelectorAll('button')].filter((button) => button.textContent === 'Reveal spoilers')).toHaveLength(
      2,
    );

    await revealAll();
    await render(structuredClone(next));
    expect(host.textContent).toContain('Fact accepted next');
    expect(host.textContent).toContain('Tag accepted next');
    expect(host.textContent).toContain('New accepted tag');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
