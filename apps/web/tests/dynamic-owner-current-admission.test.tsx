import { afterAll, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { RulePage, RuleChoicePage } from '../src/library/collection-rule-read';
import type { RuleWrite } from '../src/library/collection-rule-actions';
import type { CollectionWriteResult } from '../src/library/collection-records';
import type {
  PublicationAddress,
  PublicationInput,
  PublicationPage,
  PublicationResult,
} from '../src/library/collection-publication';
import type { SessionEnv } from '../src/session/client';

// UNRUN: composed deferred assertions for the controller's future acceptance run. These controlled
// transports exercise installed composition and actual prepared readers, not native/browser authorization.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const ruleReads: ReturnType<typeof deferred<RulePage>>[] = [];
const choices: (ReturnType<typeof deferred<RuleChoicePage | null>> & { q: string; cursor?: string })[] = [];
const ruleWrites: (ReturnType<typeof deferred<CollectionWriteResult>> & { input: RuleWrite; csrf: string })[] = [];
const publicationReads: (ReturnType<typeof deferred<PublicationPage>> & { address: PublicationAddress })[] = [];
const publicationWrites: (ReturnType<typeof deferred<PublicationResult>> & {
  input: PublicationInput;
  csrf: string | null;
})[] = [];
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => start);
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const original = start.createServerFn();
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: (input: unknown) => unknown) {
        validate = next;
        original.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const delegate = original.handler(handler);
        return ((input?: { data?: unknown; headers?: HeadersInit }) => {
          if (validate?.name === 'publicationAddress') {
            const call = { ...deferred<PublicationPage>(), address: validate(input?.data) as PublicationAddress };
            publicationReads.push(call);
            return call.promise;
          }
          if (validate?.name === 'publicationInput') {
            const call = {
              ...deferred<PublicationResult>(),
              input: validate(input?.data) as PublicationInput,
              csrf: new Headers(input?.headers).get('X-CSRF-Token'),
            };
            publicationWrites.push(call);
            return call.promise;
          }
          return delegate(input as never);
        }) as T;
      },
    };
    return chain;
  },
}));
mock.module('../src/library/collection-rule-actions', () => ({
  readCollectionRule: () => {
    const call = deferred<RulePage>();
    ruleReads.push(call);
    return call.promise;
  },
  readCollectionRuleChoices: ({ data }: { data: { q: string; cursor?: string } }) => {
    const call = { ...deferred<RuleChoicePage | null>(), ...data };
    choices.push(call);
    return call.promise;
  },
  saveCollectionRule: ({ data, headers }: { data: RuleWrite; headers: Record<string, string> }) => {
    const call = { ...deferred<CollectionWriteResult>(), input: data, csrf: headers['X-CSRF-Token']! };
    ruleWrites.push(call);
    return call.promise;
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/alpha/rule' });
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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { CollectionRuleCurrent } = await import('../src/library/collection-rule-current');
const { CollectionPublicationPage } = await import('../src/library/collection-publication-page');
const { loadCollectionRule, loadCollectionRuleChoices, unavailableRuleChoices } =
  await import('../src/library/collection-rule-read');
const { loadCollectionPublication } = await import('../src/library/collection-publication');
const { loadEditableCollectionPage } = await import('../src/library/collection-load');
const { publicationExample } = await import('../src/kernel/fake/collection-publication');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const oldLocale = getLocale();
setLocale('en', { reload: false });
afterAll(async () => {
  setLocale(oldLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});
const session = (subject = 'alice', csrfToken = 'csrf-one') => ({ state: 'signed-in', subject, csrfToken });
function rule(subject = 'alice', collectionId: string | null = 'alpha', revision = 7): RulePage {
  const common = {
    viewerId: subject,
    address: { collectionId },
    intent: crypto.randomUUID(),
    choices: unavailableRuleChoices(),
  };
  common.choices.labels = {
    state: 'ready',
    values: [{ id: 'private-label', name: `${subject} private label` }],
    next: 'label-next',
  };
  return collectionId === null
    ? { ...common, state: 'new' }
    : {
        ...common,
        state: 'ready',
        id: collectionId,
        title: `${subject} private title`,
        rule: {
          filter: { owner: { label: { id: 'private-label' } } },
          sort: 'id',
          revision,
          collectionRevision: revision,
          releaseDigest: `${subject}-private-release`,
          sourceGeneration: '12',
        },
      };
}
function publication(
  subject = 'alice',
  address: PublicationAddress = { id: 'alpha' },
  csrfToken = 'csrf-one',
  revision = 7,
): PublicationPage {
  if (publicationExample.source.state !== 'ready') throw new Error('Expected recorded canonical subjects');
  return {
    viewer: { subject, csrfToken },
    address,
    source: {
      state: 'ready',
      revision,
      page: { ...publicationExample.source.page, id: address.id, revision, curatorAccountId: subject },
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function mounted() {
  ruleReads.length = choices.length = ruleWrites.length = publicationReads.length = publicationWrites.length = 0;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  client.setQueryData(exposureQuery.queryKey, ['collections', 'library_label.list']);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/collections/alpha/rule'] }),
  });
  await router.load();
  const perform = (work: () => void) =>
    act(async () => {
      work();
      await tick();
    });
  return {
    host,
    client,
    perform,
    render: (node: ReactNode) =>
      perform(() =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>{node}</RouterContextProvider>
          </QueryClientProvider>,
        ),
      ),
    button(label: string) {
      const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (value) => value.textContent?.trim() === label,
      );
      expect(node).toBeDefined();
      return node!;
    },
    submit: () =>
      perform(() =>
        host
          .querySelector('form')!
          .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
      ),
    async close() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
function handler(node: Element, name: string): (event?: unknown) => void {
  const key = Object.keys(node).find((value) => value.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key]![name]!;
}
const settle = <T,>(call: ReturnType<typeof deferred<T>>, result: T) =>
  act(async () => {
    call.resolve(result);
    await tick();
  });

// The contract's acceptance name is deliberately retained as the composed outcome boundary.
describe('Saved dynamic rule creation editing choices and selected publication accept only the actual current admitted owner and originating address lifetime', () => {
  test('actual readers bind new/rule/label and empty/preparing publication provenance with one preparation, refusing mismatches', async () => {
    let preparations = 0;
    const env = {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: 'unused',
      SESSIONS: {
        idFromName: (id: string) => id,
        get: () => ({
          credential: async () => {
            preparations++;
            return { status: 'active', subject: 'bob', accessToken: 'actual-bob', csrfToken: 'B'.repeat(22) };
          },
        }),
      },
    } as unknown as Partial<SessionEnv>;
    const request = () =>
      new Request('https://site.test/read', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } });
    const calls: Request[] = [];
    let preparing = false;
    const native = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const call = new Request(input, init);
        calls.push(call);
        const path = new URL(call.url).pathname;
        if (path.endsWith('/rule'))
          return Response.json({ rule: (rule('bob') as Extract<RulePage, { state: 'ready' }>).rule });
        if (path === '/v1/collections/alpha')
          return Response.json({
            collection: {
              id: 'alpha',
              curatorAccountId: 'bob',
              revision: 7,
              membershipKind: 'dynamic',
              title: 'Private',
              visibility: 'private',
              description: null,
            },
          });
        if (path.endsWith('/members'))
          return preparing
            ? Response.json({ preparing: true }, { status: 202 })
            : Response.json({ members: [], next: null });
        if (path === '/v1/libraryLabels') return Response.json({ labels: [], next: null });
        return Response.json({ code: 'semantic_not_ready' }, { status: 503 });
      },
    });
    const fresh = await loadCollectionRule(native, request(), env);
    expect(fresh).toMatchObject({ state: 'new', viewerId: 'bob', address: { collectionId: null } });
    const saved = await loadCollectionRule(native, request(), env, 'alpha');
    expect(saved).toMatchObject({ state: 'ready', viewerId: 'bob', address: { collectionId: 'alpha' } });
    const labels = await loadCollectionRuleChoices(native, request(), env, { q: 'reading', cursor: 'label-cursor' });
    expect(labels).toMatchObject({
      viewerId: 'bob',
      address: { q: 'reading', cursor: 'label-cursor' },
      choices: { labels: { state: 'ready', values: [] } },
    });
    expect(preparations).toBe(3);
    expect(
      Object.fromEntries(
        new URL(calls.findLast((call) => new URL(call.url).pathname === '/v1/libraryLabels')!.url).searchParams,
      ),
    ).toEqual({ limit: '100', q: 'reading', cursor: 'label-cursor' });
    for (const mode of ['empty', 'preparing', 'viewer', 'address', 'editor', 'missing'] as const) {
      preparing = mode === 'preparing';
      const req = request();
      const before = preparations;
      const result = await loadCollectionPublication(req, { id: 'alpha' }, async () => {
        const page = await loadEditableCollectionPage(native, req, env, { id: 'alpha', editor: true });
        if (mode === 'viewer') page.provenance = { ...page.provenance!, viewerId: 'alice' };
        if (mode === 'address') page.provenance = { ...page.provenance!, request: 'wrong-address' };
        if (mode === 'editor')
          page.provenance = { ...page.provenance!, request: JSON.stringify(['page', 'alpha', null, false, []]) };
        if (mode === 'missing') delete page.provenance;
        return page;
      });
      expect(preparations - before).toBe(1);
      expect(result.source.state).toBe(mode === 'empty' ? 'ready' : mode === 'preparing' ? 'preparing' : 'denied');
      expect(result.viewer?.subject ?? null).toBe(mode === 'empty' || mode === 'preparing' ? 'bob' : null);
    }
    for (const call of calls) expect(call.headers.get('authorization')).toBe('Bearer actual-bob');
  });

  test('real collections groups enable rules; cache viewer/admission/address ABA retires old handlers while B works before A finishes', async () => {
    const ui = await mounted();
    const alice = rule();
    const navigation: string[] = [];
    const show = (page: RulePage, id: string | null = 'alpha') =>
      ui.render(<CollectionRuleCurrent page={page} collectionId={id} navigate={(value) => navigation.push(value)} />);
    try {
      await show(alice);
      expect(ui.host.textContent).toContain('alice-private-release');
      const oldSubmit = handler(ui.host.querySelector('form')!, 'onSubmit');
      const oldReload = handler(ui.button(m.library_collection_reload()), 'onClick');
      const oldChoices = handler(ui.button(m.search_apply()), 'onClick');
      await ui.submit();
      expect(ruleWrites).toHaveLength(1);
      await ui.perform(() => {
        ui.client.setQueryData(sessionQuery.queryKey, session('bob', 'bob-csrf'));
        oldSubmit({ preventDefault() {} });
        oldReload();
        oldChoices();
        expect(ruleWrites).toHaveLength(1);
        expect(ruleReads).toHaveLength(0);
        expect(choices).toHaveLength(0);
      });
      await show(rule('bob'));
      await ui.submit();
      expect(ruleWrites).toHaveLength(2);
      expect(ruleWrites[1]!.csrf).toBe('bob-csrf');
      await settle(ruleWrites[0]!, { ok: true, id: 'old-alice-result' });
      expect(navigation).toEqual([]);
      expect(ui.button(m.library_collection_save_pending()).disabled).toBe(true);
      await settle(ruleWrites[1]!, { ok: false, reason: 'conflict' });
      await ui.perform(() => ui.client.setQueryData(sessionQuery.queryKey, session()));
      await show(alice);
      expect(ui.host.querySelector('form, select, a')).toBeNull();
      await ui.perform(() => ui.button(m.library_follow_retry()).click());
      await settle(ruleReads[0]!, rule());
      const currentSubmit = handler(ui.host.querySelector('form')!, 'onSubmit');
      const currentReload = handler(ui.button(m.library_collection_reload()), 'onClick');
      const currentChoices = handler(ui.button(m.search_apply()), 'onClick');
      await ui.perform(() => {
        ui.client.setQueryData(sessionQuery.queryKey, session('bob', 'replacement-credential'));
        currentSubmit({ preventDefault() {} });
        currentReload();
        currentChoices();
        expect(ruleWrites).toHaveLength(2);
        expect(ruleReads).toHaveLength(1);
        expect(choices).toHaveLength(0);
        ui.client.setQueryData(sessionQuery.queryKey, session());
        ui.client.setQueryData(exposureQuery.queryKey, []);
        ui.client.setQueryData(exposureQuery.queryKey, ['collections', 'library_label.list']);
        currentSubmit({ preventDefault() {} });
        expect(ruleWrites).toHaveLength(2);
      });
      expect(ui.host.querySelector('form, select, a')).toBeNull();
      await show(rule('alice', 'beta'), 'beta');
      expect(ui.host.querySelector('form')).not.toBeNull();
      await show(alice);
      expect(ui.host.querySelector('form')).toBeNull();
      await show(rule('alice', null), null);
      expect(ui.host.querySelector('input[required]')).not.toBeNull();
      await ui.perform(() => ui.button(m.search_apply()).click());
      await settle(choices[0]!, {
        viewerId: 'bob',
        address: { q: '', cursor: null },
        choices: unavailableRuleChoices(),
      });
      expect(ui.host.querySelector('form, select, a')).toBeNull();
      await ui.perform(() => ui.button(m.library_follow_retry()).click());
      await settle(ruleReads[1]!, rule('alice', null));
      expect(ui.host.querySelector('form')).not.toBeNull();
      await ui.perform(() => ui.button(m.library_collection_reload()).click());
      await settle(ruleReads[2]!, { state: 'denied' });
      expect(ui.host.querySelector('form, select, a')).toBeNull();
      for (const value of [
        { state: 'unknown', subject: null, csrfToken: null },
        { state: 'signed-out', subject: null, csrfToken: null },
        session('', 'csrf'),
        session('alice', ''),
      ]) {
        await ui.perform(() => ui.client.setQueryData(sessionQuery.queryKey, value));
        expect(ui.host.querySelector('form, select, a')).toBeNull();
      }
    } finally {
      await ui.close();
    }
  });

  test('label q/cursor provenance is fenced; uncertain create/edit retain exact payload and key through refresh and nonempty CSRF rotation', async () => {
    for (const id of ['alpha', null]) {
      const ui = await mounted();
      const show = (page: RulePage) => ui.render(<CollectionRuleCurrent page={page} collectionId={id} />);
      try {
        await show(rule('alice', id));
        await ui.perform(() => ui.button(m.search_apply()).click());
        const wrong = rule('alice', id) as Extract<RulePage, { state: 'ready' | 'new' }>;
        wrong.choices.labels.values = [{ id: 'leak', name: 'Wrong q private choice' }];
        await settle(choices[0]!, {
          viewerId: 'alice',
          address: { q: 'foreign-q', cursor: null },
          choices: wrong.choices,
        });
        expect(ui.host.textContent).not.toContain('Wrong q private choice');
        await ui.perform(() => ui.button(m.library_label_more()).click());
        expect(choices[1]!.cursor).toBe('label-next');
        await settle(choices[1]!, {
          viewerId: 'alice',
          address: { q: '', cursor: 'wrong-cursor' },
          choices: wrong.choices,
        });
        expect(ui.host.textContent).not.toContain('Wrong q private choice');
        if (id === null)
          await ui.perform(() => {
            const title = ui.host.querySelector('input[required]')!;
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
              title,
              'Captured title',
            );
            title.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
          });
        await ui.submit();
        const original = structuredClone(ruleWrites[0]!.input);
        await show(rule('alice', id, 99)); // A same-owner loader refresh cannot reset in-flight intent or lock.
        await ui.perform(() => ui.client.setQueryData(sessionQuery.queryKey, session('alice', 'csrf-two')));
        expect(ui.button(m.library_collection_save_pending()).disabled).toBe(true);
        await settle(ruleWrites[0]!, { ok: false, reason: 'unavailable' });
        await ui.perform(() => ui.button(m.library_collection_reload()).click());
        await settle(ruleReads[0]!, rule('alice', id, 21));
        expect(ruleWrites).toHaveLength(1);
        expect(ui.host.querySelector('fieldset')!.disabled).toBe(true);
        await ui.submit();
        expect(ruleWrites[1]!.input).toEqual(original);
        expect(ruleWrites[1]!.csrf).toBe('csrf-two');
        await settle(ruleWrites[1]!, { ok: false, reason: 'conflict' });
        await ui.perform(() => ui.button(m.library_collection_reload()).click());
        await settle(ruleReads[1]!, rule('alice', id, 22));
        await ui.submit();
        expect(ruleWrites[2]!.input.idempotencyKey).not.toBe(original.idempotencyKey);
        if (id) expect(ruleWrites[2]!.input.revision).toBe(22);
        else expect(ruleWrites[2]!.input.title).toBe('Captured title');
        await settle(ruleWrites[2]!, { ok: true, id: id ?? 'created' });
      } finally {
        await ui.close();
      }
    }
  });

  test('publication requires actual groups, fences viewer/admission/address ABA, and preserves the exact uncertain selection across source/CSRF refresh', async () => {
    const ui = await mounted();
    const show = (address: PublicationAddress = { id: 'alpha' }) =>
      ui.render(<CollectionPublicationPage address={address} />);
    const choose = () =>
      ui.perform(() => {
        const boxes = ui.host.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
        boxes[0]!.click();
        boxes[boxes.length - 1]!.click();
      });
    try {
      await ui.perform(() => ui.client.setQueryData(exposureQuery.queryKey, []));
      await show();
      expect(publicationReads).toHaveLength(0);
      await ui.perform(() => ui.client.setQueryData(exposureQuery.queryKey, ['collections']));
      await settle(publicationReads[0]!, publication());
      await choose();
      const oldPublish = handler(ui.button(m.library_publication_publish()), 'onClick');
      const oldReload = handler(ui.button(m.library_collection_reload()), 'onClick');
      await ui.perform(() => ui.button(m.library_publication_publish()).click());
      const original = structuredClone(publicationWrites[0]!.input);
      await ui.perform(() => {
        ui.client.setQueryData(sessionQuery.queryKey, session('bob', 'bob-csrf'));
        oldPublish();
        oldReload();
        expect(publicationWrites).toHaveLength(1);
      });
      await settle(publicationReads[1]!, publication('bob', { id: 'alpha' }, 'bob-csrf'));
      await choose();
      await ui.perform(() => ui.button(m.library_publication_publish()).click());
      expect(publicationWrites).toHaveLength(2); // B remains usable while A's command is outstanding.
      await settle(publicationWrites[0]!, {
        ok: true,
        collection: { id: 'alpha', revision: 8 },
        publication: { generation: 'old', state: 'complete', itemCount: original.subjectIds.length },
      });
      expect(ui.host.textContent).not.toContain(m.library_publication_complete_one({ count: '1' }));
      await settle(publicationWrites[1]!, { ok: false, reason: 'unknown' });
      const bobInput = structuredClone(publicationWrites[1]!.input);
      await ui.perform(() => ui.client.setQueryData(sessionQuery.queryKey, session('bob', 'rotated-csrf')));
      expect(ui.host.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
      await settle(publicationReads[2]!, publication('bob', { id: 'alpha' }, 'rotated-csrf', 21));
      expect(publicationWrites).toHaveLength(2);
      await ui.perform(() => ui.button(m.library_publication_retry()).click());
      expect(publicationWrites[2]!.input).toEqual(bobInput);
      expect(publicationWrites[2]!.csrf).toBe('rotated-csrf');
      await settle(publicationWrites[2]!, { ok: false, reason: 'unknown' });
      const currentRetry = handler(ui.button(m.library_publication_retry()), 'onClick');
      await ui.perform(() => {
        ui.client.setQueryData(exposureQuery.queryKey, []);
        ui.client.setQueryData(exposureQuery.queryKey, ['collections']);
        currentRetry();
        expect(publicationWrites).toHaveLength(3);
      });
      expect(publicationReads).toHaveLength(4);
      expect(ui.host.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
      // Leave the returning A read pending; a new address must have its own immediately usable read.
      await show({ id: 'beta', cursor: 'page-b' });
      expect(publicationReads).toHaveLength(5);
      await settle(publicationReads[4]!, publication('bob', { id: 'beta', cursor: 'page-b' }, 'rotated-csrf'));
      await choose();
      const addressPublish = handler(ui.button(m.library_publication_publish()), 'onClick');
      await show();
      expect(publicationReads).toHaveLength(6);
      await ui.perform(() => addressPublish());
      expect(publicationWrites).toHaveLength(3);
      await settle(publicationReads[3]!, publication('bob', { id: 'alpha' }, 'rotated-csrf', 90));
      expect(ui.host.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
      await settle(publicationReads[5]!, publication('bob', { id: 'alpha' }, 'rotated-csrf', 22));
      expect(ui.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
      await ui.perform(() => {
        ui.client.setQueryData(sessionQuery.queryKey, session());
        ui.client.setQueryData(sessionQuery.queryKey, session('bob', 'rotated-csrf'));
      });
      expect(publicationReads).toHaveLength(7);
      expect(ui.host.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
    } finally {
      await ui.close();
    }
  });
});
