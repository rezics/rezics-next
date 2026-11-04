import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import * as start from '../.storybook/react-start';
import { catalogueFileReaderVisit } from '../src/features/catalogue/catalogue-file-reader/model';
import { catalogueFileProfileFixture } from '../src/kernel/fake/catalogue-file-profile';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { CatalogueFileReader } = await import('../src/features/catalogue/catalogue-file-reader/reader');

async function mounted(
  run: (context: {
    host: HTMLElement;
    window: Window;
    client: QueryClient;
    render: (element: ReactNode) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/catalogue-file' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
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
      render: async (element) => act(async () => root.render(createElement(QueryClientProvider, { client }, element))),
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

test('grouped metadata opens one exact association and cache, source, locale and credential replacement retire it', async () => {
  const result = await catalogueFileProfileFixture('ready').read('forward:schema:encodesCreativeWork');
  if (!result.ok) throw new Error('Expected the admitted current catalogue read');
  const publicRead = structuredClone(result.public);
  const association = publicRead.subject.statements['schema:encodesCreativeWork']?.[0];
  if (!association) throw new Error('Expected the current episode association');
  association.qualifiers.push({
    property: { id: 'schema:description', data_type: 'string' },
    value: { type: 'value', content: 'Current source inspection note' },
  });
  association.references = [
    {
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: 'https://source.example/episode' },
        },
      ],
    },
  ];
  const visit = catalogueFileReaderVisit({
    locale: 'en',
    public: publicRead,
    release: result.release,
    digest: result.digest,
  });
  const sourceA = {};
  const sourceB = {};
  const queryData = { kind: 'page', page: sourceA };
  await mounted(async ({ host, window, client, render }) => {
    client.setQueryData(['subject-page-fixture'], queryData);
    client.setQueryData(['session'], {
      state: 'signed-in',
      subject: 'viewer-current',
      csrfToken: 'credential-one',
    });
    const reader = (source: object, locale: string, viewer: string, currentVisit = visit) =>
      createElement(CatalogueFileReader, {
        visit: currentVisit,
        source,
        descriptor: JSON.stringify([locale, viewer]),
        currentHref: `/${locale}/subjects/${result.public.subject.id}/episode-file`,
        recoverCurrentPage: async () => {},
      });
    await render(reader(sourceA, 'en', 'viewer-current'));
    expect(host.querySelector('[data-slot="catalogue-file-reader-technical"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    const episode = [...host.querySelectorAll<HTMLLIElement>('li[data-evidence-kind="association"]')].find((item) =>
      item.textContent?.includes('Episode 1'),
    );
    const inspect = episode?.querySelector<HTMLButtonElement>('[data-inspection-kind="association"]');
    if (!inspect) throw new Error('Expected the admitted episode association control');
    await act(async () => inspect.click());
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')?.textContent).toContain(
      'Current source inspection note',
    );
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')?.textContent).toContain(
      'https://source.example/episode',
    );
    expect(host.querySelector('[data-slot="profile-source-evidence"]')).not.toBeNull();

    const outside = window.document.createElement('button');
    window.document.body.append(outside);
    const close = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-inspection"] button');
    if (!close) throw new Error('Expected an inspection close control');
    await act(async () => {
      close.click();
      outside.focus();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(window.document.activeElement).toBe(outside);

    await act(async () => client.setQueryData(['subject-page-fixture'], queryData));
    await act(async () => inspect.click());
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).not.toBeNull();
    await act(async () => client.setQueryData(['subject-page-fixture'], queryData));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    expect(host.textContent).not.toContain('Current source inspection note');

    await act(async () => inspect.click());
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).not.toBeNull();
    await act(async () =>
      client.setQueryData(['session'], {
        state: 'signed-in',
        subject: 'viewer-current',
        csrfToken: 'credential-two',
      }),
    );
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    expect(host.textContent).not.toContain('Current source inspection note');

    await act(async () => inspect.click());
    await render(reader(sourceB, 'en', 'viewer-current'));
    await render(reader(sourceA, 'en', 'viewer-current'));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    await act(async () => inspect.click());
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).not.toBeNull();
    await render(reader(sourceA, 'en', 'viewer-replaced'));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    expect(host.textContent).not.toContain('Current source inspection note');
    const jaVisit = catalogueFileReaderVisit({
      locale: 'ja',
      public: publicRead,
      release: result.release,
      digest: result.digest,
    });
    await act(async () => inspect.click());
    await render(reader(sourceA, 'ja', 'viewer-current', jaVisit));
    expect(host.querySelector('[data-slot="catalogue-file-inspection"]')).toBeNull();
    expect(host.textContent).not.toContain('Current source inspection note');

    const currentInspect = host.querySelector<HTMLButtonElement>('[data-inspection-kind="association"]');
    if (!currentInspect) throw new Error('Expected the current localized association control');
    await act(async () => currentInspect.click());
    const currentClose = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-inspection"] button');
    if (!currentClose) throw new Error('Expected the current localized inspection close');
    let lateFocus: FrameRequestCallback | undefined;
    let frame = 0;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        lateFocus = callback;
        return ++frame;
      },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: () => {} });
    await act(async () => currentClose.click());
    await render(reader(sourceB, 'ja', 'viewer-current', jaVisit));
    await act(async () => lateFocus?.(0));
    expect(window.document.activeElement).not.toBe(currentInspect);
  });
});

test('current-page retry names its destination, reports failure and fences retired recovery results', async () => {
  const result = await catalogueFileProfileFixture('ready').read();
  if (!result.ok) throw new Error('Expected the admitted current catalogue read');
  const unavailable = catalogueFileReaderVisit({
    locale: 'en',
    public: result.public,
    release: result.release,
    digest: result.digest,
    unavailable: true,
  });
  const sourceA = {};
  const sourceB = {};
  const sourceC = {};
  const attempts: { resolve: () => void; reject: (reason: Error) => void }[] = [];
  const recoverCurrentPage = () =>
    new Promise<void>((resolve, reject) => attempts.push({ resolve, reject: (reason) => reject(reason) }));
  await mounted(async ({ host, window, render }) => {
    const reader = (source: object, path: string) =>
      createElement(CatalogueFileReader, {
        visit: unavailable,
        source,
        descriptor: path,
        currentHref: path,
        recoverCurrentPage,
      });
    await render(reader(sourceA, '/en/subjects/file/episode-file?fileSource=validated#catalogue-file-reader'));
    const link = host.querySelector<HTMLAnchorElement>('[data-slot="catalogue-file-reader-recovery"] a');
    expect(link?.getAttribute('href')).toBe(
      '/en/subjects/file/episode-file?fileSource=validated#catalogue-file-reader',
    );
    const retry = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-reader-recovery"] button');
    if (!retry) throw new Error('Expected current-page retry');
    await act(async () => retry.click());
    expect(retry.getAttribute('data-recovery-state')).toBe('pending');
    expect(host.textContent).toContain('Refreshing this page');

    await render(reader(sourceB, '/en/subjects/other-file/episode-file?fileSource=validated#catalogue-file-reader'));
    const nextRetry = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-reader-recovery"] button');
    if (!nextRetry) throw new Error('Expected retry for the replacement page');
    await act(async () => nextRetry.click());
    expect(attempts).toHaveLength(2);
    await act(async () => attempts[0]!.reject(new Error('old destination rejected')));
    expect(nextRetry.getAttribute('data-recovery-state')).toBe('pending');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => attempts[1]!.resolve());
    expect(nextRetry.getAttribute('data-recovery-state')).toBe('idle');

    await render(reader(sourceC, '/en/subjects/third-file/episode-file'));
    const failedRetry = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-reader-recovery"] button');
    if (!failedRetry) throw new Error('Expected retry for the current page');
    await act(async () => failedRetry.click());
    await act(async () => attempts[2]!.reject(new Error('current destination rejected')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be refreshed');

    await render(reader(sourceA, '/en/subjects/file/episode-file'));
    const lastRetry = host.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-reader-recovery"] button');
    if (!lastRetry) throw new Error('Expected retry after page replacement');
    await act(async () => lastRetry.click());
    await act(async () => window.dispatchEvent(new window.Event('pagehide')));
    await act(async () => attempts[3]!.resolve());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(
      host.querySelector('[data-slot="catalogue-file-reader-recovery"] button')?.getAttribute('data-recovery-state'),
    ).toBe('idle');
  });
});
