import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { act, createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import * as start from '../.storybook/react-start';
import { catalogueFileProfileFixture } from '../src/kernel/fake/catalogue-file-profile';
import { defaultReader, type Reader } from '../src/subject/reader';
import { catalogueFileReaderVisit } from '../src/features/catalogue/catalogue-file-reader/model';
import { parseCatalogueFileCorrectionOrigin } from '../src/features/catalogue/catalogue-file-profile/origin';
import type { SubjectPageData } from '../src/features/pages/subject';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage, pageContext } = await import('../src/features/pages/subject');
const { CatalogueFileReader } = await import('../src/features/catalogue/catalogue-file-reader/reader');
const { subjectPageMessages } = await import('../src/features/pages/route-support');

async function mounted(
  run: (context: {
    host: HTMLElement;
    window: Window;
    client: QueryClient;
    render: (element: ReactNode) => Promise<void>;
    flush: () => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/catalogue-file' });
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  };
  window.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  try {
    await run({
      host,
      window: window as unknown as Window,
      client,
      render: (element) => act(async () => root.render(createElement(QueryClientProvider, { client }, element))),
      flush: () =>
        act(async () => {
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((fn) => fn(0));
        }),
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

async function fixture(spoiled = false) {
  const result = await catalogueFileProfileFixture('ready').read();
  if (!result.ok) throw new Error('Expected admitted File');
  if (spoiled)
    result.public.subject.statements['wdt:P4092']![0]!.qualifiers.push({
      property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
      value: { type: 'value', content: { amount: '+2', unit: '1' } },
    });
  const page: SubjectPageData = {
    subject: result.public.subject.id,
    profile: 'subject',
    template: { scope: 'type', key: result.public.subject.type },
    document: { root: { props: {} }, content: [{ type: 'SubjectHeader', props: { id: 'identity' } }] },
    reads: {},
    catalogue: {
      state: 'released',
      type: result.public.subject.type,
      digest: result.digest,
      definitions: result.release,
    },
  };
  for (const [key, read] of Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ))
    if (read.kind === 'subject') page.reads[key] = { status: 200, body: result.public };
  const href = `/en/subjects/${result.public.subject.id}/episode-file`;
  const subject = (reader?: Reader, address = href, source = page) =>
    createElement(SubjectPage, {
      page: source,
      locale: 'en',
      messages: subjectPageMessages(),
      renderJsonLd: false,
      currentHref: address,
      ...(reader ? { reader } : {}),
    });
  return { result, page, href, subject };
}
const panel = '[data-slot="catalogue-file-inspection"]';
const inspect = '[data-property="wdt:P4092"] [data-inspection-trigger]';
const prepared: Reader = { spoilerLevel: 2, suitability: 'blur' };

test.each([undefined, defaultReader])(
  'ordinary File keeps inspection and focus through first preparation from %j',
  async (sentinel) => {
    const { subject } = await fixture();
    await mounted(async ({ host, client, render, flush, window }) => {
      await render(subject(sentinel));
      const fact = host.querySelector(inspect)!;
      await act(async () => (fact as HTMLButtonElement).click());
      const inspection = host.querySelector(panel);
      expect(inspection).not.toBeNull();
      await act(async () =>
        client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'one' }),
      );
      expect(host.querySelector(panel)).toBe(inspection);
      await render(subject(prepared));
      await flush();
      expect(host.querySelector(inspect)).toBe(fact);
      expect(host.querySelector(panel)).toBe(inspection);
      expect(window.document.activeElement).toBe(inspection!.querySelector('h2'));
      await render(subject({ ...prepared, spoilerLevel: 0 }));
      await render(subject(prepared));
      expect(host.querySelector(panel)).toBeNull();
    });
  },
);

test.each(['exact', 'hidden', 'pointerdown', 'keydown', 'focus', 'collapse'] as const)(
  'pending correction return respects current disclosure and visitor %s',
  async (mode) => {
    const { result, subject, href } = await fixture(mode !== 'collapse');
    await mounted(async ({ host, window, client, render, flush }) => {
      const visit = catalogueFileReaderVisit({
        locale: 'en',
        public: result.public,
        release: result.release,
        digest: result.digest,
        allowCorrection: true,
      });
      await render(createElement(CatalogueFileReader, { visit, readerSpoiler: 2, currentHref: href }));
      await act(async () => (host.querySelector(inspect) as HTMLButtonElement).click());
      const correction = host.querySelector<HTMLAnchorElement>('[data-slot="catalogue-file-reader-correction"] a')!;
      const parsed = parseCatalogueFileCorrectionOrigin(
        new URL(correction.href).searchParams.get('origin'),
        'en',
        result.public.subject.id,
      );
      if (parsed.kind !== 'valid') throw new Error('Expected exact correction origin');
      const address = parsed.origin.returnHref;
      await render(subject(defaultReader, address));
      expect(host.querySelector(panel)).toBeNull();
      if (mode === 'collapse') {
        await act(async () => (host.querySelector(inspect) as HTMLButtonElement).click());
        await act(async () => host.querySelector<HTMLButtonElement>(`${panel} button`)!.click());
      } else if (mode === 'focus') {
        const outside = window.document.createElement('button');
        window.document.body.append(outside);
        await act(async () => {
          outside.focus();
          outside.blur();
        });
      } else if (mode === 'pointerdown' || mode === 'keydown')
        await act(async () => window.dispatchEvent(new window.Event(mode)));
      await act(async () => client.setQueryData(['session'], { state: 'signed-out', csrfToken: null }));
      expect(host.querySelector(panel)).toBeNull();
      await render(subject(mode === 'hidden' ? { ...prepared, spoilerLevel: 0 } : prepared, address));
      await flush();
      const heading = host.querySelector(`${panel} h2`);
      if (mode === 'hidden' || mode === 'collapse') expect(heading).toBeNull();
      else {
        expect(heading).not.toBeNull();
        expect(host.querySelector(panel)?.textContent).toContain('abc123def456');
      }
      if (mode === 'exact') expect(window.document.activeElement).toBe(heading);
      else if (heading) expect(window.document.activeElement).not.toBe(heading);
      if (mode === 'hidden') {
        expect(host.querySelector(inspect)).toBeNull();
        expect(window.document.activeElement).toBe(
          host.querySelector('[data-slot="catalogue-file-reader-identifiers"] h2'),
        );
      }
      await render(subject({ ...prepared, spoilerLevel: 1 }, address));
      expect(host.querySelector(panel)).toBeNull();
    });
  },
);
