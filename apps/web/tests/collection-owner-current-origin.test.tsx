import { afterAll, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
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

// UNRUN: composed regressions for the actual scoped observation contract and owning pages.
// Controlled BFF responses do not establish native, browser or whole-Goal completion.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const exposures: (ReturnType<typeof deferred<{ subject: string | null; admitted: string[] }>> & {
  expected: string;
})[] = [];
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
          if (validate?.name === 'expectedSubject') {
            const call = {
              ...deferred<{ subject: string | null; admitted: string[] }>(),
              expected: validate(input?.data) as string,
            };
            exposures.push(call);
            return call.promise;
          }
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
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { CollectionRuleCurrent } = await import('../src/library/collection-rule-current');
const { CollectionPublicationPage } = await import('../src/library/collection-publication-page');
const { unavailableRuleChoices } = await import('../src/library/collection-rule-read');
const { collectionPublicationQuery } = await import('../src/library/collection-publication');
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
  exposures.length =
    ruleReads.length =
    choices.length =
    ruleWrites.length =
    publicationReads.length =
    publicationWrites.length =
      0;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  client.setQueryData(['exposure', 'viewer'], ['collections', 'library_label.list']);
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
  function exposureKey() {
    const enrolled = viewerExposureLifetime(client).getSnapshot();
    if (enrolled.state !== 'signed-in') throw new Error('Expected an enrolled actual observation');
    return viewerExposureQuery(enrolled.observation).queryKey;
  }
  return {
    host,
    client,
    exposureKey,
    expose: (subject = 'alice', admitted = ['collections', 'library_label.list']) =>
      perform(() => client.setQueryData(exposureKey(), { subject, admitted })),
    authorize: (subject = 'alice', admitted = ['collections', 'library_label.list']) =>
      perform(() => {
        const pending = exposures.filter((call) => call.expected === subject).at(-1);
        expect(pending).toBeDefined();
        pending!.resolve({ subject, admitted });
      }),
    perform,
    render: (node: ReactNode) =>
      perform(() =>
        root.render(
          <StrictMode>
            <QueryClientProvider client={client}>
              <RouterContextProvider router={router}>{node}</RouterContextProvider>
            </QueryClientProvider>
          </StrictMode>,
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

const event = { preventDefault() {} };
const complete = (input: PublicationInput): PublicationResult => ({
  ok: true,
  collection: { id: input.collectionId, revision: input.revision + 1 },
  publication: { generation: 'complete-native-result', state: 'complete', itemCount: input.subjectIds.length },
});
const checkboxes = (host: Element) => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
async function select(h: Awaited<ReturnType<typeof mounted>>, indices = [0]) {
  for (const index of indices) await h.perform(() => checkboxes(h.host)[index]!.click());
  await h.perform(() => checkboxes(h.host).at(-1)!.click());
}

describe('Complete saved rule and selected Publication owner authority preserves current authority and exact uncertain operations across observed replacement and ABA', () => {
  test('only successful actual scoped authority enables work; retired A callbacks and outcomes cannot affect usable B or returning A', async () => {
    const h = await mounted();
    const navigation: string[] = [];
    const a = rule();
    try {
      await h.render(<CollectionRuleCurrent page={a} collectionId="alpha" navigate={(id) => navigation.push(id)} />);
      expect(h.host.querySelector('form')).toBeNull(); // The legacy global cache grants nothing.
      await settle(exposures.at(-1)!, { subject: 'foreign-viewer', admitted: ['collections', 'library_label.list'] });
      expect(h.host.querySelector('form')).toBeNull();
      await h.expose();
      const oldSubmit = handler(h.host.querySelector('form')!, 'onSubmit');
      const oldReload = handler(h.button(m.library_collection_reload()), 'onClick');
      const oldLabels = handler(h.button(m.search_apply()), 'onClick');
      await h.submit();
      expect(ruleWrites).toHaveLength(1);
      await h.perform(() => {
        h.client.setQueryData(sessionQuery.queryKey, session('bob', 'csrf-bob'));
        oldSubmit(event);
        oldReload();
        oldLabels();
        expect(ruleWrites).toHaveLength(1);
        expect(ruleReads).toHaveLength(0);
        expect(choices).toHaveLength(0);
      });
      await h.render(<CollectionRuleCurrent page={rule('bob')} collectionId="alpha" />);
      await h.authorize('bob');
      await h.submit();
      expect(ruleWrites).toHaveLength(2); // B works while A's native command remains unresolved.
      expect(ruleWrites[1]!.csrf).toBe('csrf-bob');
      await settle(ruleWrites[0]!, { ok: true, id: 'old-A-result' });
      expect(navigation).toEqual([]);
      expect(h.host.textContent).not.toContain('old-A-result');
      expect(h.button(m.library_collection_save_pending()).disabled).toBe(true);
      const bSubmit = handler(h.host.querySelector('form')!, 'onSubmit');
      await h.perform(() => {
        h.client.setQueryData(sessionQuery.queryKey, session('alice'));
        h.client.setQueryData(sessionQuery.queryKey, session('bob', 'csrf-bob'));
        bSubmit(event); // ABA is observed before React commits the final B again.
        expect(ruleWrites).toHaveLength(2);
      });
      await h.authorize('bob');
      expect(h.host.querySelector('form')).toBeNull(); // The retired loader intent cannot seed B again.
      await h.perform(() => h.button(m.library_follow_retry()).click());
      await settle(ruleReads[0]!, rule('bob', 'alpha', 11));
      await h.submit();
      expect(ruleWrites).toHaveLength(3);
      await h.perform(() => ruleWrites[1]!.reject(new Error('Retired B write failed')));
      expect(h.button(m.library_collection_save_pending()).disabled).toBe(true);
      expect(h.host.textContent).not.toContain(m.library_rule_unavailable());
      await settle(ruleWrites[2]!, { ok: false, reason: 'unavailable' });
      expect(h.button(m.library_collection_save()).disabled).toBe(false);
    } finally {
      await h.close();
    }
  });

  test('a healthy owner without CSRF can inspect rules, refresh and read choices; token arrival submits nothing', async () => {
    const h = await mounted();
    try {
      await h.perform(() => h.client.setQueryData(sessionQuery.queryKey, { ...session(), csrfToken: null }));
      await h.render(<CollectionRuleCurrent page={rule()} collectionId="alpha" />);
      await h.authorize();
      expect(h.host.textContent).toContain('alice-private-release');
      expect(h.button(m.library_collection_save()).disabled).toBe(true);
      await h.submit();
      await h.perform(() => h.button(m.search_apply()).click());
      expect(choices).toHaveLength(1);
      await settle(choices[0]!, {
        viewerId: 'alice',
        address: { q: '', cursor: null },
        choices: unavailableRuleChoices(),
      });
      await h.perform(() => h.button(m.library_collection_reload()).click());
      await settle(ruleReads[0]!, rule('alice', 'alpha', 12));
      expect(h.host.textContent).toContain('12');
      expect(ruleWrites).toHaveLength(0);
      await h.perform(() => h.client.setQueryData(sessionQuery.queryKey, session()));
      await h.authorize();
      expect(ruleWrites).toHaveLength(0);
      await h.submit();
      expect(ruleWrites[0]!.input.revision).toBe(12);
    } finally {
      await h.close();
    }
  });

  test('new and edited uncertain rule intents survive healthy rotation, equivalent refresh, authority errors and independent admission churn exactly', async () => {
    for (const collectionId of [null, 'alpha']) {
      const h = await mounted();
      try {
        await h.render(<CollectionRuleCurrent page={rule('alice', collectionId)} collectionId={collectionId} />);
        await h.authorize();
        if (collectionId === null) {
          const input = h.host.querySelector<HTMLInputElement>('input[required]')!;
          await h.perform(() => handler(input, 'onChange')({ currentTarget: { value: 'Exact private title' } }));
        }
        await h.submit();
        const original = structuredClone(ruleWrites[0]!.input);
        await h.perform(() => h.client.setQueryData(sessionQuery.queryKey, session('alice', 'rotated-csrf')));
        expect(h.host.querySelector('form')).toBeNull();
        // A dispatched native outcome remains real while fresh scoped admission is unresolved.
        await settle(ruleWrites[0]!, { ok: false, reason: 'unavailable' });
        await h.authorize();
        await h.expose('alice', ['collections']);
        expect(h.host.textContent).not.toContain(m.library_rule_label_search());
        const retry = handler(h.host.querySelector('form')!, 'onSubmit');
        await h.perform(() => {
          const query = h.client.getQueryCache().find({ queryKey: h.exposureKey(), exact: true })!;
          query.setState({ status: 'error', error: new Error('Scoped exposure failed') });
          retry(event);
          expect(ruleWrites).toHaveLength(1);
        });
        expect(h.host.querySelector('form')).toBeNull();
        await h.expose('alice', ['library_label.list']); // Label admission alone cannot admit a Collection command.
        expect(h.host.querySelector('form')).toBeNull();
        await h.expose();
        // An equivalent successful session refresh enrolls a new observation even with the same credential.
        await h.perform(() =>
          h.client.setQueryData(sessionQuery.queryKey, session('alice', 'rotated-csrf'), {
            updatedAt: (h.client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0) + 1,
          }),
        );
        await h.authorize();
        expect(ruleReads).toHaveLength(0);
        expect(choices).toHaveLength(0);
        await h.perform(() => h.button(m.library_collection_reload()).click());
        await settle(ruleReads[0]!, rule('alice', collectionId, 99));
        await h.submit();
        expect(ruleWrites).toHaveLength(2);
        expect(ruleWrites[1]!.input).toEqual(original);
        expect(ruleWrites[1]!.csrf).toBe('csrf-one');
        await settle(ruleWrites[1]!, { ok: true, id: 'alpha' });
        expect(h.host.querySelector('a[href$="/alpha"]')).not.toBeNull();
      } finally {
        await h.close();
      }
    }
  });

  test('latest label query and cursor, actual viewer/address and independent label admission fence retained choices and reloads', async () => {
    const h = await mounted();
    try {
      await h.render(<CollectionRuleCurrent page={rule()} collectionId="alpha" />);
      await h.authorize();
      const input = () => h.host.querySelector<HTMLInputElement>('input[maxlength="1000"]')!;
      await h.perform(() => handler(input(), 'onChange')({ currentTarget: { value: 'old' } }));
      await h.perform(() => h.button(m.search_apply()).click());
      expect(choices[0]!.q).toBe('old');
      await h.perform(() => handler(input(), 'onChange')({ currentTarget: { value: 'latest' } }));
      const privateChoices = unavailableRuleChoices();
      privateChoices.labels = {
        state: 'ready',
        values: [{ id: 'secret', name: 'Rejected old label' }],
        next: 'old-next',
      };
      await settle(choices[0]!, { viewerId: 'alice', address: { q: 'old', cursor: null }, choices: privateChoices });
      expect(h.host.textContent).not.toContain('Rejected old label');
      await h.perform(() => h.button(m.search_apply()).click());
      await settle(choices[1]!, { viewerId: 'bob', address: { q: 'latest', cursor: null }, choices: privateChoices });
      expect(h.host.textContent).not.toContain('Rejected old label');
      await h.perform(() => h.button(m.search_apply()).click());
      await settle(choices[2]!, {
        viewerId: 'alice',
        address: { q: 'latest', cursor: 'foreign-cursor' },
        choices: privateChoices,
      });
      expect(h.host.textContent).not.toContain('Rejected old label');
      await h.perform(() => h.button(m.search_apply()).click());
      await settle(choices[3]!, { viewerId: 'alice', address: { q: 'latest', cursor: null }, choices: privateChoices });
      expect(h.host.textContent).toContain('Rejected old label');
      const more = handler(h.button(m.library_label_more()), 'onClick');
      await h.perform(() => {
        handler(input(), 'onChange')({ currentTarget: { value: 'newest' } });
        more();
        expect(choices).toHaveLength(4);
      });
      const apply = handler(h.button(m.search_apply()), 'onClick');
      await h.perform(() => {
        h.client.setQueryData(h.exposureKey(), { subject: 'alice', admitted: ['collections'] });
        apply();
        expect(choices).toHaveLength(4);
      });
      expect(h.host.querySelector('form')).not.toBeNull();
      expect(h.host.textContent).not.toContain('Rejected old label');
      await h.perform(() => h.button(m.library_collection_reload()).click());
      await settle(ruleReads[0]!, rule('alice', 'foreign-collection'));
      expect(h.host.querySelector('form, select, a')).toBeNull();
      await h.perform(() => h.button(m.library_collection_reload()).click());
      await settle(ruleReads[1]!, rule('bob'));
      expect(h.host.querySelector('form, select, a')).toBeNull();
      await h.perform(() => h.button(m.library_collection_reload()).click());
      await settle(ruleReads[2]!, rule('alice', 'alpha', 15));
      await h.submit();
      expect(ruleWrites[0]!.input.revision).toBe(15);
    } finally {
      await h.close();
    }
  });

  test('selected Publication consumes the actual originating cache guard and retains exact order/revision/key through authority churn and rotated source reads', async () => {
    const h = await mounted();
    const address = { id: 'alpha', cursor: 'signed+/cursor==' };
    try {
      await h.render(<CollectionPublicationPage address={address} />);
      expect(publicationReads).toHaveLength(0);
      await h.authorize();
      expect(publicationReads).toHaveLength(1);
      await settle(publicationReads[0]!, publication('bob', address));
      expect(checkboxes(h.host)).toHaveLength(0);
      await h.perform(() => h.button(m.library_collection_reload()).click());
      await settle(publicationReads[1]!, publication('alice', { ...address, cursor: 'wrong-page' }));
      expect(checkboxes(h.host)).toHaveLength(0);
      await h.perform(() => h.button(m.library_collection_reload()).click());
      await settle(publicationReads[2]!, publication('alice', address));
      await select(h, [1, 0]);
      const publish = handler(h.button(m.library_publication_publish()), 'onClick');
      const choose = handler(checkboxes(h.host)[0]!, 'onChange');
      const key = h.client.getQueryCache().findAll({
        queryKey: collectionPublicationQuery({ subject: 'alice', csrfToken: 'csrf-one' }, address).queryKey,
      })[0]!.queryKey;
      await h.perform(() => {
        h.client.setQueryData(key, publication('alice', address, 'csrf-one', 8));
        choose();
        publish();
        expect(publicationWrites).toHaveLength(0); // The retained source is no longer the actual cache value.
      });
      await select(h, [1, 0]);
      await h.perform(() => h.button(m.library_publication_publish()).click());
      expect(publicationWrites).toHaveLength(1);
      const original = structuredClone(publicationWrites[0]!.input);
      const source = publication('alice', address);
      if (source.source.state !== 'ready') throw new Error('Expected ready fixture');
      expect(original.subjectIds).toEqual([
        source.source.page.members[1]!.subject!.id,
        source.source.page.members[0]!.subject!.id,
      ]);
      await h.perform(() => h.client.setQueryData(sessionQuery.queryKey, session('alice', 'rotated-csrf')));
      await settle(publicationWrites[0]!, { ok: false, reason: 'unknown' });
      await h.authorize();
      expect(publicationReads).toHaveLength(4);
      await settle(publicationReads[3]!, publication('alice', address, 'rotated-csrf', 99));
      await h.expose('alice', []);
      expect(checkboxes(h.host)).toHaveLength(0);
      expect(h.host.querySelector('[data-publication-review]')).toBeNull();
      await h.expose();
      expect(h.host.querySelector('[data-publication-review]')).not.toBeNull();
      expect(publicationReads).toHaveLength(4); // No replay/read is added by admission churn.
      await h.perform(() => h.button(m.library_publication_retry()).click());
      expect(publicationWrites).toHaveLength(2);
      expect(publicationWrites[1]!.input).toEqual(original);
      expect(publicationWrites[1]!.csrf).toBe('csrf-one');
      await settle(publicationWrites[1]!, complete(original));
      expect(h.host.textContent).toContain(m.library_publication_complete({ count: '2' }));
    } finally {
      await h.close();
    }
  });

  test('B publication remains usable during unresolved A; pre-commit session error, sign-out and ABA permanently retire A callbacks and late results', async () => {
    const h = await mounted();
    try {
      await h.render(<CollectionPublicationPage address={{ id: 'alpha' }} />);
      await h.authorize();
      await settle(publicationReads[0]!, publication());
      await select(h);
      const oldPublish = handler(h.button(m.library_publication_publish()), 'onClick');
      const oldReload = handler(h.button(m.library_collection_reload()), 'onClick');
      await h.perform(() => oldPublish());
      await h.perform(() => {
        const query = h.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true })!;
        query.setState({ status: 'error', error: new Error('Session failed with old data retained') });
        oldPublish();
        oldReload();
        h.client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        h.client.setQueryData(sessionQuery.queryKey, session('bob', 'csrf-bob'));
        h.client.setQueryData(sessionQuery.queryKey, session());
        oldReload();
        h.client.setQueryData(sessionQuery.queryKey, session('bob', 'csrf-bob'));
        oldPublish();
        expect(publicationWrites).toHaveLength(1);
        expect(publicationReads).toHaveLength(1);
      });
      await h.authorize('bob');
      await settle(publicationReads[1]!, publication('bob', { id: 'alpha' }, 'csrf-bob', 12));
      await select(h, []);
      await h.perform(() => h.button(m.library_publication_publish()).click());
      expect(publicationWrites).toHaveLength(2);
      await settle(publicationWrites[0]!, complete(publicationWrites[0]!.input));
      expect(h.host.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(h.host.textContent).not.toContain(m.library_publication_complete_one({ count: '1' }));
      await settle(publicationWrites[1]!, complete(publicationWrites[1]!.input));
      expect(h.host.textContent).toContain(m.library_publication_complete({ count: '0' }));
      await h.render(null);
      await h.perform(() => {
        oldPublish();
        oldReload();
      });
      expect(publicationWrites).toHaveLength(2);
      expect(publicationReads).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
});
