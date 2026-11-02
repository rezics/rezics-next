import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { Section } from '../src/features/pages/overview';
import type { MemberPageTarget } from '../src/features/pages/member-list-query';
import type { KernelClient } from '@rezics/client';
import type { CompositionDocument, SelectedContext } from '@rezics/composition';
import recording from '../src/kernel/recorded/library-collection-members.json';

// Authored UNRUN for integration execution; uses the real QueryClient and default Members reader.
test('Default composed member recovery admits only its live reader and preserves usable continuation behavior', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
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
  const responses: Array<Section | Promise<Section> | Error> = [];
  const responseHeaders = new Map<string, string>();
  const sessionIds = new Map([
    ['reader-one', 'a'.repeat(43)],
    ['reader-two', 'b'.repeat(43)],
  ]);
  const credentials = new Map([
    ['a'.repeat(43), { status: 'active', subject: 'reader-one', accessToken: 'native-reader-one' }],
    ['b'.repeat(43), { status: 'active', subject: 'reader-two', accessToken: 'native-reader-two' }],
  ]);
  const requestForReader = (reader: string | null) => {
    const id = reader ? sessionIds.get(reader) : undefined;
    return new Request('https://rezics.test/en/library', {
      ...(id ? { headers: { cookie: `__Host-rezics_session=${id}` } } : {}),
    });
  };
  let currentRequest = requestForReader('reader-one');
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'member-list-continuation',
    WEBSITE_CLIENT_KEY: 'test-key',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: (id: string) => ({ credential: async () => credentials.get(id) ?? { status: 'absent' } }),
    },
  };
  mock.module('cloudflare:workers', () => ({ env }));
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({
    ...start,
    getRequest: () => currentRequest,
    setResponseHeader: (name: string, value: string) => responseHeaders.set(name.toLowerCase(), value),
  }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { userEvent } = await import('storybook/test');
  const { planReads, platformRegistry } = await import('@rezics/composition');
  const { memberContinuationDocument } = await import('../src/kernel/fake/composed-member-list');
  let document: CompositionDocument = {
    ...memberContinuationDocument,
    content: memberContinuationDocument.content.map((node, index) =>
      index === 1
        ? {
            ...node,
            props: {
              ...node.props,
              source: { kind: 'collection', id: '00000000-0000-8000-8000-000000000019' },
            },
          }
        : node,
    ),
  };
  let context: SelectedContext | undefined;
  type NativeInput = {
    target: MemberPageTarget;
    languages: string[];
    continuation?: { node: string; cursor: string };
  };
  type NativeCall = {
    input: NativeInput;
    authorization: string | null;
    document: CompositionDocument;
    context?: SelectedContext;
  };
  const nativeCalls: NativeCall[] = [];
  const native = {
    pages: {
      $read: {
        post: async (input: NativeInput, options?: { headers?: HeadersInit }) => {
          const call: NativeCall = {
            input,
            authorization: options?.headers ? new Headers(options.headers).get('authorization') : null,
            document,
            ...(context ? { context } : {}),
          };
          nativeCalls.push(call);
          const answer = responses.shift();
          if (!answer) throw new Error('Unexpected native page read');
          if (answer instanceof Error) throw answer;
          const section = await answer;
          const continuation = call.input.continuation;
          const pagePlan = planReads(platformRegistry, call.document, {
            subject: null,
            account: {
              id: 'resolved-member-account',
              handle: 'account' in call.input.target ? call.input.target.account : 'member-continuation',
            },
            ...(call.context ? { context: call.context } : {}),
            ...(continuation ? { continuation } : {}),
          });
          const reads = Object.fromEntries(
            Object.keys(pagePlan.reads).map((key) => [
              key,
              section.ok ? { status: 200, body: section.body } : { status: section.status ?? 503 },
            ]),
          );
          return {
            status: 200,
            data: {
              document: call.document,
              account: 'resolved-member-account',
              ...(call.context ? { context: call.context } : {}),
              reads,
            },
          };
        },
      },
    },
  } as unknown as KernelClient;
  const originalKernel = await import('../src/kernel/client');
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => native }));
  const { PageData, dataComponents } = await import('../src/features/pages/data');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { layoutComponents, PageRoot, pageDefinitions } = await import('../src/features/pages/layout');
  const { sessionQuery } = await import('../src/session/query');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const viewer = (subject: string | null) => ({
    state: subject ? ('signed-in' as const) : ('signed-out' as const),
    subject,
    csrfToken: null,
  });
  client.setQueryData(sessionQuery.queryKey, viewer('reader-one'));
  const setReader = async (subject: string | null, credentialReader = subject) => {
    await act(async () => {
      currentRequest = requestForReader(credentialReader);
      client.setQueryData(sessionQuery.queryKey, viewer(subject));
    });
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let target: MemberPageTarget = { account: 'member-continuation' };
  let locale = 'en';
  let cacheReader: string | null = null;
  let recoverSource = true;
  let recoveryNode = 'members';
  let initial = { members: recording.members.slice(0, 1), next: 'opaque:next/==' };
  const read = Object.values(planReads(platformRegistry, document, { subject: null }).reads)[0]!;
  const page = (members: typeof recording.members, next: string | null): Section => ({
    ok: true,
    read,
    body: { members, next },
  });
  const render = async () => {
    const plan = planReads(platformRegistry, document, { subject: null });
    const reads = Object.fromEntries(
      Object.keys(plan.reads).map((key) => [
        key,
        recoverSource && key === plan.nodes[recoveryNode] ? { status: 404 } : { status: 200, body: initial },
      ]),
    );
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <PageData
              locale={locale}
              document={document}
              pageTarget={target}
              cacheReader={cacheReader}
              context={context}
              reads={reads}
              messages={{ unknown: '', none: '', unlabelled: '', sources: '', aliases: '', search: '' }}
            >
              <CompositionRender
                document={document}
                definitions={pageDefinitions}
                components={{ ...layoutComponents, ...dataComponents }}
                root={PageRoot}
              />
            </PageData>
            <a href="#after">After the lists</a>
          </QueryClientProvider>
        </StrictMode>,
      );
    });
  };
  const list = (node = document.content[0]!.props.id) =>
    host.querySelector(`[data-slot="member-list"][data-node="${node}"]`)!;
  const status = (node?: string) => list(node).querySelector('[aria-live="polite"]')!;
  const button = (node?: string) => list(node).querySelector('button')!;
  const flush = async () => {
    await act(async () => {
      await Bun.sleep(0);
    });
  };
  const press = async (trigger = button()) => {
    trigger.focus();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await flush();
  };
  const hold = () => {
    let release!: (section: Section) => void;
    responses.push(
      new Promise<Section>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  const holdFailure = () => {
    let reject!: (error: Error) => void;
    responses.push(
      new Promise<Section>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    return reject;
  };
  try {
    // The first public composition result conceals the source. Seed the signed-in reader before
    // mounting, then keep the native page response pending until QueryClient and layout effects commit.
    const firstRecovery = hold();
    await render();
    await flush();
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]?.input.target).toEqual(target);
    expect(nativeCalls[0]?.input.continuation).toBeUndefined();
    expect(nativeCalls[0]?.authorization).toBe('Bearer native-reader-one');
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(host.querySelector('[data-slot="member-list"][data-node="members"]')).toBeNull();
    expect(list('other-members').textContent).toContain('Snow Country');
    await act(async () => {
      firstRecovery(page([recording.members[0]!], 'opaque:next/=='));
    });
    await flush();
    expect(list().textContent).toContain('Snow Country');
    expect(list().textContent).not.toContain('The Tale of Genji');

    // A current recovery's rows are real Members rows and use the normal continuation reader.
    const recoveredTrigger = button();
    const recoveredNext = hold();
    await press(recoveredTrigger);
    expect(nativeCalls.at(-1)?.input.continuation).toEqual({ node: 'members', cursor: 'opaque:next/==' });
    expect(nativeCalls.at(-1)?.authorization).toBe('Bearer native-reader-one');
    await act(async () => {
      recoveredNext(page([recording.members[0]!, recording.members[1]!, recording.members[1]!], 'recovered-next'));
    });
    await flush();
    expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength(2);
    expect(status().textContent).toBe('New visible items in Books: 1. You can load more.');

    // Context replacement retires a delayed success, while the replacement representation can recover.
    context = {
      id: '00000000-0000-8000-8000-000000000011',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000012', title: 'Recovery A' },
    };
    const retiredContext = hold();
    await render();
    await flush();
    context = {
      id: '00000000-0000-8000-8000-000000000021',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000022', title: 'Recovery B' },
    };
    const currentContext = hold();
    await render();
    await flush();
    expect(nativeCalls.at(-2)?.context?.id).toBe('00000000-0000-8000-8000-000000000011');
    expect(nativeCalls.at(-1)?.context?.id).toBe('00000000-0000-8000-8000-000000000021');
    expect(nativeCalls.at(-1)?.context?.population).toEqual({
      kind: 'realm',
      id: '00000000-0000-8000-8000-000000000022',
      title: 'Recovery B',
    });
    await act(async () => {
      retiredContext(page([recording.members[2]!], null));
    });
    await flush();
    expect(host.querySelector('[data-slot="member-list"][data-node="members"]')).toBeNull();
    await act(async () => {
      currentContext(page([recording.members[0]!], 'context-next'));
    });
    await flush();
    expect(list().textContent).toContain('Snow Country');

    // A changed node cannot reuse the old pending read or its query result.
    const retiredNode = holdFailure();
    await render();
    await flush();
    document = {
      ...document,
      content: document.content.map((node, index) =>
        index ? node : { ...node, props: { ...node.props, id: 'replacement-members' } },
      ),
    };
    recoveryNode = 'replacement-members';
    const currentNode = hold();
    await render();
    await flush();
    await act(async () => {
      retiredNode(new Error('Retired node recovery failed'));
    });
    await flush();
    expect(host.querySelector('[data-slot="member-list"][data-node="replacement-members"]')).toBeNull();
    await act(async () => {
      currentNode(page([recording.members[2]!], 'node-next'));
    });
    await flush();
    expect(list('replacement-members').textContent).toContain('The Little Prince');

    // A→B→A creates a new admission incarnation; retired failure and success leave it pending.
    document = {
      ...document,
      content: document.content.map((node, index) =>
        index ? node : { ...node, props: { ...node.props, id: 'members' } },
      ),
    };
    recoveryNode = 'members';
    context = {
      id: '00000000-0000-8000-8000-000000000031',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000032', title: 'ABA context' },
    };
    const retiredA = holdFailure();
    await render();
    await flush();
    const retiredB = hold();
    await setReader('reader-two');
    await flush();
    const currentA = hold();
    await setReader('reader-one');
    await flush();
    expect(nativeCalls.slice(-3).map(({ authorization }) => authorization)).toEqual([
      'Bearer native-reader-one',
      'Bearer native-reader-two',
      'Bearer native-reader-one',
    ]);
    await act(async () => {
      retiredA(new Error('Retired A recovery failed'));
    });
    await act(async () => {
      retiredB(page([recording.members[2]!], null));
    });
    await flush();
    expect(host.querySelector('[data-slot="member-list"][data-node="members"]')).toBeNull();
    await act(async () => {
      currentA(page([recording.members[0]!, recording.members[1]!], 'current-a-next'));
    });
    await flush();
    expect(list().textContent).toContain('The Tale of Genji');

    // The server still compares the expected reader with the prepared credential before native access.
    const beforeMismatch = nativeCalls.length;
    await setReader('reader-two', 'reader-one');
    await flush();
    expect(nativeCalls).toHaveLength(beforeMismatch);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');

    // Unknown session state cannot admit authenticated recovery. Public rows remain readable anonymously.
    for (const state of ['unknown', 'unavailable'] as const) {
      const beforeNonFreshSession = nativeCalls.length;
      await act(async () => {
        currentRequest = requestForReader(null);
        client.setQueryData(sessionQuery.queryKey, { state, subject: null, csrfToken: null });
      });
      await flush();
      expect(nativeCalls).toHaveLength(beforeNonFreshSession);
    }
    recoverSource = false;
    context = undefined;
    target = { account: 'member-continuation' };
    locale = 'en';
    cacheReader = null;
    recoveryNode = 'members';
    initial = { members: recording.members.slice(0, 1), next: 'opaque:next/==' };
    await setReader(null);
    await render();
    expect(host.querySelector('[data-slot="member-list"][data-node="members"]')).not.toBeNull();
    expect(list().textContent).toContain('Snow Country');
    const continuationStart = nativeCalls.length;
    const trigger = button();
    expect(trigger.className).toContain('min-h-11');
    expect(trigger.className).toContain('min-w-11');
    expect(trigger.className).toContain('whitespace-normal');
    expect(trigger.className).toContain('focus-visible:outline-2');
    expect(trigger.getAttribute('aria-describedby')).toBe(status().id);
    const release = hold();
    await press(trigger);
    expect(status().textContent).toBe('Loading more…');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(window.document.activeElement).toBe(trigger);
    await press(trigger); // Repeated activation cannot issue another read.
    expect(nativeCalls).toHaveLength(continuationStart + 1);
    expect(nativeCalls.at(-1)?.input.target).toEqual(target);
    expect(nativeCalls.at(-1)?.input.continuation).toEqual({ node: 'members', cursor: 'opaque:next/==' });
    expect(nativeCalls.at(-1)?.authorization).toBeNull();
    await act(async () => {
      release(page([recording.members[0]!, recording.members[1]!, recording.members[1]!], 'duplicates'));
    });
    await flush();
    expect(status().textContent).toBe('New visible items in Books: 1. You can load more.');
    expect(status().getAttribute('aria-atomic')).toBe('true');
    expect(window.document.activeElement).toBe(trigger);
    expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength(2);
    expect(list().textContent!.indexOf('Snow Country')).toBeLessThan(list().textContent!.indexOf('The Tale of Genji'));
    expect(status('other-members').textContent).toBe('');

    await setReader('reader-two');
    await flush();
    expect(list().textContent).toContain('The Tale of Genji');
    expect(status().textContent).toBe('New visible items in Books: 1. You can load more.');

    responses.push(page([recording.members[1]!], 'empty-end'));
    await press();
    expect(status().textContent).toBe('New visible items in Books: 0. You can load more.');
    expect(window.document.activeElement).toBe(trigger);
    responses.push(page([], 'other-end'));
    await press(button('other-members'));
    expect(status('other-members').textContent).toBe('New visible items in Other books: 0. You can load more.');
    const finish = hold();
    await press(trigger);
    const otherTrigger = button('other-members');
    otherTrigger.focus();
    await act(async () => {
      finish(page([], null));
    });
    await flush();
    expect(status().textContent).toBe('New visible items in Books: 0. End of this list.');
    expect(list().querySelector('button')).toBeNull();
    expect(window.document.activeElement).toBe(otherTrigger);
    responses.push(page([], null));
    await press(otherTrigger);
    const end = list('other-members').querySelector('[data-slot="member-list-end"]')!;
    expect(window.document.activeElement).toBe(end);
    await act(async () => {
      await userEvent.tab();
    });
    expect(window.document.activeElement?.textContent).toBe('After the lists');
    expect(
      nativeCalls.slice(continuationStart).map(({ input }) => ({
        node: input.continuation?.node,
        cursor: input.continuation?.cursor,
      })),
    ).toEqual([
      { node: 'members', cursor: 'opaque:next/==' },
      { node: 'members', cursor: 'duplicates' },
      { node: 'other-members', cursor: 'opaque:next/==' },
      { node: 'members', cursor: 'empty-end' },
      { node: 'other-members', cursor: 'other-end' },
    ]);

    // Successful More replaces the window; sparse pages do not fill themselves. Transport retries keep it.
    initial = { ...initial, next: 'window-0' };
    await render();
    for (let index = 1; index <= 32; index++) {
      responses.push(page([recording.members[2]!], `window-${index}`));
      await press();
      expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength(1);
      expect(list().textContent).not.toContain('Snow Country');
    }
    const failWindow = holdFailure();
    await press();
    expect(list().textContent).toContain('The Little Prince');
    await act(async () => failWindow(new Error('Transport unavailable')));
    await flush();
    expect(list().textContent).toContain('The Little Prince');
    responses.push(page([], 'window-33'));
    await press();
    expect(nativeCalls.slice(-2).map(({ input }) => input.continuation?.cursor)).toEqual(['window-32', 'window-32']);
    expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength(0);
    const callsBeforeSparse = nativeCalls.length;
    await flush();
    expect(nativeCalls).toHaveLength(callsBeforeSparse);
    responses.push(page([recording.members[2]!], 'window-32'));
    await press();
    expect(button().textContent).toBe('Start again');
    expect(list().textContent).not.toContain('The Little Prince');
    responses.push(new Error('Restart unavailable'));
    await press();
    expect(nativeCalls.at(-1)?.input.continuation).toBeUndefined();
    expect(button().textContent).toBe('Start again');
    responses.push(page([recording.members[2]!], 'restarted-next'));
    await press();
    expect(nativeCalls.at(-1)?.input.continuation).toBeUndefined();
    expect(list().textContent).toContain('The Little Prince');
    responses.push(page([recording.members[1]!], 'restarted-next'));
    await press();
    expect(button().textContent).toBe('Start again');
    expect(list().textContent).toContain('The Little Prince');
    expect(list().textContent).not.toContain('The Tale of Genji');
    const retiredRestart = hold();
    await press();
    expect(nativeCalls.at(-1)?.input.continuation).toBeUndefined();
    target = { account: 'replacement-window' };
    await render();
    await act(async () => retiredRestart(page([recording.members[2]!], null)));
    await flush();
    expect(list().textContent).toContain('Snow Country');
    expect(list().textContent).not.toContain('The Little Prince');

    // Each existing reading boundary retires status and ignores its late response, without moving focus.
    for (const boundary of ['target', 'node', 'section', 'reader', 'viewer', 'context', 'locale']) {
      initial = { ...initial, next: `before-${boundary}` };
      if (boundary === 'reader') {
        cacheReader = 'reader-one';
        await setReader('reader-one');
      }
      if (boundary === 'viewer') cacheReader = null;
      await render();
      const late = hold();
      await press();
      if (boundary === 'target') target = { account: 'another-reader' };
      if (boundary === 'node')
        document = {
          ...document,
          content: document.content.map((node, i) =>
            i ? node : { ...node, props: { ...node.props, id: 'replacement' } },
          ),
        };
      if (boundary === 'section') initial = { ...initial, next: 'fresh-section' };
      if (boundary === 'reader') {
        cacheReader = 'reader-two';
        await setReader('reader-two');
      }
      if (boundary === 'viewer') await setReader('reader-two');
      if (boundary === 'context')
        context = {
          id: '00000000-0000-8000-8000-000000000001',
          population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000002', title: 'First context' },
        };
      if (boundary === 'locale') locale = 'fr';
      await render();
      expect(status().textContent).toBe('');
      const freshTrigger = button();
      freshTrigger.focus();
      await act(async () => {
        late(page([recording.members[2]!], null));
      });
      await flush();
      expect(status().textContent).toBe('');
      expect(list().textContent).not.toContain('The Little Prince');
      expect(list().querySelector('[data-slot="member-list-end"]')).toBeNull();
      expect(window.document.activeElement).toBe(freshTrigger);
    }

    // A→B→A is a new reading incarnation. The first A failure cannot change the replacement A while it continues.
    locale = 'en';
    cacheReader = 'reader-one';
    context = {
      id: '00000000-0000-8000-8000-000000000011',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000012', title: 'Context A' },
    };
    await setReader('reader-one');
    initial = { ...initial, next: 'aba-cursor' };
    await render();
    const retiredA = holdFailure();
    await press();
    context = {
      id: '00000000-0000-8000-8000-000000000021',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000022', title: 'Context B' },
    };
    cacheReader = 'reader-two';
    await setReader('reader-two');
    await render();
    context = {
      id: '00000000-0000-8000-8000-000000000011',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000012', title: 'Context A' },
    };
    cacheReader = 'reader-one';
    await setReader('reader-one');
    await render();
    const replacementTrigger = button();
    replacementTrigger.focus();
    const currentA = hold();
    await press(replacementTrigger);
    expect(
      nativeCalls.slice(-2).map(({ input, authorization, context: currentContext }) => ({
        node: input.continuation?.node,
        cursor: input.continuation?.cursor,
        authorization,
        context: currentContext?.id,
        populationId: currentContext?.population.kind === 'realm' ? currentContext.population.id : undefined,
      })),
    ).toEqual([
      {
        node: 'members',
        cursor: 'aba-cursor',
        authorization: 'Bearer native-reader-one',
        context: '00000000-0000-8000-8000-000000000011',
        populationId: '00000000-0000-8000-8000-000000000012',
      },
      {
        node: 'members',
        cursor: 'aba-cursor',
        authorization: 'Bearer native-reader-one',
        context: '00000000-0000-8000-8000-000000000011',
        populationId: '00000000-0000-8000-8000-000000000012',
      },
    ]);
    await act(async () => {
      retiredA(new Error('Retired reader failed'));
    });
    await flush();
    expect(status().textContent).toBe('Loading more…');
    expect(list().textContent).not.toContain('The Little Prince');
    expect(window.document.activeElement).toBe(replacementTrigger);
    await act(async () => {
      currentA(page([recording.members[0]!, recording.members[2]!], 'current-a-next'));
    });
    await flush();
    expect(status().textContent).toBe('New visible items in Books: 1. You can load more.');
    expect(list().textContent).toContain('The Little Prince');
    expect(window.document.activeElement).toBe(replacementTrigger);

    for (const boundary of ['reader', 'context', 'node']) {
      cacheReader = 'reader-one';
      context = {
        id: '00000000-0000-8000-8000-000000000031',
        population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000032', title: 'Failure context A' },
      };
      await setReader('reader-one');
      initial = { ...initial, next: `failure-${boundary}` };
      await render();
      const retiredFailure = holdFailure();
      await press();
      if (boundary === 'reader') {
        cacheReader = 'reader-two';
        await setReader('reader-two');
      }
      if (boundary === 'context')
        context = {
          id: '00000000-0000-8000-8000-000000000041',
          population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000042', title: 'Failure context B' },
        };
      if (boundary === 'node')
        document = {
          ...document,
          content: document.content.map((node, index) =>
            index ? node : { ...node, props: { ...node.props, id: 'failure-node' } },
          ),
        };
      await render();
      const currentTrigger = button();
      currentTrigger.focus();
      await act(async () => {
        retiredFailure(new Error(`Retired ${boundary} continuation failed`));
      });
      await flush();
      expect(status().textContent).toBe('');
      expect(list().textContent).not.toContain('The Little Prince');
      expect(list().querySelector('[data-slot="member-list-end"]')).toBeNull();
      expect(window.document.activeElement).toBe(currentTrigger);
      responses.push(page([recording.members[0]!, recording.members[2]!], `current-${boundary}`));
      await press(currentTrigger);
      expect(status().textContent).toBe('New visible items in Books: 1. You can load more.');
      expect(list().textContent).toContain('The Little Prince');
    }

    // Native refusal semantics: transient/invalid responses keep rows/cursor; retired readings restart.
    locale = 'en';
    for (const code of [202, 400, 422, 503, 401, 403, 404, 409]) {
      initial = { ...initial, next: `refusal-${code}` };
      await render();
      responses.push({ ok: false, status: code });
      await press();
      if (code === 404) {
        expect(host.querySelector(`[data-node="${document.content[0]!.props.id}"]`)).toBeNull();
        continue;
      }
      expect(status().textContent).toBe(code === 202 ? 'These results are being prepared.' : '');
      expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength([401, 403, 409].includes(code) ? 0 : 1);
      responses.push(page([], null));
      await press();
      expect(nativeCalls.at(-1)?.input.continuation?.cursor).toBe(
        [401, 403, 409].includes(code) ? undefined : `refusal-${code}`,
      );
      expect(status().textContent).toContain('0. End of this list.');
    }
    document = {
      ...document,
      content: document.content.map((node) => ({ ...node, props: { ...node.props, paged: false } })),
    };
    initial = { ...initial, next: 'preview' };
    await render();
    expect(list().querySelector('button')).toBeNull();
    expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength(1);
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
});
