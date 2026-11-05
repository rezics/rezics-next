import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Component, createElement, StrictMode, type ReactNode } from 'react';
import type { KernelClient } from '@rezics/client';
import type { CompositionDocument, SelectedContext } from '@rezics/composition';
import type { MemberPageTarget } from '../src/features/pages/member-list-query';
import type { TypeListTarget } from '../src/features/pages/type-list-model';
import type { TypeListQueryResult } from '../src/features/pages/type-list-query';
import recording from '../src/kernel/recorded/library-collection-members.json';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
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

// UNRUN: connected cache-admission regression for configured and composed list readers.
test('Mounted lists retire old admissions across ABA, error and removal while fresh and public readers remain usable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
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

  const sessionIds = new Map([
    ['reader-a', 'a'.repeat(43)],
    ['reader-b', 'b'.repeat(43)],
  ]);
  const sessionReaders = new Map([...sessionIds].map(([reader, id]) => [id, reader]));
  const credentials = new Map([
    ['a'.repeat(43), { status: 'active', subject: 'reader-a', accessToken: 'reader-a-token', csrfToken: null }],
    ['b'.repeat(43), { status: 'active', subject: 'reader-b', accessToken: 'reader-b-token', csrfToken: null }],
  ]);
  const requestForReader = (reader: string | null) => {
    const id = reader ? sessionIds.get(reader) : undefined;
    return new Request('https://rezics.test/en/library', {
      ...(id ? { headers: { cookie: `__Host-rezics_session=${id}` } } : {}),
    });
  };
  let currentRequest = requestForReader(null);
  let memberDocument: CompositionDocument;
  let memberContext: SelectedContext | undefined;
  const responseHeaders = new Map<string, string>();
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'list-reader-cache-admission',
    WEBSITE_CLIENT_KEY: 'test-key',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        credential: async () => {
          const reader = sessionReaders.get(id);
          return reader ? { ...credentials.get(id)!, signedIn: true } : { status: 'absent' as const };
        },
      }),
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

  type NativeInput = {
    target: TypeListTarget | MemberPageTarget;
    languages: string[];
    continuation?: { node: string; cursor: string };
  };
  type NativeCall = {
    kind: 'configured' | 'member';
    input: NativeInput;
    authorization: string | null;
    document?: CompositionDocument;
    context?: SelectedContext;
    work: Deferred<unknown>;
  };
  const nativeCalls: NativeCall[] = [];
  const native = {
    pages: {
      $read: {
        post: (input: NativeInput, options?: { headers?: HeadersInit }) => {
          const call: NativeCall = {
            kind: 'subject' in input.target || 'route' in input.target ? 'configured' : 'member',
            input,
            authorization: options?.headers ? new Headers(options.headers).get('authorization') : null,
            ...(memberDocument && 'account' in input.target ? { document: memberDocument } : {}),
            ...(memberContext && 'account' in input.target ? { context: memberContext } : {}),
            work: deferred<unknown>(),
          };
          nativeCalls.push(call);
          return call.work.promise;
        },
      },
    },
  } as unknown as KernelClient;
  const originalKernel = await import('../src/kernel/client');
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => native }));

  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    sessionModule,
    typeQueryModule,
    { ConfiguredList },
    { PageData, dataComponents },
    { CompositionRender },
    { layoutComponents, PageRoot, pageDefinitions },
    composition,
    { setLocale },
    { userEvent },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/session/query'),
    import('../src/features/pages/type-list-query'),
    import('../src/features/pages/type-list-page'),
    import('../src/features/pages/data'),
    import('../src/features/pages/render'),
    import('../src/features/pages/layout'),
    import('@rezics/composition'),
    import('../src/paraglide/runtime.js'),
    import('storybook/test'),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const subjectA = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
  const subjectB = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
  const realmA = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
  const realmB = '0192f3a0-6c1e-7b2a-9d4e-000000000202';
  const pageA = JSON.stringify({ subject: subjectA, realm: realmA });
  const pageB = JSON.stringify({ subject: subjectB, realm: realmB });
  const pagePublic = JSON.stringify({ route: '/public-books' });
  const cursorA = 'opaque:A%2F%3D%3D';
  const cursorB = 'opaque:B%2B%3D%3D';
  const publicAdmission = { state: 'public' as const, incarnation: 'public', mode: 'public' as const };
  const privateAdmission = {
    state: 'signed-in' as const,
    expectedReader: 'reader-a',
    incarnation: 'seed-reader-a',
    mode: 'current' as const,
  };
  let typeConfig = { list: 'books-a', page: pageA, cursor: cursorA, locale: 'en' };
  let publicInitial: TypeListQueryResult | undefined;
  let privateInitial: TypeListQueryResult | undefined;
  let firstVisible = true;
  let secondVisible = true;
  let transientVisible = false;
  let locale = 'en';
  let pageTarget: MemberPageTarget = { account: 'member-a' };
  let cacheReader: string | null = 'reader-a';
  let hideRecovery = true;
  let recoveryNode = 'members';
  let memberRows = { members: [recording.members[0]!], next: 'member-next' };
  let errors: unknown[] = [];

  function viewer(reader: string | null) {
    return {
      state: reader ? ('signed-in' as const) : ('signed-out' as const),
      subject: reader,
      csrfToken: null,
    };
  }

  function contextFor(target: TypeListTarget): SelectedContext | undefined {
    return 'subject' in target && target.realm
      ? { id: `context-${target.realm}`, population: { kind: 'realm', id: target.realm, title: 'Test Realm' } }
      : undefined;
  }

  function configuredResponse(call: NativeCall, label: string) {
    const target = call.input.target as TypeListTarget;
    const node =
      call.input.continuation?.node ??
      ('route' in target ? 'public-books' : 'subject' in target && target.subject === subjectA ? 'books-a' : 'books-b');
    const document: CompositionDocument = {
      root: { props: {} },
      content: [
        {
          type: 'TypeList',
          props: { id: node, types: ['schema:Book'], sort: 'name', limit: 24, title: { en: 'Books', ja: '本' } },
        },
      ],
    };
    const context = contextFor(target);
    const plan = composition.planReads(composition.platformRegistry, document, {
      subject: 'subject' in target ? target.subject : null,
      ...(context ? { context } : {}),
      ...(call.input.continuation ? { continuation: call.input.continuation } : {}),
    });
    const key = plan.nodes[node];
    if (!key) throw new Error(`No configured list plan for ${node}`);
    return {
      status: 200,
      data: {
        subject: 'subject' in target ? target.subject : null,
        profile: 'sha256:list-reader-campaign',
        template: { scope: 'route', key: 'list-reader-campaign' },
        ...(context ? { context } : {}),
        document,
        reads: {
          [key]: {
            status: 200,
            body: {
              subjects: [
                {
                  id:
                    label === 'Public SSR'
                      ? '0192f3a0-6c1e-7b2a-9d4e-000000000301'
                      : '0192f3a0-6c1e-7b2a-9d4e-000000000302',
                  type: 'schema:Book',
                  labels: { en: label, ja: label },
                  summary: null,
                },
              ],
              next: null,
              as_of: '2026-11-02T00:00:00.000Z',
            },
          },
        },
        ...(call.input.continuation ? { continuation: call.input.continuation } : {}),
      },
    };
  }

  function memberResponse(call: NativeCall, members: typeof recording.members, next: string | null) {
    const target = call.input.target as MemberPageTarget;
    const doc = call.document!;
    const account = { id: 'resolved-member-account', handle: 'account' in target ? target.account : 'member-a' };
    const plan = composition.planReads(composition.platformRegistry, doc, {
      subject: null,
      account,
      ...(call.context ? { context: call.context } : {}),
      ...(call.input.continuation ? { continuation: call.input.continuation } : {}),
    });
    const reads = Object.fromEntries(
      Object.keys(plan.reads).map((key) => [key, { status: 200, body: { members, next } }]),
    );
    return {
      status: 200,
      data: {
        document: doc,
        account: account.id,
        ...(call.context ? { context: call.context } : {}),
        reads,
      },
    };
  }

  function configuredCalls() {
    return nativeCalls.filter((call) => call.kind === 'configured');
  }
  function memberCalls() {
    return nativeCalls.filter((call) => call.kind === 'member');
  }
  function continuationCalls() {
    return memberCalls().filter((call) => call.input.continuation);
  }

  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  function ErrorBoundary({ children }: { children: ReactNode }) {
    return createElement(CampaignBoundary, { onError: (error) => errors.push(error) }, children);
  }
  class CampaignBoundary extends Component<
    { children: ReactNode; onError: (error: unknown) => void },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error: Error) {
      this.props.onError(error);
    }
    render() {
      return this.state.failed ? createElement('p', { role: 'alert' }, 'Render failed') : this.props.children;
    }
  }

  function Campaign() {
    const privateList = () => createElement(ConfiguredList, { ...typeConfig, initialData: privateInitial });
    const publicList = createElement(ConfiguredList, {
      list: 'public-books',
      page: pagePublic,
      locale: 'en',
      initialData: publicInitial,
    });
    const typeOwners = createElement(
      'div',
      null,
      firstVisible ? createElement('div', { 'data-owner': 'first' }, privateList()) : null,
      secondVisible ? createElement('div', { 'data-owner': 'second' }, privateList()) : null,
      transientVisible ? createElement('div', { 'data-owner': 'transient' }, privateList()) : null,
      createElement('div', { 'data-owner': 'public' }, publicList),
    );
    const initialPlan = composition.planReads(composition.platformRegistry, memberDocument, {
      subject: null,
      ...(memberContext ? { context: memberContext } : {}),
    });
    const reads: Record<string, { status: number; body: unknown }> = Object.fromEntries(
      Object.keys(initialPlan.reads).map((key) => [key, { status: 200, body: memberRows }]),
    );
    if (hideRecovery) reads[initialPlan.nodes[recoveryNode]!] = { status: 404, body: {} };
    return createElement(
      'main',
      null,
      typeOwners,
      createElement(
        PageData,
        {
          locale,
          document: memberDocument,
          pageTarget,
          cacheReader,
          context: memberContext,
          reads,
          messages: { unknown: '', none: '', unlabelled: '', sources: '', aliases: '', search: '' },
        },
        createElement(CompositionRender, {
          document: memberDocument,
          definitions: pageDefinitions,
          components: { ...layoutComponents, ...dataComponents },
          root: PageRoot,
        }),
      ),
      createElement('a', { href: '#after' }, 'After the lists'),
    );
  }

  const flush = async () => {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  };
  const until = async (predicate: () => boolean, label: string) => {
    for (let turn = 0; turn < 200; turn++) {
      if (predicate()) return;
      await flush();
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(QueryClientProvider, { client }, createElement(ErrorBoundary, null, createElement(Campaign))),
        ),
      );
    });
  };
  const list = (node: string) => host.querySelector(`[data-slot="member-list"][data-node="${node}"]`)!;
  const button = (node: string) => list(node).querySelector('button')! as HTMLButtonElement;
  const status = (node: string) => list(node).querySelector('[aria-live="polite"]')!;
  const press = async (trigger: HTMLButtonElement) => {
    trigger.focus();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await flush();
  };
  const session = (reader: string) => ({ state: 'signed-in' as const, subject: reader, csrfToken: null });

  try {
    setLocale('en', { reload: false });
    memberDocument = {
      ...composition.memberContinuationDocument,
      content: composition.memberContinuationDocument.content.map((node, index) =>
        index === 1
          ? {
              ...node,
              props: { ...node.props, source: { kind: 'collection', id: '00000000-0000-8000-8000-000000000019' } },
            }
          : node,
      ),
    };

    // A public SSR result is created before this client has seen a session publication.
    const publicPromise = client.fetchQuery(
      typeQueryModule.typeListQuery('en', 'public-books', pagePublic, undefined, publicAdmission),
    );
    await until(() => configuredCalls().length === 1, 'anonymous public page read');
    const publicCall = configuredCalls()[0]!;
    expect(publicCall.authorization).toBeNull();
    await act(async () => publicCall.work.resolve(configuredResponse(publicCall, 'Public SSR')));
    publicInitial = await publicPromise;

    currentRequest = requestForReader('reader-a');
    client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-a'));
    const privatePromise = client.fetchQuery(
      typeQueryModule.typeListQuery('en', 'books-a', pageA, cursorA, privateAdmission),
    );
    await until(() => configuredCalls().length === 2, 'seed private full-list response');
    const seedCall = configuredCalls()[1]!;
    expect(seedCall.authorization).toBe('Bearer reader-a-token');
    await act(async () => seedCall.work.resolve(configuredResponse(seedCall, 'Seed private rows')));
    privateInitial = await privatePromise;

    await render();
    await until(() => memberCalls().some((call) => !call.input.continuation), 'first viewer recovery');
    const firstRecovery = memberCalls().find((call) => !call.input.continuation)!;
    expect(firstRecovery.authorization).toBe('Bearer reader-a-token');
    expect(firstRecovery.input.target).toEqual({ account: 'member-a' });
    await act(async () =>
      firstRecovery.work.resolve(memberResponse(firstRecovery, [recording.members[0]!], 'recovery-next')),
    );
    await flush();

    expect(host.textContent).toContain('Seed private rows');
    expect(host.textContent).toContain('Public SSR');
    expect(host.textContent).toContain('Snow Country');
    const sessionEntry = client.getQueryCache().find({ queryKey: sessionModule.sessionQuery.queryKey, exact: true })!;
    expect(sessionEntry.getObserversCount()).toBeGreaterThan(1);

    // Two same-address list owners stay independent; removing one leaves the other and shared session observers usable.
    firstVisible = false;
    await render();
    expect(host.querySelector('[data-owner="first"] [data-slot="type-list"]')).toBeNull();
    expect(host.querySelector('[data-owner="second"]')?.textContent).toContain('Seed private rows');
    expect(client.getQueryCache().find({ queryKey: sessionModule.sessionQuery.queryKey, exact: true })).toBeDefined();
    firstVisible = true;
    await render();
    expect(host.querySelector('[data-owner="first"]')?.textContent).toContain('Seed private rows');
    // Keep the loader result mounted once for SSR hydration, then exercise network-owned lifetimes.
    privateInitial = undefined;
    await render();

    // Establish a healthy current continuation before exercising queued old callbacks.
    await press(button('members'));
    await press(button('other-members'));
    await until(() => continuationCalls().length === 2, 'both current continuations');
    const firstContinuations = continuationCalls().slice(0, 2);
    expect(firstContinuations.map((call) => call.input.continuation)).toEqual([
      { node: 'members', cursor: 'recovery-next' },
      { node: 'other-members', cursor: 'member-next' },
    ]);
    for (const call of firstContinuations) {
      await act(async () =>
        call.work.resolve(
          memberResponse(
            call,
            [call.input.continuation?.node === 'members' ? recording.members[1]! : recording.members[2]!],
            'next-current',
          ),
        ),
      );
    }
    await flush();
    expect(status('members').textContent).toContain('New visible items');
    expect(status('other-members').textContent).toContain('New visible items');
    expect(list('members').textContent).toContain('The Tale of Genji');
    expect(list('other-members').textContent).toContain('The Little Prince');

    // Capture both Continue handlers and leave their BFF calls pending across an actual cache error.
    const oldSuccessTrigger = button('members');
    const oldFailureTrigger = button('other-members');
    oldSuccessTrigger.focus();
    await press(oldSuccessTrigger);
    await press(oldFailureTrigger);
    await until(() => continuationCalls().length === 4, 'delayed old member continuations');
    const oldSuccess = continuationCalls()[2]!;
    const oldFailure = continuationCalls()[3]!;
    const oldContinuationCount = continuationCalls().length;

    await act(async () => {
      const query = client.getQueryCache().find({ queryKey: sessionModule.sessionQuery.queryKey, exact: true })!;
      query.setState({ status: 'error', error: new Error('session read failed'), fetchStatus: 'idle' });
      oldSuccessTrigger.click();
      oldFailureTrigger.click();
    });
    expect(continuationCalls()).toHaveLength(oldContinuationCount);
    await render();
    expect(host.textContent).not.toContain('Seed private rows');
    expect(host.textContent).not.toContain('Snow Country');
    expect(host.textContent).not.toContain('The Tale of Genji');
    expect(host.querySelector('[data-slot="member-list-end"]')).toBeNull();
    const focusAfterRetirement = window.document.activeElement;

    // Remove and recreate the cache with the identical reader. This must start new reads and never revive A's old data.
    const typeBase = configuredCalls().length;
    const memberBase = memberCalls().length;
    await act(async () => {
      const query = client.getQueryCache().find({ queryKey: sessionModule.sessionQuery.queryKey, exact: true });
      if (query) client.getQueryCache().remove(query);
      currentRequest = requestForReader('reader-a');
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-a'));
    });
    await until(
      () =>
        configuredCalls().length >= typeBase + 2 &&
        memberCalls().filter((call) => !call.input.continuation).length >= 3,
      'fresh same-reader reads after cache recreation',
    );
    const recreatedTypeReads = configuredCalls().slice(typeBase, typeBase + 2);
    expect(recreatedTypeReads).toHaveLength(2);
    expect(recreatedTypeReads.map((call) => call.authorization)).toEqual([
      'Bearer reader-a-token',
      'Bearer reader-a-token',
    ]);
    const recreatedMemberReads = memberCalls()
      .slice(memberBase)
      .filter((call) => !call.input.continuation);
    expect(recreatedMemberReads).toHaveLength(2);

    // One mounted owner may unmount without cancelling the same-address owner's current query.
    firstVisible = false;
    transientVisible = true;
    await render();
    expect(host.querySelector('[data-owner="second"]')).not.toBeNull();
    await until(() => configuredCalls().length >= typeBase + 3, 'third same-address owner request');
    const transientRead = configuredCalls()[typeBase + 2]!;
    await act(async () =>
      recreatedTypeReads[1]!.work.resolve(configuredResponse(recreatedTypeReads[1]!, 'Surviving owner result')),
    );
    await until(
      () => host.querySelector('[data-owner="second"]')?.textContent?.includes('Surviving owner result') ?? false,
      'remaining same-address owner result',
    );
    expect(host.querySelector('[data-owner="first"]')).toBeNull();
    await act(async () => transientRead.work.resolve(configuredResponse(transientRead, 'Transient owner result')));
    await flush();
    expect(host.querySelector('[data-owner="transient"]')?.textContent).toContain('Transient owner result');
    transientVisible = false;
    firstVisible = true;
    await render();
    await until(() => configuredCalls().length >= typeBase + 4, 'fresh request for remounted owner');
    const remountedOwnerRead = configuredCalls()[typeBase + 3]!;
    await act(async () =>
      remountedOwnerRead.work.resolve(configuredResponse(remountedOwnerRead, 'Remounted owner result')),
    );
    await until(
      () => host.querySelector('[data-owner="first"]')?.textContent?.includes('Remounted owner result') ?? false,
      'remounted owner result',
    );

    // A successful same-reader publication after cache removal must create fresh reads.
    const sameReaderTypeBase = configuredCalls().length;
    const sameReaderMemberBase = memberCalls().filter((call) => !call.input.continuation).length;
    await act(async () => {
      currentRequest = requestForReader('reader-a');
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-a'));
    });
    await until(
      () =>
        configuredCalls().length >= sameReaderTypeBase + 2 &&
        memberCalls().filter((call) => !call.input.continuation).length >= sameReaderMemberBase + 2,
      'fresh reads after same-reader recovery',
    );
    const sameReaderTypeCalls = configuredCalls().slice(sameReaderTypeBase, sameReaderTypeBase + 2);
    const sameReaderMemberReads = memberCalls()
      .filter((call) => !call.input.continuation)
      .slice(sameReaderMemberBase, sameReaderMemberBase + 2);

    // Retire those pending same-reader reads through one synchronous A→B→A batch at the unchanged address.
    const currentTypeBase = configuredCalls().length;
    const currentMemberBase = memberCalls().filter((call) => !call.input.continuation).length;
    await act(async () => {
      currentRequest = requestForReader('reader-b');
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-b'));
      currentRequest = requestForReader('reader-a');
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-a'));
    });
    await until(
      () =>
        configuredCalls().length >= currentTypeBase + 2 &&
        memberCalls().filter((call) => !call.input.continuation).length >= currentMemberBase + 2,
      'fresh A admission after same-batch ABA',
    );
    const currentTypeCalls = configuredCalls().slice(currentTypeBase, currentTypeBase + 2);
    const currentMemberReads = memberCalls()
      .filter((call) => !call.input.continuation)
      .slice(currentMemberBase, currentMemberBase + 2);
    expect(currentTypeCalls).toHaveLength(2);
    expect(currentMemberReads).toHaveLength(2);
    expect(host.textContent).not.toContain('Seed private rows');
    expect(host.textContent).toContain('Public SSR');

    for (const call of sameReaderTypeCalls) {
      if (call === sameReaderTypeCalls[0])
        await act(async () => call.work.resolve({ status: 308, data: { redirect: { to: 'retired-account' } } }));
      else await act(async () => call.work.reject(new Error('retired configured failure')));
    }
    await act(async () => {
      recreatedTypeReads[0]!.work.resolve(configuredResponse(recreatedTypeReads[0]!, 'Unmounted owner result'));
      oldSuccess.work.resolve(memberResponse(oldSuccess, [recording.members[3]!], null));
      oldFailure.work.reject(new Error('retired member continuation failure'));
      recreatedMemberReads[0]!.work.resolve(
        memberResponse(recreatedMemberReads[0]!, [recording.members[1]!], 'retired-next'),
      );
      recreatedMemberReads[1]!.work.resolve(
        memberResponse(recreatedMemberReads[1]!, [recording.members[1]!], 'retired-next'),
      );
      sameReaderMemberReads[0]!.work.resolve(
        memberResponse(sameReaderMemberReads[0]!, [recording.members[1]!], 'retired-next'),
      );
      sameReaderMemberReads[1]!.work.reject(new Error('retired same-reader member failure'));
    });
    await flush();
    expect(errors).toHaveLength(0);
    expect(host.textContent).not.toContain('retired-account');
    expect(host.textContent).not.toContain('The Tale of Genji');
    expect(host.textContent).not.toContain('Kokoro');
    expect(host.textContent).not.toContain('Unmounted owner result');
    expect(host.textContent).not.toContain('Transient owner result');
    expect(host.querySelector('[data-slot="member-list-end"]')).toBeNull();
    expect(window.document.activeElement).toBe(focusAfterRetirement);

    for (const call of currentMemberReads)
      await act(async () => call.work.resolve(memberResponse(call, [recording.members[2]!], 'fresh-A-cursor')));
    for (const call of currentTypeCalls)
      await act(async () => call.work.resolve(configuredResponse(call, 'Fresh A after ABA')));
    await until(() => host.textContent?.includes('Fresh A after ABA') ?? false, 'current A result');
    await flush();
    expect(host.textContent).toContain('The Little Prince');
    expect(status('members').textContent).toBe('');
    expect(status('other-members').textContent).toBe('');
    expect(host.textContent).toContain('Public SSR');

    await press(button('members'));
    await until(() => continuationCalls().length === 5, 'fresh same-reader continuation');
    const freshAContinuation = continuationCalls()[4]!;
    expect(freshAContinuation.input.target).toEqual({ account: 'member-a' });
    expect(freshAContinuation.input.continuation).toEqual({ node: 'members', cursor: 'fresh-A-cursor' });
    expect(freshAContinuation.authorization).toBe('Bearer reader-a-token');
    await act(async () =>
      freshAContinuation.work.resolve(memberResponse(freshAContinuation, [recording.members[3]!], 'after-fresh-A')),
    );
    await flush();
    expect(list('members').textContent).toContain('Kokoro');
    expect(status('members').textContent).toContain('New visible items');

    // Replace the address, target, node, cursor and locale. Retire a captured A continuation before starting B.
    const retiredAddressTrigger = button('other-members');
    retiredAddressTrigger.focus();
    await press(retiredAddressTrigger);
    await until(() => continuationCalls().length === 6, 'pending A continuation before address replacement');
    const retiredAddressCall = continuationCalls()[5]!;
    const typeCallsBeforeB = configuredCalls().length;
    memberDocument = {
      ...memberDocument,
      content: memberDocument.content.map((node, index) =>
        index === 0
          ? { ...node, props: { ...node.props, id: 'members-b' } }
          : { ...node, props: { ...node.props, id: 'other-members-b' } },
      ),
    };
    memberRows = { members: [recording.members[0]!], next: 'opaque:member-B/==' };
    hideRecovery = false;
    pageTarget = { account: 'member-b' };
    cacheReader = 'reader-b';
    locale = 'ja';
    memberContext = {
      id: '00000000-0000-8000-8000-000000000031',
      population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000032', title: 'Reader B' },
    };
    typeConfig = { list: 'books-b', page: pageB, cursor: cursorB, locale: 'ja' };
    await act(async () => {
      currentRequest = requestForReader('reader-b');
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-b'));
    });
    await render();
    await until(() => configuredCalls().length >= typeCallsBeforeB + 2, 'replacement selected-Realm address');
    const readerBTypeCalls = configuredCalls().slice(typeCallsBeforeB);
    expect(
      readerBTypeCalls.map((call) => ({
        target: call.input.target,
        continuation: call.input.continuation,
        language: call.input.languages[0],
        authorization: call.authorization,
      })),
    ).toEqual([
      {
        target: { subject: subjectB, realm: realmB },
        continuation: { node: 'books-b', cursor: cursorB },
        language: 'ja',
        authorization: 'Bearer reader-b-token',
      },
      {
        target: { subject: subjectB, realm: realmB },
        continuation: { node: 'books-b', cursor: cursorB },
        language: 'ja',
        authorization: 'Bearer reader-b-token',
      },
    ]);
    await until(
      () => !!host.querySelector('[data-slot="member-list"][data-node="members-b"]'),
      'replacement member node',
    );
    const currentBTrigger = button('members-b');
    currentBTrigger.focus();
    await act(async () =>
      retiredAddressCall.work.resolve(memberResponse(retiredAddressCall, [recording.members[3]!], null)),
    );
    await flush();
    expect(list('members-b').textContent).not.toContain('Kokoro');
    expect(window.document.activeElement).toBe(currentBTrigger);
    expect(host.textContent).toContain('Public SSR');

    await press(currentBTrigger);
    await until(() => continuationCalls().length === 7, 'healthy replacement-reader continuation');
    const readerBContinuation = continuationCalls()[6]!;
    expect(readerBContinuation.input.target).toEqual({ account: 'member-b' });
    expect(readerBContinuation.input.continuation).toEqual({ node: 'members-b', cursor: 'opaque:member-B/==' });
    expect(readerBContinuation.input.languages[0]).toBe('ja');
    expect(readerBContinuation.authorization).toBe('Bearer reader-b-token');
    await act(async () => {
      for (const call of readerBTypeCalls) call.work.resolve(configuredResponse(call, 'Reader B rows'));
      readerBContinuation.work.resolve(memberResponse(readerBContinuation, [recording.members[1]!], null));
    });
    await until(() => host.textContent?.includes('Reader B rows') ?? false, 'replacement reader result');
    expect(host.textContent).toContain('The Tale of Genji');
    expect(status('members-b').textContent).toContain('End of this list');
    expect(errors).toHaveLength(0);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
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
