import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import type { FilterDocument } from '@rezics/filter';
import { CollectionRuleEditor } from '../src/library/collection-rule-editor';
import type { RuleChoices, RulePage } from '../src/library/collection-rule-read';
import type { RuleWrite } from '../src/library/collection-rule-actions';
import type { CollectionWriteResult } from '../src/library/collection-records';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

type Props = ComponentProps<typeof CollectionRuleEditor>;
type Ready = Extract<RulePage, { state: 'ready' }>;
const key = '10000000-0000-4000-8000-000000000001';
const stateLabels = {
  en: 'Reading',
  de: 'Wird gelesen',
  es: 'Leyendo',
  fr: 'En lecture',
  ja: '読書中',
  ko: '읽는 중',
  'zh-Hans': '在读',
  'zh-Hant': '閱讀中',
};
const choices: RuleChoices = {
  release: {
    state: 'ready',
    digest: 'sha256:original-immutable-release',
    metadata: { types: {}, properties: {} },
    profiles: [
      {
        id: 'profile.books',
        entryStateSet: { id: 'states.books.v2', states: [{ id: 'state.reading', labels: stateLabels }] },
        progress: { allowed: [] },
        copies: {
          kinds: [
            {
              id: 'copy:paper',
              labels: { en: 'Paper copy' },
              statuses: [{ id: 'copy:owned', labels: { en: 'Owned' } }],
            },
          ],
        },
      },
    ],
  },
  labels: {
    state: 'ready',
    values: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Weekend reading' }],
    next: null,
  },
};
const state: FilterDocument = {
  owner: { state: { profileId: 'profile.books', stateSetId: 'states.books.v2', in: ['state.reading'] } },
};
function ready(filter: FilterDocument = state): Ready {
  return {
    state: 'ready',
    viewerId: 'alice',
    id: 'private-rule',
    title: 'Private reading',
    intent: key,
    address: { collectionId: 'private-rule' },
    choices,
    accepted: {
      state: 'ready',
      digest: 'sha256:original-immutable-release',
      metadata: choices.release.metadata,
      profiles: choices.release.profiles,
    },
    rule: {
      filter,
      sort: 'id',
      revision: 7,
      collectionRevision: 9,
      releaseDigest: 'sha256:original-immutable-release',
      sourceGeneration: '12345678901234567890',
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

// Authored source outcomes only; execution is deferred by this slice's launch contract.
async function mount(initial: Partial<Props> = {}) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/private-rule/rule' });
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
    collectionId: 'private-rule',
    csrfToken: 'csrf-alice',
    admitted: ['collection.create', 'collection_rule.get', 'collection_rule.update', 'library_label.list'],
    save: async () => ({ ok: false, reason: 'unavailable' }),
    reload: async () => ready(),
    ...initial,
  };
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
    select(label: string) {
      const field = [...host.querySelectorAll('label')].find((node) => node.textContent === label);
      expect(field?.htmlFor).toBeTruthy();
      return window.document.getElementById(field!.htmlFor) as unknown as HTMLSelectElement;
    },
    async choose(select: HTMLSelectElement, values: string[]) {
      await act(async () => {
        for (const option of select.options) option.selected = values.includes(option.value);
        select.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
      });
    },
    async click(name: string) {
      const button = [...host.querySelectorAll('button')].find(
        (node) => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name,
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    },
    async submit() {
      const form = host.querySelector('form');
      expect(form).not.toBeNull();
      await act(async () => {
        form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
      });
    },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('available choices use supplied localized names, with exact saved and field references in closed accessible details', async () => {
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const ui = await mount({
        page: ready({ and: [state, { owner: { label: { id: '00000000-0000-4000-8000-000000000001' } } }] }),
      });
      try {
        expect(ui.select(m.library_rule_state()).selectedOptions[0]!.textContent).toBe(stateLabels[locale]);
        expect(ui.select(m.library_rule_label()).selectedOptions[0]!.textContent).toBe('Weekend reading');
        // The supplied profile has only an ID. Do not invent a profile title.
        expect(ui.select(m.library_rule_profile()).selectedOptions[0]!.textContent).toBe('profile.books');
        for (const raw of [
          'states.books.v2',
          'state.reading',
          '00000000-0000-4000-8000-000000000001',
          ready().rule.releaseDigest,
          ready().rule.sourceGeneration,
        ]) {
          const code = [...ui.host.querySelectorAll('details code')].find(
            (node) =>
              node.textContent === raw &&
              node.closest('details')?.querySelector('summary')?.textContent?.startsWith(m.catalogue_technical_details()),
          );
          expect(code).toBeDefined();
          const details = code!.closest('details')!;
          expect(details.open).toBe(false);
          expect(details.querySelector('summary')!.textContent).toContain(m.catalogue_technical_details());
          expect(code!.textContent).toBe(raw);
        }
        const select = ui.select(m.library_rule_state());
        const details = [...ui.host.querySelectorAll('details')].find(
          (node) => node.id === select.getAttribute('aria-details'),
        );
        expect(details?.textContent).toContain('states.books.v2');
        await act(async () => {
          details!.open = true;
        });
        expect(details!.open).toBe(true);
        expect(ui.host.textContent).not.toContain(m.library_rule_state_set_unavailable());
        const savedDetails = [...ui.host.querySelectorAll('details')].find(
          (node) =>
            node.querySelector('summary')?.textContent ===
            `${m.catalogue_technical_details()} · ${m.library_rule_details()}`,
        )!;
        expect(ui.host.querySelector('button[type="submit"]')!.compareDocumentPosition(savedDetails) & 4).toBe(4);
      } finally {
        await ui.close();
      }
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('criteria review preserves nested negative meaning and exact references when current metadata is unavailable', async () => {
  const filter: FilterDocument = {
    and: [
      { type: { in: ['schema:Book', 'schema:Removed'] } },
      {
        not: {
          or: [
            { statement: { property: 'schema:status', in: ['value:retired'] } },
            { owner: { label: { id: '00000000-0000-4000-8000-000000000009' } } },
          ],
        },
      },
    ],
  };
  const page = ready(filter);
  page.accepted = {
    state: 'ready',
    digest: page.rule.releaseDigest,
    metadata: {
      types: { 'schema:Book': { labels: { en: 'Book type' }, bases: [], facets: [] } },
      properties: { 'schema:status': { labels: { en: 'Reading status' }, datatype: 'string' } },
    },
    profiles: [],
  };
  page.choices = {
    release: { state: 'unavailable', profiles: [] },
    labels: { state: 'unavailable', values: [], next: null },
  };
  const ui = await mount({ page });
  try {
    const review = [...ui.host.querySelectorAll('section')].find(
      (section) => section.getAttribute('aria-labelledby') === 'rule-review-heading',
    );
    expect(review).toBeDefined();
    expect(review!.textContent).toContain(m.saved_filter_review_group_and());
    expect(review!.textContent).toContain(m.saved_filter_review_group_not());
    expect(review!.textContent).toContain(m.saved_filter_review_group_or());
    expect(review!.textContent).toContain('Book type');
    expect(review!.textContent).toContain('Reading status');
    expect(review!.textContent).toContain('schema:Removed');
    expect(review!.textContent).toContain('value:retired');
    expect(review!.textContent).toContain('00000000-0000-4000-8000-000000000009');
    expect(review!.textContent).toContain(m.library_rule_review_metadata_unavailable());
    expect(review!.textContent).toContain(m.library_rule_review_no_evaluation());
    expect(review!.textContent).not.toContain('0 results');
  } finally {
    await ui.close();
  }
});

test('a mismatched state set retains distinct unknown states and exact identifiers without borrowing current labels', async () => {
  const filter: FilterDocument = {
    owner: {
      state: {
        profileId: 'profile.books',
        stateSetId: 'states.books.v1',
        in: ['state.reading', 'state.retired'],
      },
    },
  };
  const calls: RuleWrite[] = [];
  const ui = await mount({
    page: ready(filter),
    save: async (value) => {
      calls.push(value);
      return { ok: false, reason: 'invalid' };
    },
  });
  try {
    const select = ui.select(m.library_rule_state());
    expect([...select.selectedOptions].map((option) => option.value)).toEqual(['state.reading', 'state.retired']);
    expect(select.options[0]!.textContent).toContain(m.library_rule_unavailable_choice({ number: 1 }));
    expect(select.options[1]!.textContent).toContain(m.library_rule_unavailable_choice({ number: 2 }));
    expect(select.textContent).not.toContain(stateLabels[getLocale()]);
    expect(select.options).toHaveLength(2);
    expect(ui.host.querySelector(`[id="${select.getAttribute('aria-describedby')}"]`)!.textContent).toBe(
      m.library_rule_state_set_unavailable(),
    );
    await ui.submit();
    expect(calls[0]).toEqual({ id: 'private-rule', revision: 7, filter, sort: 'id', idempotencyKey: key });
    await ui.choose(select, ['state.retired']);
    expect([...ui.select(m.library_rule_state()).selectedOptions].map((option) => option.value)).toEqual([
      'state.retired',
    ]);
    await ui.click(`${m.library_subject_clear()} · ${m.library_rule_state()}`);
    expect(ui.select(m.library_rule_state()).selectedOptions).toHaveLength(0);
    expect(ui.host.textContent).toContain('states.books.v1');
    await ui.choose(ui.select(m.library_rule_profile()), ['']);
    await ui.choose(ui.select(m.library_rule_profile()), ['profile.books']);
    expect(ui.select(m.library_rule_state()).textContent).toContain(stateLabels[getLocale()]);
    expect(ui.host.textContent).not.toContain('states.books.v1');
  } finally {
    await ui.close();
  }
});

test('retired profile, label, session and holding operands survive save; unavailable labels remain changeable and clearable', async () => {
  const filter: FilterDocument = {
    and: [
      { not: { owner: { state: { profileId: 'profile.retired', stateSetId: 'states.old', in: ['state.old'] } } } },
      { owner: { label: { id: '00000000-0000-4000-8000-000000000009' } } },
      { owner: { session: { profileId: 'profile.retired', lifecycle: 'abandoned' } } },
      { owner: { holding: { profileId: 'profile.retired', kind: 'copy.old', status: 'copy.missing' } } },
    ],
  };
  const calls: RuleWrite[] = [];
  const ui = await mount({
    page: ready(filter),
    save: async (value) => {
      calls.push(value);
      return { ok: false, reason: 'invalid' };
    },
  });
  try {
    expect(ui.select(m.library_rule_label()).selectedOptions[0]!.textContent).toContain(m.library_rule_retained());
    expect(ui.select(m.library_rule_session()).selectedOptions[0]!.textContent).toBe(m.library_rule_abandoned());
    expect(ui.select(m.library_rule_holding_kind()).value).toBe('copy.old');
    expect(ui.select(m.library_rule_holding_status()).value).toBe('copy.missing');
    await ui.submit();
    expect(calls[0]!.filter).toEqual(filter);
    await ui.choose(ui.select(m.library_rule_label()), ['00000000-0000-4000-8000-000000000001']);
    expect(ui.select(m.library_rule_label()).selectedOptions[0]!.textContent).toBe('Weekend reading');
    await ui.choose(ui.select(m.library_rule_label()), ['']);
    expect(ui.select(m.library_rule_label()).value).toBe('');
  } finally {
    await ui.close();
  }
});

test('an uncertain save keeps its original binding, key and all operands through refresh and an explicit retry', async () => {
  const original = ready({ and: [state, { owner: { label: { id: '00000000-0000-4000-8000-000000000009' } } }] });
  const fresh = ready({ owner: { presence: true } });
  fresh.intent = '10000000-0000-4000-8000-000000000002';
  fresh.rule = { ...fresh.rule, revision: 11, releaseDigest: 'sha256:new-release', sourceGeneration: '99' };
  fresh.choices = { release: { state: 'ready', profiles: [] }, labels: { state: 'ready', values: [], next: null } };
  const writes: { value: RuleWrite; csrf: string }[] = [];
  const ui = await mount({
    page: original,
    reload: async () => fresh,
    save: async (value, csrf) => {
      writes.push({ value: structuredClone(value), csrf });
      return writes.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, id: 'private-rule' };
    },
  });
  try {
    await ui.submit();
    expect(ui.host.textContent).toContain(m.library_rule_uncertain());
    await ui.click(m.library_collection_reload());
    await ui.render({ csrfToken: 'csrf-rotated' });
    expect(writes).toHaveLength(1);
    expect(ui.host.querySelector('fieldset')!.disabled).toBe(true);
    expect(ui.host.textContent).toContain(original.rule.releaseDigest);
    expect(ui.host.textContent).not.toContain(fresh.rule.releaseDigest);
    expect(ui.select(m.library_rule_state()).value).toBe('state.reading');
    await ui.submit();
    expect(writes[1]!.value).toEqual(writes[0]!.value);
    expect(writes[1]!.value).toEqual({
      id: original.id,
      revision: 7,
      filter: original.rule.filter,
      sort: 'id',
      idempotencyKey: key,
    });
    expect(writes[1]!.csrf).toBe('csrf-rotated');
    expect(ui.host.textContent).toContain(m.library_rule_saved());
    expect(ui.host.querySelectorAll('a')).toHaveLength(1);
  } finally {
    await ui.close();
  }
});

test('viewer, address, CSRF and admission retirement remove exact private details and reject late save completion', async () => {
  for (const loss of [
    { viewerId: 'bob' },
    { collectionId: 'other-rule' },
    { csrfToken: '' },
    { admitted: ['collection_rule.get'] },
  ]) {
    const original = ready();
    const late = deferred<CollectionWriteResult>();
    const navigation: string[] = [];
    const ui = await mount({ page: original, save: async () => late.promise, navigate: (id) => navigation.push(id) });
    try {
      await ui.submit();
      await ui.render(loss);
      expect(ui.host.querySelector('form, details, code, select, a')).toBeNull();
      expect(ui.host.textContent).not.toContain(original.rule.releaseDigest);
      await act(async () => late.resolve({ ok: true, id: 'late-private-result' }));
      expect(navigation).toEqual([]);
      await ui.render({
        viewerId: 'alice',
        collectionId: 'private-rule',
        csrfToken: 'csrf-alice',
        admitted: ['collection_rule.get', 'collection_rule.update'],
      });
      expect(ui.host.querySelector('form, details, code')).toBeNull();
    } finally {
      await ui.close();
    }
  }
});
