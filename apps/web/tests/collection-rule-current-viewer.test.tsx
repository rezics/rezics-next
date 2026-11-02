import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import { CollectionRuleEditor } from '../src/library/collection-rule-editor';
import { unavailableRuleChoices, type RuleChoicePage, type RulePage } from '../src/library/collection-rule-read';
import type { CollectionWriteResult } from '../src/library/collection-records';
import type { RuleWrite } from '../src/library/collection-rule-actions';
import { m } from '../src/paraglide/messages.js';

type Props = ComponentProps<typeof CollectionRuleEditor>;
const admitted = ['collection.create', 'collection_rule.get', 'collection_rule.update', 'library_label.list'];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ready(viewerId = 'alice', id = 'alpha', revision = 7): Extract<RulePage, { state: 'ready' }> {
  const choices = unavailableRuleChoices();
  choices.labels = {
    state: 'ready',
    next: 'bounded-next',
    values: [
      { id: `${viewerId}-label`, name: `${viewerId} private label` },
      { id: 'changed', name: 'Changed label' },
    ],
  };
  return {
    state: 'ready',
    viewerId,
    id,
    title: `${viewerId} private title`,
    intent: crypto.randomUUID(),
    choices,
    rule: {
      filter: { owner: { label: { id: `${viewerId}-label` } } },
      sort: 'id',
      revision,
      collectionRevision: 9,
      releaseDigest: `${viewerId}-${id}-private-release`,
      sourceGeneration: '12',
    },
  };
}

// These mounted source regressions are intentionally deferred by the launch contract.
// Use the already installed DOM fixture, real editor and real shared ConditionEditor.
async function mount(initial: Partial<Props> = {}) {
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
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let props: Props = {
    page: ready(),
    viewerId: 'alice',
    collectionId: 'alpha',
    csrfToken: 'csrf-alice',
    admitted,
    save: async () => ({ ok: false, reason: 'unavailable' }),
    reload: async () => ready(),
    ...initial,
  };
  let unmounted = false;
  async function render(patch: Partial<Props> = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        <StrictMode>
          <CollectionRuleEditor {...props} />
        </StrictMode>,
      ),
    );
  }
  await render();
  return {
    host,
    render,
    window,
    async submit(twice = false) {
      const form = host.querySelector('form');
      expect(form).not.toBeNull();
      await act(async () => {
        form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
        if (twice)
          form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
      });
    },
    button(name: string) {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === name,
      );
      expect(button).toBeDefined();
      return button!;
    },
    async click(name: string) {
      await act(async () => this.button(name).click());
    },
    async editPrefix(value: string) {
      const input = host.querySelector<HTMLInputElement>('input[id$="-label-search"]')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      await act(async () => input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event));
      return input;
    },
    async changeLabel() {
      const select = [...host.querySelectorAll('select')].find((node) => node.value === 'alice-label')!;
      expect(select).toBeDefined();
      await act(async () => {
        select.value = 'changed';
        select.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
      });
    },
    async unmount() {
      if (!unmounted) await act(async () => root.unmount());
      unmounted = true;
    },
    async close() {
      if (!unmounted) await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

describe('Private rule editor data and asynchronous work stay with the originating current viewer and Collection', () => {
  test('a foreign or retired page stays private; old save success and finally cannot navigate or unlock the replacement viewer', async () => {
    const old = deferred<CollectionWriteResult>();
    const current = deferred<CollectionWriteResult>();
    const calls: RuleWrite[] = [];
    const navigation: string[] = [];
    const alice = ready();
    const ui = await mount({
      page: alice,
      save: async (value) => {
        calls.push(value);
        return calls.length === 1 ? old.promise : current.promise;
      },
      navigate: (id) => navigation.push(id),
    });
    try {
      await ui.submit(true);
      expect(calls).toHaveLength(1); // Synchronous lock, before the pending render.
      await ui.render({ viewerId: 'bob', csrfToken: 'csrf-bob' });
      expect(ui.host.querySelector('form, select, a')).toBeNull();
      expect(ui.host.textContent).not.toContain('alice');
      await ui.render({ page: ready('bob') });
      await ui.submit();
      expect(calls).toHaveLength(2);
      await act(async () => old.resolve({ ok: true, id: 'old-saved' }));
      expect(navigation).toEqual([]);
      expect(ui.host.textContent).not.toContain('old-saved');
      expect(ui.button(m.library_collection_save_pending()).disabled).toBe(true);
      await ui.submit();
      expect(calls).toHaveLength(2);
      await act(async () => current.resolve({ ok: true, id: 'bob-saved' }));
      expect(navigation).toEqual(['bob-saved']);
      expect(ui.host.querySelector('a[href$="/bob-saved"]')).not.toBeNull();
      await ui.render({ viewerId: 'alice', csrfToken: 'csrf-alice', page: alice });
      expect(ui.host.querySelector('form, select, a')).toBeNull();
    } finally {
      await ui.close();
    }
  });

  test('Collection and new-mode replacement retire label IO, choices and locks while fresh work remains usable', async () => {
    const old = deferred<RuleChoicePage | null>();
    const current = deferred<RuleChoicePage | null>();
    let calls = 0;
    const ui = await mount({ labels: async () => (++calls === 1 ? old.promise : current.promise) });
    try {
      await ui.click(m.search_apply());
      await ui.render({ page: ready('alice', 'beta'), collectionId: 'beta' });
      expect(ui.host.textContent).not.toContain('alpha-private-release');
      await ui.click(m.search_apply());
      const leaked = ready().choices;
      leaked.labels.values = [{ id: 'leak', name: 'Old private label completion' }];
      await act(async () => old.resolve({ viewerId: 'alice', choices: leaked }));
      expect(ui.host.textContent).not.toContain('Old private label completion');
      expect(ui.button(m.library_collection_save_pending()).disabled).toBe(true);
      // Even within a current lifetime, a choice response must carry the same actual viewer.
      await act(async () => current.resolve({ viewerId: 'bob', choices: leaked }));
      expect(ui.host.textContent).not.toContain('Old private label completion');
      expect(ui.button(m.library_collection_save()).disabled).toBe(false);
      await ui.render({
        collectionId: null,
        page: {
          state: 'new',
          viewerId: 'alice',
          intent: crypto.randomUUID(),
          choices: unavailableRuleChoices(),
        },
      });
      expect(ui.host.textContent).not.toContain('beta-private-release');
      expect(ui.host.querySelector('a')).toBeNull();
      expect(ui.host.querySelector('input[required]')).not.toBeNull();
    } finally {
      await ui.close();
    }
  });

  test('late retry and explicit reload cannot restore a replaced page or override newer loader data', async () => {
    const retry = deferred<RulePage>();
    const refresh = deferred<RulePage>();
    let reads = 0;
    const ui = await mount({
      page: { state: 'unavailable' },
      reload: async () => (++reads === 1 ? retry.promise : refresh.promise),
    });
    try {
      await ui.click(m.library_follow_retry());
      await ui.render({ page: ready('alice', 'beta'), collectionId: 'beta' });
      await act(async () => retry.resolve(ready('alice', 'alpha')));
      expect(ui.host.textContent).toContain('alice-beta-private-release');
      expect(ui.host.textContent).not.toContain('alpha-private-release');
      await ui.click(m.library_collection_reload());
      await ui.render({ page: ready('alice', 'gamma'), collectionId: 'gamma' });
      await act(async () => refresh.reject(new Error('retired reload failed')));
      expect(ui.host.textContent).toContain('alice-gamma-private-release');
      expect(ui.host.textContent).not.toContain(m.library_rule_unavailable());
      expect(ui.button(m.library_collection_save()).disabled).toBe(false);
      // A completed retry is also scoped to its source, not a permanent override of loader data.
      await ui.render({ page: { state: 'unavailable' }, reload: async () => ready('alice', 'gamma') });
      await ui.click(m.library_follow_retry());
      expect(ui.host.querySelector('form')).not.toBeNull();
      await ui.render({ page: { state: 'denied' } });
      expect(ui.host.querySelector('form, a')).toBeNull();
      expect(ui.host.textContent).toContain(m.library_rule_denied());
    } finally {
      await ui.close();
    }
  });

  test('authority loss retires work and the page; old failures and unmounted success cannot paint, unlock or navigate', async () => {
    for (const loss of [{ viewerId: null }, { admitted: ['collection_rule.get'] }]) {
      const old = deferred<CollectionWriteResult>();
      const replacement = deferred<CollectionWriteResult>();
      const navigation: string[] = [];
      let writes = 0;
      const ui = await mount({
        save: async () => (++writes === 1 ? old.promise : replacement.promise),
        navigate: (id) => navigation.push(id),
        reload: async () => ready(),
      });
      try {
        await ui.submit();
        await ui.render(loss);
        expect(ui.host.querySelector('form, input, select, a')).toBeNull();
        expect(ui.host.textContent).not.toContain('alice');
        expect(ui.button(m.library_follow_retry()).disabled).toBe(true);
        await ui.render({ csrfToken: 'rotated-csrf', viewerId: 'alice', admitted });
        expect(ui.host.querySelector('form')).toBeNull(); // Cached provenance was retired.
        await ui.click(m.library_follow_retry());
        await ui.submit();
        await act(async () => old.reject(new Error('old save failed')));
        expect(ui.host.textContent).not.toContain(m.library_rule_unavailable());
        expect(ui.button(m.library_collection_save_pending()).disabled).toBe(true);
        await ui.submit();
        expect(writes).toBe(2);
        await ui.unmount();
        await act(async () => replacement.resolve({ ok: true, id: 'unmounted-saved' }));
        expect(navigation).toEqual([]);
        expect(ui.host.innerHTML).toBe('');
      } finally {
        await ui.close();
      }
    }
  });

  test('same-viewer drafts survive loader reload and CSRF rotation, uncertain retry is exact and conflict refresh selects the revision explicitly', async () => {
    const first = deferred<CollectionWriteResult>();
    const calls: { value: RuleWrite; csrf: string }[] = [];
    let refreshRevision = 7;
    const ui = await mount({
      save: async (value, csrf) => {
        calls.push({ value, csrf });
        if (calls.length === 1) return first.promise;
        if (calls.length === 2) return { ok: false, reason: 'conflict' };
        return { ok: true, id: 'alpha' };
      },
      reload: async () => ready('alice', 'alpha', refreshRevision),
    });
    try {
      await ui.changeLabel();
      await ui.submit();
      await ui.render({ csrfToken: 'rotated-csrf' });
      expect(ui.button(m.library_collection_save_pending()).disabled).toBe(true);
      await act(async () => first.resolve({ ok: false, reason: 'unavailable' }));
      await ui.render({ page: ready() }); // Ordinary loader replacement keeps the deliberate draft.
      await ui.click(m.library_collection_reload()); // An unchanged uncertain command keeps its key, even after read.
      expect(calls).toHaveLength(1); // No automatic resubmission.
      await ui.submit();
      expect(calls[1]!.value).toEqual(calls[0]!.value);
      expect(calls[1]!.csrf).toBe('csrf-alice');
      expect(calls[0]!.value.filter).toEqual({ owner: { label: { id: 'changed' } } });
      await ui.submit();
      expect(calls).toHaveLength(2); // A conflict requires the user's refresh/revision choice.
      refreshRevision = 8;
      await ui.click(m.library_collection_reload());
      await ui.submit();
      expect(calls[2]!.value.revision).toBe(8);
      expect(calls[2]!.value.filter).toEqual(calls[0]!.value.filter);
      expect(calls[2]!.value.idempotencyKey).not.toBe(calls[0]!.value.idempotencyKey);
      expect(ui.host.querySelector('a[href$="/alpha"]')).not.toBeNull();
    } finally {
      await ui.close();
    }
  });

  test('initial unknown hydration refuses starts, then a proven signed-in new page can create and retry its exact intent', async () => {
    const calls: RuleWrite[] = [];
    const navigation: string[] = [];
    const page: RulePage = {
      state: 'new',
      viewerId: 'alice',
      intent: crypto.randomUUID(),
      choices: unavailableRuleChoices(),
    };
    const ui = await mount({
      page,
      collectionId: null,
      viewerId: null,
      csrfToken: '',
      save: async (value) => {
        calls.push(value);
        return calls.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, id: 'created' };
      },
      navigate: (id) => navigation.push(id),
    });
    try {
      expect(ui.host.querySelector('form')).toBeNull();
      await ui.click(m.library_follow_retry());
      expect(calls).toEqual([]);
      await ui.render({ viewerId: 'alice', csrfToken: 'csrf-alice', admitted: ['collections'] });
      expect(ui.host.querySelector('form')).toBeNull(); // Group admission cannot invent the exact operation.
      expect(ui.button(m.library_follow_retry()).disabled).toBe(true);
      await ui.render({ admitted });
      const title = ui.host.querySelector<HTMLInputElement>('input[required]')!;
      expect(title).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.window.HTMLInputElement.prototype, 'value')!.set!.call(
          title,
          'My private rule',
        );
        title.dispatchEvent(new ui.window.Event('input', { bubbles: true }) as unknown as Event);
      });
      await ui.submit();
      expect(calls[0]!.title).toBe('My private rule');
      expect(calls[0]!.id).toBeUndefined();
      await ui.render({ csrfToken: 'new-nonempty-csrf' });
      await ui.submit();
      expect(calls[1]).toEqual(calls[0]);
      expect(navigation).toEqual(['created']);
      expect(ui.host.querySelector('a[href$="/created"]')).not.toBeNull();
    } finally {
      await ui.close();
    }
  });
});


test('rule label lookup normalizes a copy, corrects invalid prefixes, and retains the unsaved rule without CSRF', async () => {
  const reads: string[] = [];
  const writes: RuleWrite[] = [];
  const ui = await mount({
    csrfToken: '',
    labels: async (q, cursor) => {
      reads.push(q);
      return { viewerId: 'alice', address: { q, cursor: cursor ?? null }, choices: ready().choices };
    },
    save: async (value) => { writes.push(value); return { ok: false, reason: 'invalid' }; },
  });
  try {
    await ui.changeLabel();
    for (const raw of ['  e\u0301\u00a0 x  ', '😀'.repeat(100), '   ']) {
      const input = await ui.editPrefix(raw);
      await ui.click(m.search_apply());
      expect(input.value).toBe(raw);
    }
    expect(reads).toEqual(['é x', '😀'.repeat(100), '']);
    for (const raw of ['😀'.repeat(101), 'a\u0001b', 'a\ud800b', ' '.repeat(1001)]) {
      const input = await ui.editPrefix(raw);
      expect(input.value).toBe(raw);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const error = ui.host.querySelector(`[id="${input.getAttribute('aria-describedby')}"]`)!;
      expect(error.getAttribute('role')).toBe('alert');
      await ui.click(m.search_apply());
      expect(reads).toHaveLength(3);
      expect(ui.host.querySelector('select')!.value).toBe('changed');
    }
    await ui.render({ csrfToken: 'csrf-alice' });
    await ui.submit();
    expect(writes[0]!.filter).toEqual({ owner: { label: { id: 'changed' } } });
  } finally { await ui.close(); }
});

test('raw prefix edits retire choices and cursors, and equal normalized edits cannot revive an old request', async () => {
  const pending: { q: string; cursor?: string; resolve: (value: RuleChoicePage) => void }[] = [];
  const ui = await mount({ labels: (q, cursor) => new Promise((resolve) => pending.push({ q, cursor, resolve })) });
  const reply = async (index: number, q: string, viewerId = 'alice') => {
    const choices = ready().choices;
    choices.labels.values = [{ id: 'result', name: 'Fresh result' }];
    await act(async () => pending[index]!.resolve({ viewerId, address: { q, cursor: null }, choices }));
  };
  try {
    const oldMore = ui.button(m.library_label_more());
    await ui.editPrefix('é');
    expect(ui.host.textContent).not.toContain('Changed label');
    expect(ui.host.contains(oldMore)).toBe(false);
    await act(async () => oldMore.click());
    expect(pending).toHaveLength(0);
    await ui.click(m.search_apply());
    await ui.editPrefix(' e\u0301 ');
    await ui.editPrefix('é');
    await reply(0, 'é');
    expect(ui.host.textContent).not.toContain('Fresh result');
    await ui.click(m.search_apply());
    await reply(1, 'wrong-query');
    expect(ui.host.textContent).not.toContain('Fresh result');
    await ui.click(m.search_apply());
    await reply(2, 'é', 'bob');
    expect(ui.host.textContent).not.toContain('Fresh result');
    await ui.click(m.search_apply());
    await reply(3, 'é');
    expect(ui.host.textContent).toContain('Fresh result');
    expect(pending.map(({ q, cursor }) => [q, cursor])).toEqual(Array(4).fill(['é', undefined]));
  } finally { await ui.close(); }
});
