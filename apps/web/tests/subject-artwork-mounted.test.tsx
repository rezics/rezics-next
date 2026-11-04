import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectRead } from '@rezics/client';
import recorded from '../src/kernel/recorded/subject.json';
import * as start from '../.storybook/react-start';
import { m } from '../src/paraglide/messages.js';
import type { ArtworkResult } from '../src/features/catalogue/subject-artwork/read';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

test('ordinary artwork facts gate actual media, retain exact handoffs, recover independently and retire A → B → A', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/art', width: 390 });
  Object.defineProperty(window.HTMLImageElement.prototype, 'complete', { configurable: true, get: () => false });
  const dispatch = window.HTMLImageElement.prototype.dispatchEvent;
  window.HTMLImageElement.prototype.dispatchEvent = function (event: Event) {
    return ['load', 'error'].includes(event.type) ? true : dispatch.call(this, event);
  };
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const [{ createRoot }, { PageData, dataComponents }, { ArtworkReaderContext }] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/data'),
    import('../src/features/catalogue/subject-artwork/session'),
  ]);
  const body = structuredClone(recorded) as unknown as SubjectRead;
  const media = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const statement = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    rank: 'normal' as const,
    property: { id: 'schema:image', data_type: 'media' as const },
    value: { type: 'value' as const, content: media },
    qualifiers: [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' as const },
        value: { type: 'value' as const, content: { amount: '+1', unit: '1' } },
      },
    ],
    references: [
      {
        hash: 'exact-citation',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' as const },
            value: { type: 'value' as const, content: 'https://evidence.test/original' },
          },
        ],
      },
    ],
    rezics: { release: body.subject.release, revision: 1 },
  };
  body.summary = null;
  body.subject.labels = { en: 'Original subject', ja: '元の作品'.repeat(12), 'zh-Hant': '原始作品'.repeat(12) };
  body.subject.statements = {
    'schema:image': [statement],
    'schema:note': [
      {
        ...statement,
        id: 'note',
        qualifiers: [],
        references: [],
        property: { id: 'schema:note', data_type: 'string' },
        value: { type: 'value', content: 'Other readable fact' },
      },
    ],
  };
  body.related['schema:image'] = {
    labels: { en: 'Portrait', ja: '肖像画'.repeat(12), 'zh-Hant': '人物肖像'.repeat(12) },
  };
  const document = {
    root: { props: {} },
    content: [{ type: 'Statements', props: { id: 'facts', properties: ['schema:image', 'schema:note'] } }],
  } satisfies CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: body.subject.id });
  const image = {
    id: media,
    containerId: body.subject.id,
    digest: 'd'.repeat(64),
    width: 400,
    height: 600,
    variants: [{ format: 'webp' as const, width: 240, height: 360 }],
    placeholder: null,
    focalPoint: null,
    credit: {
      rightsHolder: 'Actual artist',
      via: { name: 'Actual source', url: 'https://source.test/art' },
      license: 'CC-BY-4.0',
      obligations: ['cc:Attribution' as const],
    },
  };
  const calls: string[] = [];
  let result: ArtworkResult = { kind: 'ready', image };
  let pending: ((value: ArtworkResult) => void) | undefined;
  let hold = false;
  const read = async (id: string): Promise<ArtworkResult> => {
    calls.push(id);
    return hold
      ? new Promise((resolve) => {
          pending = resolve;
        })
      : result;
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let authority = 1;
  const render = async (source = body, suitability: 'blur' | 'show' = 'blur', locale = 'en') =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ArtworkReaderContext.Provider value={{ incarnation: authority, read }}>
            <PageData
              locale={locale}
              subject={source.subject.id}
              artworkSource={source}
              document={document}
              reads={Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: source }]))}
              reader={{ spoilerLevel: 0, suitability }}
              messages={{
                unknown: 'Unknown',
                none: 'None',
                unlabelled: 'Unlabelled',
                sources: 'Sources',
                aliases: 'Aliases',
                search: 'Search',
                spoilerShow: 'Reveal spoiler',
              }}
            >
              <dataComponents.Statements id="facts" properties={['schema:image', 'schema:note']} />
            </PageData>
          </ArtworkReaderContext.Provider>
        </QueryClientProvider>,
      );
    });
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name)!;
  const click = async (name: string) =>
    act(async () => {
      const trigger = button(name);
      expect(trigger).toBeTruthy();
      trigger.focus();
      trigger.click();
    });
  const reveal = async () => {
    if (button('Reveal spoiler')) await click('Reveal spoiler');
  };
  try {
    await render();
    expect(calls).toHaveLength(0);
    expect(host.querySelector('img')).toBeNull();
    await reveal();
    expect(calls).toHaveLength(0);
    expect(host.textContent).toContain(m.subject_artwork_withheld());
    await click(m.subject_artwork_reveal());
    expect(calls).toEqual([media]);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(`/media/${media}/webp-240`);
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('Portrait — Original subject');
    expect(host.textContent).toContain('Actual artist');
    expect(host.textContent).toContain('Other readable fact');
    expect(statement.references[0]!.parts[0]!.value.content).toBe('https://evidence.test/original');
    const opener = button(m.document_image_inspect());
    await click(m.document_image_inspect());
    expect(window.document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      window.document.activeElement?.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.document.activeElement).toBe(opener);
    await click(m.document_image_inspect());
    const replacement = structuredClone(body);
    replacement.subject.id = 'another-subject';
    await render(replacement);
    expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    await render(body);
    expect(host.querySelector('img')).toBeNull();
    await reveal();
    expect(calls).toHaveLength(1);
    result = { kind: 'unavailable' };
    await click(m.subject_artwork_reveal());
    expect(host.textContent).toContain(m.content_edition_image_unavailable());
    expect(host.textContent).toContain('Other readable fact');
    result = { kind: 'ready', image };
    await click(m.document_image_retry());
    expect(host.querySelector('img')).not.toBeNull();
    authority++;
    await render();
    expect(host.querySelector('img')).toBeNull();
    const refreshed = structuredClone(body);
    await render(refreshed);
    hold = true;
    await reveal();
    await click(m.subject_artwork_reveal());
    expect(host.textContent).toContain(m.candidate_loading());
    await render(replacement);
    await act(async () => pending?.({ kind: 'ready', image }));
    expect(host.querySelector('img')).toBeNull();
    hold = false;
    for (const locale of ['ja', 'zh-Hant']) {
      await render(body, 'show', locale);
      await reveal();
      await click(m.subject_artwork_view({}, { locale: locale as never }));
      expect(host.querySelector('img')?.getAttribute('alt')).toContain(locale === 'ja' ? '肖像画' : '人物肖像');
    }
    const unsupported = structuredClone(body);
    unsupported.subject.statements['schema:image']![0]!.value.content = 'https://external.test/private';
    await render(unsupported, 'show');
    await reveal();
    expect(host.textContent).toContain(m.subject_artwork_unsupported());
    expect(host.querySelector('img')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
