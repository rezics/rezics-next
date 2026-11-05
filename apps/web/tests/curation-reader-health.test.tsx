import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment, StrictMode } from 'react';
import { PROFILE_FORMAT, profileDigest, type CompositionDocument, type PresentationProfile } from '@rezics/composition';
import type { PublishInput, PublishResult } from '../src/features/pages/curate';
import type { CurationRead } from '../src/features/pages/curate-actions';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clickHandler(element: Element): (() => void) | undefined {
  const reactPropsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  if (!reactPropsKey) return undefined;
  const props = (element as unknown as Record<string, unknown>)[reactPropsKey] as
    | { onClick?: (event: MouseEvent) => void }
    | undefined;
  const handler = props?.onClick;
  if (!handler) return;
  return () => {
    const event = new element.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'currentTarget', { value: element });
    handler(event);
  };
}

test('mounted curation retires every stale cache owner and recovers only an explicitly retried original intent', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/curate/presentation', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLIFrameElement: window.HTMLIFrameElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));

  const [
    { createRoot },
    { QueryClient, QueryClientProvider, useQueryClient },
    routerTools,
    session,
    page,
    { m },
    runtime,
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
    import('../src/session/query'),
    import('../src/features/pages/curate-view'),
    import('../src/paraglide/messages.js'),
    import('../src/paraglide/runtime.js'),
  ]);
  await runtime.setLocale('en');

  const readerA = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d8801';
  const readerB = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d8802';
  const documentFor = (id: string, text: string): CompositionDocument => ({
    root: { props: {} },
    content: [{ type: 'Heading', props: { id, level: 2, text: { en: text, fr: '' } } }],
  });
  const profileFor = (route: string, text: string): PresentationProfile => ({
    format: PROFILE_FORMAT,
    generic: { views: { overview: documentFor('overview', text), details: documentFor('details', text) } },
    bases: [],
    types: [
      { type: 'schema:Book', views: { overview: documentFor('book', text), details: documentFor('details', text) } },
    ],
    routes: [{ route, document: { root: { props: {} }, content: [] } }],
  });
  const readFor = (reader: string, profile: PresentationProfile, head: number): CurationRead => ({
    ok: true,
    reader,
    profile,
    digest: profileDigest(profile),
    head,
    advice: { viewer: 'account', publish: 'allowed', activate: 'allowed' },
  });
  let profileA = profileFor('/private-a', 'A saved source');
  const profileB = profileFor('/private-b', 'B private source');
  let initial = readFor(readerA, profileA, 7);
  const reads: {
    reader: string;
    work: Deferred<CurationRead>;
    signal: AbortSignal | undefined;
  }[] = [];
  const adviceReads: AbortSignal[] = [];
  let adviceOpening: CurationRead | null = null;
  const publishes: { reader: string; input: PublishInput; work: Deferred<PublishResult> }[] = [];
  const transport = {
    read: (reader: string, signal?: AbortSignal) => {
      const work = deferred<CurationRead>();
      reads.push({ reader, work, signal });
      return work.promise;
    },
    readOpening: (reader: string, signal: AbortSignal) => {
      if (adviceOpening) {
        adviceReads.push(signal);
        return Promise.resolve(adviceOpening);
      }
      return transport.read(reader, signal);
    },
    publish: (input: PublishInput, reader: string) => {
      const work = deferred<PublishResult>();
      publishes.push({ reader, input: structuredClone(input), work });
      return work.promise;
    },
  };

  let activeClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let previousProvider: InstanceType<typeof QueryClient> | null = null;
  let obsoleteProviderControl: (() => void) | undefined;
  let providerProbeRan = false;
  function ProviderReplacementProbe() {
    const client = useQueryClient();
    if (previousProvider && previousProvider !== client) {
      providerProbeRan = true;
      obsoleteProviderControl?.();
      obsoleteProviderControl = undefined;
    }
    previousProvider = client;
    return null;
  }
  const rootRoute = routerTools.createRootRoute({
    loader: () => initial,
    component: () =>
      createElement(
        Fragment,
        null,
        createElement(page.CurationView, { initial: rootRoute.useLoaderData(), transport }),
        createElement(ProviderReplacementProbe),
      ),
  });
  const router = routerTools.createRouter({
    routeTree: rootRoute,
    history: routerTools.createMemoryHistory({ initialEntries: ['/en/curate/presentation'] }),
  });
  const tree = () =>
    createElement(
      StrictMode,
      null,
      createElement(
        QueryClientProvider,
        { client: activeClient },
        createElement(routerTools.RouterProvider, { router }),
      ),
    );
  const host = window.document.createElement('main');
  window.document.body.append(host);
  let root: ReturnType<typeof createRoot> | null = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 150 && !ready(); attempt++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready(), label).toBe(true);
  };
  const show = async () => {
    await act(async () => root?.render(tree()));
  };
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(found, `button ${label}`).toBeDefined();
    return found!;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
    });
  const templateControl = (name: string) => {
    const region = [...host.querySelectorAll('section')].find(
      (section) => section.getAttribute('aria-label') === m.curation_templates(),
    );
    return ([...(region?.querySelectorAll('label') ?? [])].find((label) => label.textContent === name)?.control ??
      null) as InstanceType<typeof window.HTMLSelectElement> | null;
  };
  const select = async (name: string, value: string) =>
    act(async () => {
      const control = templateControl(name) as InstanceType<typeof window.HTMLSelectElement>;
      control.value = value;
      control.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  const field = (name: string) => [...host.querySelectorAll('textarea')].find((item) => item.name === name);
  const edit = async (name: string, value: string) =>
    act(async () => {
      const control = field(name)!;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(control, value);
      control.dispatchEvent(new window.Event('input', { bubbles: true }));
      control.blur();
    });
  const openDetailsHeading = async () => {
    await select(m.curation_template(), JSON.stringify({ scope: 'type', key: 'schema:Book' }));
    await select(m.curation_view(), 'details');
    await settle(() => !!host.querySelector('[data-puck-layer-tree-id="details"]'), 'Puck details heading');
    await act(async () => {
      const row = host.querySelector('[data-puck-layer-tree-id="details"]')!;
      [...row.querySelectorAll('button')].find((item) => item.textContent === 'Heading')!.click();
    });
    await settle(() => !!field('text.en'), 'English heading field');
  };
  const signedIn = (subject: string, csrfToken: string | null = null) => ({
    state: 'signed-in' as const,
    subject,
    csrfToken,
  });
  const admit = async (
    client: InstanceType<typeof QueryClient>,
    reader: string,
    index: number,
    profile: PresentationProfile,
  ) => {
    await act(async () => client.setQueryData(session.sessionQuery.queryKey, signedIn(reader, null)));
    await settle(() => reads.length > index, `fresh BFF admission for ${reader}`);
    expect(reads[index]!.reader).toBe(reader);
    await act(async () => reads[index]!.work.resolve(readFor(reader, profile, reader === readerA ? 7 : 31)));
    await settle(() => templateControl(m.curation_template()) !== null, `mounted admission for ${reader}`);
  };
  const flush = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  try {
    // Initial browser hydration has no session query yet. The same-read SSR curation remains usable.
    await router.load();
    await show();
    await settle(() => templateControl(m.curation_template()) !== null, 'same-read SSR editor');
    expect(host.textContent).toContain('/private-a');
    expect(reads).toHaveLength(0);

    // A new same-reader same-request result replaces a clean initial editor without changing its owner.
    profileA = profileFor('/private-a-replaced', 'A saved source');
    initial = readFor(readerA, profileA, 7);
    await act(async () => router.invalidate());
    await settle(() => host.textContent?.includes('/private-a-replaced') ?? false, 'same-read initial replacement');
    expect(host.textContent).not.toContain('/private-a</option>');
    expect(reads).toHaveLength(0);

    // Null CSRF still permits the healthy same-reader read, and a healthy ordinary fetch preserves edits.
    await act(async () => activeClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerA, null)));
    await openDetailsHeading();
    await edit('text.en', 'A later raw-language draft');
    expect(host.textContent).toContain(m.curation_unsaved());
    const healthyFetch = deferred<ReturnType<typeof signedIn>>();
    let healthyFetchDone: Promise<unknown> | undefined;
    await act(async () => {
      healthyFetchDone = activeClient.fetchQuery({
        queryKey: session.sessionQuery.queryKey,
        queryFn: () => healthyFetch.promise,
        staleTime: 0,
        retry: false,
      });
      await Promise.resolve();
    });
    expect(activeClient.getQueryState(session.sessionQuery.queryKey)?.fetchStatus).toBe('fetching');
    await act(async () => {
      healthyFetch.resolve(signedIn(readerA, null));
      await healthyFetchDone;
    });
    expect(field('text.en')?.value).toBe('A later raw-language draft');
    expect(host.textContent).toContain(m.curation_unsaved());
    expect(reads).toHaveLength(0);

    // First uncertain publication creates immutable original custody and exact operation keys.
    await click(m.curation_publish());
    await settle(() => publishes.length === 1, 'first original publish');
    const original = structuredClone(publishes[0]!.input);
    expect(original.expectedHead).toBe(7);
    expect(original.profile).not.toEqual(profileA);
    expect(original.keys.publish).not.toBe(original.keys.activate);
    adviceOpening = readFor(readerA, profileA, 7);
    await act(async () => publishes[0]!.work.resolve({ ok: false, reason: 'unavailable', outcome: 'unknown' }));
    await settle(() => host.textContent?.includes(m.curation_unknown()) ?? false, 'unknown original outcome');
    await settle(() => adviceReads.length === 1, 'current action advice after uncertain publication');
    adviceOpening = null;

    // Retry is now explicit. Cache A/B/A publishes synchronously retire it before React commits.
    await click(m.curation_retry_original());
    await settle(() => publishes.length === 2, 'explicit retry of original intent');
    expect(publishes[1]!.input).toEqual(original);
    const oldRetry = clickHandler(button(m.curation_retry_original()));
    const oldInspect = clickHandler(button(m.curation_reload_head()));
    const oldReload = clickHandler(button(m.curation_reload()));
    await act(async () => {
      activeClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerB, 'csrf-b'));
      activeClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerA, null));
      oldRetry?.();
      oldInspect?.();
      oldReload?.();
    });
    expect(publishes).toHaveLength(2);
    expect(reads).toHaveLength(1);
    await settle(() => reads.length === 1, 'fresh A admission after batched ABA');
    await act(async () => reads[0]!.work.resolve(readFor(readerA, profileA, 7)));
    await settle(() => host.textContent?.includes(m.curation_unknown()) ?? false, 'retained original after A recovery');
    await openDetailsHeading();
    expect(field('text.en')?.value).toBe('A later raw-language draft');
    const recoveredASelect = templateControl(m.curation_template()) as InstanceType<typeof window.HTMLSelectElement>;
    recoveredASelect.focus();
    const recoveredAStatuses = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    oldRetry?.();
    await act(async () => publishes[1]!.work.resolve({ ok: true, digest: profileDigest(original.profile), head: 8 }));
    await flush();
    expect(publishes).toHaveLength(2);
    expect(window.document.activeElement).toBe(recoveredASelect);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(recoveredAStatuses);
    expect(host.textContent).not.toContain(m.presentation_editor_published());

    // A fresh A visit can explicitly retry only the original profile, head and both original keys.
    await click(m.curation_retry_original());
    await settle(() => publishes.length === 3, 'freshly admitted explicit original retry');
    expect(publishes[2]!.reader).toBe(readerA);
    expect(publishes[2]!.input).toEqual(original);

    // A QueryCache error retains A data but retires the visit before obsolete recovery callbacks run.
    const errorRetry = clickHandler(button(m.curation_retry_original()));
    const errorInspect = clickHandler(button(m.curation_reload_head()));
    await act(async () => {
      try {
        await activeClient.fetchQuery({
          queryKey: session.sessionQuery.queryKey,
          queryFn: async () => {
            throw new Error('session cache health failed');
          },
          staleTime: 0,
          retry: false,
        });
      } catch {
        // The error status with retained A data is the cache event under test.
      }
      errorRetry?.();
      errorInspect?.();
    });
    expect(activeClient.getQueryState(session.sessionQuery.queryKey)?.status).toBe('error');
    expect(activeClient.getQueryData(session.sessionQuery.queryKey)).toEqual(signedIn(readerA, null));
    expect(publishes).toHaveLength(3);
    expect(reads).toHaveLength(1);
    await admit(activeClient, readerA, 1, profileA);
    expect(host.textContent).toContain(m.curation_unknown());
    const recoveredErrorSelect = templateControl(m.curation_template()) as InstanceType<
      typeof window.HTMLSelectElement
    >;
    recoveredErrorSelect.focus();
    const recoveredErrorStatuses = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    await act(async () => publishes[2]!.work.reject(new TypeError('late retired publish rejection')));
    await flush();
    expect(window.document.activeElement).toBe(recoveredErrorSelect);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(
      recoveredErrorStatuses,
    );
    expect(host.textContent).not.toContain(m.presentation_editor_published());

    // Removal and equal-data recreation is a fresh loss; captured retry cannot use the replacement visit.
    await click(m.curation_retry_original());
    await settle(() => publishes.length === 4, 'retry before session query removal');
    const removedRetry = clickHandler(button(m.curation_retry_original()));
    const removedInspect = clickHandler(button(m.curation_reload_head()));
    await act(async () => {
      activeClient.removeQueries({ queryKey: session.sessionQuery.queryKey, exact: true });
      activeClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerA, null));
      removedRetry?.();
      removedInspect?.();
    });
    expect(publishes).toHaveLength(4);
    await settle(() => reads.length === 3, 'fresh A admission after removal and recreation');
    await act(async () => reads[2]!.work.resolve(readFor(readerA, profileA, 7)));
    await settle(() => host.textContent?.includes(m.curation_unknown()) ?? false, 'original remains uncertain');
    const recoveredRemovalSelect = templateControl(m.curation_template()) as InstanceType<
      typeof window.HTMLSelectElement
    >;
    recoveredRemovalSelect.focus();
    const recoveredRemovalStatuses = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    await act(async () => publishes[3]!.work.resolve({ ok: false, reason: 'forbidden' }));
    await flush();
    expect(window.document.activeElement).toBe(recoveredRemovalSelect);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(
      recoveredRemovalStatuses,
    );
    expect(publishes[3]!.input).toEqual(original);

    // A held original-reader recovery inspection cannot write state after an unknown session publication.
    await click(m.curation_reload_head());
    await settle(() => reads.length === 4, 'held original-reader reload');
    const heldReload = reads[3]!;
    const unknownInspect = clickHandler(button(m.curation_reload_head()));
    const unknownRetry = clickHandler(button(m.curation_retry_original()));
    await act(async () => {
      activeClient.setQueryData(session.sessionQuery.queryKey, {
        state: 'unknown',
        subject: null,
        csrfToken: null,
      } as never);
      unknownInspect?.();
      unknownRetry?.();
    });
    expect(publishes).toHaveLength(4);
    expect(reads).toHaveLength(4);
    expect(host.textContent).not.toContain(m.curation_unknown());
    await act(async () => heldReload.work.resolve(readFor(readerA, profileA, 12)));
    await flush();
    expect(host.textContent).not.toContain(m.curation_actual_head({ head: 12, digest: profileDigest(profileA) }));

    // Sign-out after observed admission conceals all private recovery until a fresh matching read.
    await act(async () =>
      activeClient.setQueryData(session.sessionQuery.queryKey, { state: 'signed-out', subject: null }),
    );
    expect(host.textContent).not.toContain('/private-a');
    await admit(activeClient, readerA, 4, profileA);
    expect(host.textContent).toContain(m.curation_unknown());

    // QueryClient replacement retires the old provider synchronously and asks the BFF again.
    const replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    replacementClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerA, null));
    obsoleteProviderControl = clickHandler(button(m.curation_retry_original()));
    activeClient = replacementClient;
    await show();
    expect(providerProbeRan).toBe(true);
    expect(publishes).toHaveLength(4);
    await settle(() => reads.length === 6, 'fresh admission on replacement QueryClient');
    await act(async () => reads[5]!.work.resolve(readFor(readerA, profileA, 7)));
    await settle(
      () => host.textContent?.includes(m.curation_unknown()) ?? false,
      'replacement provider retains original intent',
    );

    // A healthy B reader gets a new publication lane and cannot see A's retained intent or private edits.
    await act(async () => replacementClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerB, 'csrf-b')));
    await settle(() => reads.length === 7, 'fresh B admission');
    await act(async () => reads[6]!.work.resolve(readFor(readerB, profileB, 31)));
    await settle(() => templateControl(m.curation_template()) !== null, 'B editor');
    expect(host.textContent).toContain('/private-b');
    expect(host.textContent).not.toContain('A later raw-language draft');
    expect(host.textContent).not.toContain(m.curation_unknown());
    await openDetailsHeading();
    await edit('text.en', 'B local draft');
    await click(m.curation_publish());
    await settle(() => publishes.length === 5, 'healthy B publication');
    expect(publishes[4]!.reader).toBe(readerB);
    await act(async () =>
      publishes[4]!.work.resolve({ digest: profileDigest(publishes[4]!.input.profile), head: 32, ok: true }),
    );
    await settle(() => host.textContent?.includes(m.presentation_editor_published()) ?? false, 'B publication receipt');
    expect(host.textContent).not.toContain(m.curation_unknown());

    // Return to A through another same-reader BFF admission, then retire a held publish on real unmount.
    await act(async () => replacementClient.setQueryData(session.sessionQuery.queryKey, signedIn(readerA, null)));
    await settle(() => reads.length === 8, 'fresh A after B visit');
    await act(async () => reads[7]!.work.resolve(readFor(readerA, profileA, 7)));
    await settle(() => host.textContent?.includes(m.curation_unknown()) ?? false, 'A original recovery visible');
    await click(m.curation_retry_original());
    await settle(() => publishes.length === 6, 'held A retry before unmount');
    const unmountRetry = clickHandler(button(m.curation_retry_original()));
    await act(async () => {
      root?.unmount();
      root = null;
      unmountRetry?.();
    });
    expect(publishes).toHaveLength(6);

    // A remount uses the retired QueryClient marker and requires a fresh read before explicit recovery returns.
    root = createRoot(host as unknown as HTMLElement);
    await show();
    await settle(() => reads.length === 9, 'fresh admission after unmount');
    // Leaving during a delayed mounted opening retires native work, even if it ignores abort.
    const interrupted = reads[8]!;
    expect(interrupted.signal?.aborted).toBe(false);
    await act(async () => {
      root?.unmount();
    });
    expect(interrupted.signal?.aborted).toBe(true);
    root = createRoot(host as unknown as HTMLElement);
    await show();
    await settle(() => reads.length === 10, 'fresh opening after interrupted return');
    expect(reads[9]!.signal?.aborted).toBe(false);
    host.tabIndex = 0;
    host.focus();
    await act(async () => interrupted.work.resolve(readFor(readerA, profileB, 99)));
    expect(host.textContent).not.toContain('/private-b');
    expect(window.document.activeElement).toBe(host);
    await act(async () => reads[9]!.work.resolve(readFor(readerA, profileA, 7)));
    await settle(() => host.textContent?.includes(m.curation_unknown()) ?? false, 'unmounted intent recovered');
    const recoveredUnmountSelect = templateControl(m.curation_template()) as InstanceType<
      typeof window.HTMLSelectElement
    >;
    recoveredUnmountSelect.focus();
    const recoveredUnmountStatuses = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    await act(async () => publishes[5]!.work.reject(new TypeError('late unmounted publish')));
    await flush();
    expect(window.document.activeElement).toBe(recoveredUnmountSelect);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual(
      recoveredUnmountStatuses,
    );
    expect(publishes[5]!.input).toEqual(original);
  } finally {
    await act(async () => {
      root?.unmount();
      root = null;
    });
    activeClient.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 30000);
