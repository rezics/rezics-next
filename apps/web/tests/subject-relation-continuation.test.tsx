import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { act } from 'react';
import { chromium, type Browser, type Page } from 'playwright';
import { cleanupAll, ownBunProcess, type ProcessCustody } from './support/server-custody.ts';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type { RelationGroupRequest } from '../src/features/pages/relation-stream-query';

// Authored for controller execution. This exercises the real PageStory route/composition and its local page fixtures.
describe('Browser relation continuation', () => {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let storybookCustody: ProcessCustody | undefined;
  let browser: Browser | undefined;
  let origin: string;
  afterAll(async () => {
    await cleanupAll([
      { label: 'Subject continuation browser', run: () => browser?.close(), timeoutMs: 5000 },
      { label: 'Subject continuation Storybook group', run: () => storybookCustody?.close(), timeoutMs: 7000 },
    ]);
  });
  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
    origin = `http://127.0.0.1:${port}`;
    child = Bun.spawn(['bun', 'run', 'storybook', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: join(import.meta.dir, '..'),
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const custody = (storybookCustody = ownBunProcess(child, { label: 'Subject continuation Storybook' }));
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`Storybook exited with ${child.exitCode}:\n${custody.diagnostics()}`);
      try {
        if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(5000) })).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Storybook did not become ready:\n${custody.diagnostics()}`);
      await Bun.sleep(500);
    }
    browser = await chromium.launch();
  }, 180_000);

  async function holdContinuation(page: Page) {
    await page.evaluate(() => {
      const state = window as typeof window & { continuationHeld?: boolean; releaseContinuation?: () => void };
      state.continuationHeld = false;
      const original = window.fetch;
      window.fetch = (async (input, init) => {
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        const response = await original(input, init);
        if (new URL(request.url).pathname === '/v1/pages:read' && request.method === 'POST') {
          const body = await request.clone().json();
          if (body.continuation) {
            state.continuationHeld = true;
            return new Promise<Response>((resolve) => {
              state.releaseContinuation = () => {
                window.fetch = original;
                resolve(response);
              };
            });
          }
        }
        return response;
      }) as typeof fetch;
    });
  }
  async function held(page: Page) {
    await page.waitForFunction(() => (window as typeof window & { continuationHeld?: boolean }).continuationHeld);
  }
  async function release(page: Page) {
    await page.evaluate(() => (window as typeof window & { releaseContinuation?: () => void }).releaseContinuation?.());
  }

  test('Make independent Subject relation continuation usable with keyboard and assistive technology', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const url = `${origin}/iframe.html?id=pages-subjects-subject-relations--continuation&viewMode=story&globals=locale:en;theme:light`;
      await page.goto(url);
      const first = page.locator('[data-slot="relation-stream"][data-node="side-stories"]');
      const other = page.locator('[data-slot="relation-stream"][data-node="adaptations"]');
      const more = first.locator('[data-slot="continue-group"]');
      const otherMore = other.locator('[data-slot="continue-group"]');
      await more.waitFor();
      expect(await first.getByRole('status').textContent()).toBe('');
      expect(await other.getByRole('status').textContent()).toBe('');
      expect(await more.getAttribute('href')).toContain('node=side-stories&cursor=accessible-next');
      expect(await more.getAttribute('aria-describedby')).toBe('side-stories-status');
      expect(await first.getAttribute('aria-live')).toBeNull();
      const target = await more.boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(44);
      expect(target!.width).toBeGreaterThanOrEqual(44);

      await page.evaluate(() => {
        const state = window as typeof window & { continuationReads?: unknown[] };
        state.continuationReads = [];
        const original = window.fetch;
        window.fetch = (async (input, init) => {
          const request = new Request(input instanceof Request ? input.clone() : input, init);
          if (new URL(request.url).pathname === '/v1/pages:read' && request.method === 'POST') {
            const body = await request.clone().json();
            if (body.continuation) state.continuationReads!.push(body.continuation);
          }
          return original(input, init);
        }) as typeof fetch;
      });
      await more.focus();
      await page.keyboard.press('Enter');
      await first.getByRole('link', { name: 'Side story added', exact: true }).waitFor();
      await page.waitForFunction(() =>
        document.querySelector('#side-stories-status')?.textContent?.includes('Visible items in Side stories: 1'),
      );
      expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await first.getByRole('link', { name: 'Side story added', exact: true }).count()).toBe(1);
      expect(await first.getByRole('status').textContent()).toBe(
        'Visible items in Side stories: 1. You can load more.',
      );
      expect(await first.getByRole('status').getAttribute('aria-live')).toBe('polite');
      expect(await first.getByRole('status').textContent()).not.toContain('Side story added');
      expect(await first.textContent()).not.toContain('Withheld title');
      expect(await other.getByRole('status').textContent()).toBe('');
      expect(
        await page.evaluate(() => (window as typeof window & { continuationReads?: unknown[] }).continuationReads),
      ).toEqual([{ node: 'side-stories', cursor: 'accessible-next' }]);

      // A successful empty page reports zero and stays continuable, independently of the populated stream.
      await otherMore.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() =>
        document.querySelector('#adaptations-status')?.textContent?.includes('Visible items in Adaptations: 0'),
      );
      expect(await otherMore.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await more.getAttribute('href')).toContain('cursor=accessible-end');

      // Moving focus while a different stream exhausts must win over its local completion focus.
      await holdContinuation(page);
      await page.keyboard.press('Enter');
      await held(page);
      await more.focus();
      await release(page);
      await other.locator('[data-slot="relation-stream-end"]').waitFor();
      expect(await more.evaluate((element) => element === document.activeElement)).toBe(true);

      // The final native page counts its visible items and replaces the disappearing focused action locally.
      await page.keyboard.press('Enter');
      const end = first.locator('[data-slot="relation-stream-end"]');
      await end.waitFor();
      expect(await first.getByRole('status').textContent()).toBe('Visible items in Side stories: 1. End of this list.');
      expect(await more.count()).toBe(0);
      expect(await end.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await first.getByRole('link', { name: 'Side story added', exact: true }).count()).toBe(1);

      expect(
        await page.evaluate(() => (window as typeof window & { continuationReads?: unknown[] }).continuationReads),
      ).toEqual([
        { node: 'side-stories', cursor: 'accessible-next' },
        { node: 'adaptations', cursor: 'accessible-next' },
        { node: 'adaptations', cursor: 'accessible-end' },
        { node: 'side-stories', cursor: 'accessible-end' },
      ]);

      // Retire a pending section through ordinary route navigation, then focus a different, fresh stream.
      await page.goto(url);
      await more.waitFor();
      await holdContinuation(page);
      await more.focus();
      await page.keyboard.press('Enter');
      await held(page);
      await page
        .locator('[data-slot="view-tabs"]')
        .getByRole('link', { name: /^Overview/ })
        .click();
      await page.waitForFunction(() => !document.querySelector('[data-slot="relation-stream"]'));
      await page
        .locator('[data-slot="view-tabs"]')
        .getByRole('link', { name: /^Relations/ })
        .click();
      await otherMore.waitFor();
      await otherMore.focus();
      await release(page);
      // Wait for React's queued completion to settle without triggering another read.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      expect(await first.getByRole('status').textContent()).toBe('');
      expect(await first.getByRole('link', { name: 'Side story added', exact: true }).count()).toBe(0);
      expect(await otherMore.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await first.locator('[data-slot="relation-stream-end"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 120_000);
});

test('Retired composed continuations cannot alter or invalidate a replacement reading', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/continuation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  type Reading = {
    value: OverviewValue;
    section: Section;
    node: string;
    view: string;
    title: string;
  };
  type Deferred = {
    request: RelationGroupRequest;
    resolve: (section: Section) => void;
    reject: (error: Error) => void;
  };
  const pending: Deferred[] = [];
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  const { relationGroupKey } = await import('../src/features/pages/relation-stream-query');
  mock.module('../src/features/pages/relation-stream-query', () => ({
    relationGroupKey,
    loadRelationGroup: ({ data }: { data: RelationGroupRequest }) =>
      new Promise<Section>((resolve, reject) => pending.push({ request: data, resolve, reject })),
  }));

  const { createElement, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { userEvent } = await import('storybook/test');
  const { defaultReader } = await import('../src/subject/reader');
  const { RelationStream } = await import('../src/features/pages/relation-stream');
  const { sessionQuery } = await import('../src/session/query');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });

  const idA = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
  const idB = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
  const contextA = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
    population: { kind: 'realm' as const, id: '0192f3a0-6c1e-7b2a-9d4e-000000000301', title: 'Context A' },
  };
  const contextB = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000202',
    population: { kind: 'realm' as const, id: '0192f3a0-6c1e-7b2a-9d4e-000000000302', title: 'Context B' },
  };
  const makeReading = (
    subject: string,
    reader: string,
    context: typeof contextA,
    node: string,
    firstLabel: string,
    cursor: string,
  ): Reading => {
    const value = {
      locale: 'en',
      pageTarget: { subject },
      context,
      realm: context.population.id,
      cacheReader: reader,
      subject,
      subjectLabel: firstLabel,
      link: ({ href, children, ...props }: { href: string; children?: unknown; [key: string]: unknown }) =>
        createElement('a', { ...props, href }, children as never),
      reader: defaultReader,
      labels: { spoilerShow: 'Show spoilers', cover: { withheld: '', reveal: '', credit: '', via: '' } },
      unlabelled: 'Untitled',
      spoilerShow: 'Show spoilers',
      details: 'Details',
      cover: 'Cover credit',
      coverVia: 'via',
      licence: 'Licence',
      source: 'Source',
      sources: 'Sources',
      sections: new Map(),
      relations: {},
      relationNodes: [],
    } as unknown as OverviewValue;
    const section: Section = {
      ok: true,
      read: { kind: 'links', id: subject, context: context.id, property: 'schema:author', limit: 12 },
      body: {
        links: [
          {
            subject: node === 'side-stories' ? idA : idB,
            label: firstLabel,
            type: 'schema:Book',
            property: 'schema:author',
            statement: `${node}-${firstLabel}`,
          },
        ],
        next: cursor,
      },
    };
    return { value, section, node, view: 'relations', title: firstLabel };
  };
  const addition = (subject: string, context: typeof contextA, label: string, next: string | null): Section => ({
    ok: true,
    read: { kind: 'links', id: subject, context: context.id, property: 'schema:author', limit: 12 },
    body: {
      links: [
        {
          subject: idB,
          label,
          type: 'schema:Book',
          property: 'schema:author',
          statement: `statement-${label}`,
        },
      ],
      next,
    },
  });

  const firstA = makeReading(idA, 'reader-A', contextA, 'side-stories', 'First A', 'cursor-A');
  const readerB = makeReading(idA, 'reader-B', contextA, 'side-stories', 'Reader B', 'cursor-reader-B');
  const contextBReading = makeReading(idA, 'reader-B', contextB, 'side-stories', 'Context B', 'cursor-context-B');
  const nodeBReading = makeReading(idA, 'reader-B', contextB, 'adaptations', 'Adaptations', 'cursor-node-B');
  let replaceReading: (reading: Reading) => void = () => {};
  let invalidations = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader-A', csrfToken: null });
  function Screen() {
    const [reading, setReading] = useState(firstA);
    replaceReading = setReading;
    return createElement(
      'main',
      null,
      createElement(RelationStream, reading),
      createElement('button', { id: 'outside-reading' }, 'Outside reading'),
    );
  }
  const route = createRootRoute({ component: Screen });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const originalInvalidate = router.invalidate.bind(router);
  Object.defineProperty(router, 'invalidate', {
    configurable: true,
    value: (...args: Parameters<typeof router.invalidate>) => {
      invalidations += 1;
      return originalInvalidate(...args);
    },
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flush = async () => {
    await act(async () => {
      await Bun.sleep(0);
    });
  };
  const stream = (node: string) => host.querySelector(`[data-slot="relation-stream"][data-node="${node}"]`)!;
  const status = (node: string) => stream(node).querySelector('[aria-live="polite"]')!;
  const trigger = (node: string) => stream(node).querySelector<HTMLAnchorElement>('[data-slot="continue-group"]')!;
  const start = async (node: string) => {
    const action = trigger(node);
    action.focus();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await flush();
    return action;
  };
  const replace = async (reading: Reading) => {
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, {
        state: 'signed-in',
        subject: reading.value.cacheReader ?? null,
        csrfToken: null,
      });
      replaceReading(reading);
    });
    await flush();
  };
  const expectRetired = (node: string) => {
    expect(stream(node).querySelector('[data-layout="cover-grid"]')).toBeNull();
    expect(stream(node).querySelector('[data-slot="continue-group"]')).toBeNull();
    expect(stream(node).querySelector('[role="alert"]')).not.toBeNull();
    expect(stream(node).getAttribute('aria-busy')).toBe('false');
    expect(status(node).textContent).toBe('');
    expect(pending).toHaveLength(3);
    expect(invalidations).toBe(0);
  };
  const pendingKey = (request: RelationGroupRequest) => {
    const key = client
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey[0] === 'subject-relation-group')?.queryKey;
    expect(key).toBeDefined();
    expect(key).toEqual(relationGroupKey(request, key?.at(-1) as string));
    return key!;
  };

  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });
    const retiredReaderTrigger = await start('side-stories');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request).toMatchObject({
      reader: 'reader-A',
      context: contextA.id,
      populationId: contextA.population.id,
    });
    await replace(readerB);
    const currentReaderTrigger = trigger('side-stories');
    currentReaderTrigger.focus();
    pending[0]!.resolve(addition(idA, contextA, 'Retired reader row', null));
    await flush();
    expect(status('side-stories').textContent).toBe('');
    expect(stream('side-stories').textContent).toContain('Reader B');
    expect(stream('side-stories').textContent).not.toContain('Retired reader row');
    expect(window.document.activeElement).toBe(currentReaderTrigger);
    expect(invalidations).toBe(0);
    expect(retiredReaderTrigger.isConnected).toBe(false);

    const retiredContextTrigger = await start('side-stories');
    expect(pending).toHaveLength(2);
    await replace(contextBReading);
    const currentContextTrigger = trigger('side-stories');
    currentContextTrigger.focus();
    pending[1]!.reject(new Error('Retired Context request failed'));
    await flush();
    expect(status('side-stories').textContent).toBe('');
    expect(stream('side-stories').textContent).toContain('Context B');
    expect(stream('side-stories').querySelector('[role="alert"]')).toBeNull();
    expect(window.document.activeElement).toBe(currentContextTrigger);
    expect(invalidations).toBe(0);
    expect(retiredContextTrigger.isConnected).toBe(false);

    const retiredNodeTrigger = await start('side-stories');
    expect(pending).toHaveLength(3);
    await replace(nodeBReading);
    const currentNodeTrigger = trigger('adaptations');
    currentNodeTrigger.focus();
    pending[2]!.resolve({ ok: false, status: 503 });
    await flush();
    expect(status('adaptations').textContent).toBe('');
    expect(stream('adaptations').textContent).toContain('Adaptations');
    expect(stream('adaptations').querySelector('[role="alert"]')).toBeNull();
    expect(window.document.activeElement).toBe(currentNodeTrigger);
    expect(invalidations).toBe(0);
    expect(retiredNodeTrigger.isConnected).toBe(false);

    // Returning to healthy A cannot authorize its exact retired reading objects.
    await replace(firstA);
    expectRetired('side-stories');

    // Fresh authoritative fixtures keep the same serialized reader, Context, node and cursor for A/B/A.
    const freshA = makeReading(idA, 'reader-A', contextA, 'side-stories', 'First A', 'cursor-A');
    const freshB = makeReading(idA, 'reader-B', contextB, 'adaptations', 'Adaptations', 'cursor-node-B');
    const replacementA = makeReading(idA, 'reader-A', contextA, 'side-stories', 'First A', 'cursor-A');
    for (const reading of [freshA, replacementA]) {
      expect(reading.section).toEqual(firstA.section);
      expect(reading.section).not.toBe(firstA.section);
      if (reading.section.ok && firstA.section.ok) {
        expect(reading.section.body).not.toBe(firstA.section.body);
        expect(reading.section.body.links).not.toBe(firstA.section.body.links);
        expect((reading.section.body.links as unknown[])[0]).not.toBe((firstA.section.body.links as unknown[])[0]);
      }
    }
    expect(replacementA.section).not.toBe(freshA.section);
    if (replacementA.section.ok && freshA.section.ok) {
      expect(replacementA.section.body).not.toBe(freshA.section.body);
      expect(replacementA.section.body.links).not.toBe(freshA.section.body.links);
      expect((replacementA.section.body.links as unknown[])[0]).not.toBe((freshA.section.body.links as unknown[])[0]);
    }
    await replace(freshA);
    const firstARequest = await start('side-stories');
    expect(pending).toHaveLength(4);
    const retiredAKey = pendingKey(pending[3]!.request);
    await replace(nodeBReading);
    expect(stream('adaptations').querySelector('[data-layout="cover-grid"]')).toBeNull();
    expect(stream('adaptations').querySelector('[data-slot="continue-group"]')).toBeNull();
    expect(stream('adaptations').querySelector('[role="alert"]')).not.toBeNull();
    expect(status('adaptations').textContent).toBe('');
    expect(pending).toHaveLength(4);
    expect(client.getQueryCache().find({ queryKey: retiredAKey, exact: true })).toBeUndefined();
    await replace(freshB);
    expect(stream('adaptations').querySelector('[data-layout="cover-grid"]')?.textContent).toContain('Adaptations');
    expect(trigger('adaptations').getAttribute('href')).toContain('cursor=cursor-node-B');
    await replace(replacementA);
    const replacementATrigger = trigger('side-stories');
    replacementATrigger.focus();
    await start('side-stories');
    expect(pending).toHaveLength(5);
    const currentAKey = pendingKey(pending[4]!.request);
    expect(pending[4]!.request).toEqual(pending[3]!.request);
    expect(currentAKey).not.toEqual(retiredAKey);
    pending[3]!.resolve(addition(idA, contextA, 'Retired A row', null));
    await flush();
    expect(status('side-stories').textContent).toContain('Loading more');
    expect(stream('side-stories').textContent).not.toContain('Retired A row');
    expect(client.getQueryCache().find({ queryKey: retiredAKey, exact: true })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: currentAKey, exact: true })).toBeDefined();
    expect(window.document.activeElement).toBe(replacementATrigger);
    expect(invalidations).toBe(0);
    pending[4]!.resolve(addition(idA, contextA, 'Current A row', 'current-a-next'));
    await flush();
    expect(status('side-stories').textContent).toContain('Visible items');
    expect(status('side-stories').textContent).toContain(': 1. You can load more.');
    expect(stream('side-stories').textContent).toContain('Current A row');
    expect(stream('side-stories').querySelector('[data-layout="cover-grid"]')?.textContent).not.toContain('First A');
    expect(stream('side-stories').textContent).not.toContain('Retired A row');
    expect(trigger('side-stories').getAttribute('href')).toContain('cursor=current-a-next');
    expect(client.getQueryCache().find({ queryKey: retiredAKey, exact: true })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: currentAKey, exact: true })).toBeUndefined();
    expect(window.document.activeElement).toBe(replacementATrigger);
    expect(invalidations).toBe(0);
    expect(firstARequest.isConnected).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}, 30_000);
