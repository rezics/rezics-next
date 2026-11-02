import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { StatementFieldsRead } from '../src/features/catalogue/statement-editor-view';
import {
  statementInput,
  validateStatement,
  type ProposalResult,
  type StatementInput,
  type SnakInput,
} from '../src/features/catalogue/statement-editor';
import { statementFixture } from '../src/kernel/fake/catalogue-statements';
import recorded from '../src/kernel/recorded/definitions-release.json';

// Authored UNRUN: one connected actual-component regression. Native HTTP is the existing
// typed fixture seam; mounted DOM assertions are neither browser geometry nor native proof.
test('statement family owns labels, independent supplied parts, feedback, exact replay, review and retired work', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/book/title', width: 390, height: 844 });
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
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { StatementEditor, StatementFields, PartValue, EditorFailure } =
    await import('../src/features/catalogue/statement-editor-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let show!: (node: ReactNode) => void;
  function Surface() {
    const [node, setNode] = useState<ReactNode>(null);
    show = (next) => setNode(() => next);
    return node;
  }
  const route = createRootRoute({ component: Surface });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
  );
  const render = async (node: ReactNode) => {
    await act(async () => show(node));
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const until = async (predicate: () => boolean) => {
    for (let count = 0; count < 100 && !predicate(); count++) await settle();
    expect(predicate()).toBe(true);
  };
  const buttons = (scope: ParentNode, name: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent?.trim() === name);
  const button = (scope: ParentNode, name: string) => {
    const matches = buttons(scope, name);
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  const click = async (scope: ParentNode, name: string) => {
    await act(async () => button(scope, name).click());
  };
  const control = (scope: ParentNode, label: string, index = 0) => {
    const labels = [...scope.querySelectorAll<HTMLLabelElement>('label')].filter(
      (node) => node.textContent?.trim() === label,
    );
    expect(labels.length).toBeGreaterThan(index);
    return window.document.getElementById(labels[index]!.htmlFor)! as unknown as HTMLInputElement | HTMLSelectElement;
  };
  const input = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
    await act(async () => {
      const prototype =
        element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const associations = (scope: ParentNode) => {
    for (const label of scope.querySelectorAll<HTMLLabelElement>('label')) {
      expect(label.htmlFor).not.toBe('');
      const target = window.document.getElementById(label.htmlFor)!;
      expect(target).not.toBeNull();
      expect([...host.querySelectorAll('[id]')].filter((node) => node.id === label.htmlFor)).toHaveLength(1);
      expect(scope.contains(target as unknown as Node)).toBe(true);
      expect(target.closest('[data-slot="field"]')).toBe(label.closest('[data-slot="field"]'));
    }
  };
  const queued = (element: object, name: string) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
    const props = Reflect.get(element, key) as Record<string, (event: unknown) => unknown>;
    return () => props[name]!({ currentTarget: element, preventDefault() {} });
  };
  const outside = window.document.createElement('button');
  outside.textContent = 'Independent reader focus';
  window.document.body.append(outside);
  const writes = (fixture: ReturnType<typeof statementFixture>) =>
    fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/candidates'));
  const currentRead = async (fixture: ReturnType<typeof statementFixture>) => {
    const read = await fixture.editor.read();
    if (!read.ok || !read.source) throw new Error('Expected native-shaped selected fact');
    return { ...read, source: read.source };
  };
  const draftChanges: Record<string, StatementInput> = {};
  function Fields({
    name,
    current,
    initial,
    heading = 'h2',
    custom = false,
  }: {
    name: string;
    current: StatementFieldsRead;
    initial: StatementInput;
    heading?: 'h2' | 'h4';
    custom?: boolean;
  }) {
    const [draft, setDraft] = useState(initial);
    return (
      <section data-editor={name}>
        <StatementFields
          draft={draft}
          current={current}
          locale="en"
          heading={heading}
          valueControl={<PartValue part={draft} read={current} locale="en" />}
          {...(custom
            ? {
                partControl: (part: SnakInput, change: (value: StatementInput['value']) => void) =>
                  part.property.id === 'wdt:P1932' ? (
                    <input
                      aria-label="Supplied custom spelling"
                      value={part.value.type === 'value' ? String(part.value.content) : ''}
                      onChange={(event) => change({ type: 'value', content: event.target.value })}
                    />
                  ) : undefined,
              }
            : {})}
          change={(next) => {
            draftChanges[name] = next;
            setDraft(next);
          }}
        />
      </section>
    );
  }
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Supplied family must not add network reads'));
  try {
    const supplied = statementFixture('ready', 'en', 'schema:author');
    const current = { release: supplied.release, public: supplied.publicRead, source: supplied.source };
    const initial = statementInput(supplied.source);
    initial.qualifiers = [
      { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
      { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Antoine de Saint-Exupéry' } },
    ];
    initial.references.push({
      parts: [
        {
          property: { id: 'schema:url' },
          value: { type: 'value', content: 'https://example.org/evidence/second-complete-source' },
        },
        {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { text: '原文の完全な書誌情報', language: 'ja' } },
        },
        {
          property: { id: 'schema:height' },
          value: {
            type: 'value',
            content: {
              amount: '+1.75',
              unit: 'http://www.wikidata.org/entity/Q11573',
              lowerBound: '+1.74',
              upperBound: '+1.76',
            },
          },
        },
        { property: { id: 'schema:genre' }, value: { type: 'novalue' } },
      ],
    });
    const original = structuredClone(initial);
    const pair = (read = current) => (
      <>
        <Fields name="A" current={read} initial={initial} />
        <Fields name="B" current={current} initial={structuredClone(initial)} heading="h4" custom />
      </>
    );
    await render(pair());
    const first = host.querySelector<HTMLElement>('[data-editor="A"]')!;
    const second = host.querySelector<HTMLElement>('[data-editor="B"]')!;
    associations(host);
    expect([...first.querySelectorAll('h2')].map((node) => node.textContent)).toEqual([
      m.correction_replacement(),
      m.correction_qualifiers(),
      m.correction_references(),
    ]);
    expect([...second.querySelectorAll('h4')].map((node) => node.textContent)).toEqual([
      m.correction_replacement(),
      m.correction_qualifiers(),
      m.correction_references(),
    ]);
    expect(first.querySelector('h2')?.getAttribute('data-content-item-slot')).toBe('title');
    expect(first.querySelector('a[data-slot="list-row-link"], a input, a select, a button, li')).toBeNull();
    expect([...first.querySelectorAll('legend')].map((node) => node.textContent?.trim())).toEqual([
      `${m.correction_references()} 1`,
      `${m.correction_references()} 2`,
    ]);
    expect(control(first, m.correction_language()).value).toBe('ja');
    expect(control(first, m.correction_lower()).value).toBe('+1.74');
    expect(control(first, m.correction_upper()).value).toBe('+1.76');
    expect(first.textContent).toContain(m.correction_preserved());
    const firstIds = [...first.querySelectorAll<HTMLLabelElement>('label')].map((node) => node.htmlFor);
    const addQualifier = control(first, m.correction_add_qualifier());
    await input(addQualifier, 'schema:position');
    const addScope = addQualifier.closest('[data-slot="field"]')!.parentElement!;
    await click(addScope, m.correction_add());
    expect(draftChanges.A!.qualifiers).toEqual([
      ...original.qualifiers!,
      { property: { id: 'schema:position' }, value: { type: 'value', content: '' } },
    ]);
    expect(control(second, m.correction_add_qualifier()).value).toBe('');
    expect(draftChanges.B).toBeUndefined();
    const other = second.querySelector<HTMLInputElement>('[aria-label="Supplied custom spelling"]')!;
    await input(other, 'Independent spelling · 別の表記');
    expect(draftChanges.B!.qualifiers![1]!.value).toEqual({
      type: 'value',
      content: 'Independent spelling · 別の表記',
    });
    expect(draftChanges.A!.qualifiers![1]).toEqual(original.qualifiers![1]);
    other.focus();
    await render(pair());
    expect(window.document.activeElement).toBe(other);
    expect(
      [...first.querySelectorAll<HTMLLabelElement>('label')].slice(0, firstIds.length).map((node) => node.htmlFor),
    ).toContain(firstIds[0]!);
    const addPart = control(second, m.correction_add_part(), 1);
    await input(addPart, 'schema:url');
    await click(addPart.closest('[data-slot="field"]')!.parentElement!, m.correction_add());
    const extra = control(second, m.correction_url(), 2);
    await input(extra, 'https://example.org/independent/third-part');
    expect(draftChanges.B!.references[0]).toEqual(original.references[0]);
    expect(draftChanges.B!.references[1]!.parts.slice(0, original.references[1]!.parts.length)).toEqual(
      original.references[1]!.parts,
    );
    expect(draftChanges.B!.references[1]!.parts.at(-1)).toEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://example.org/independent/third-part' },
    });
    expect(draftChanges.A!.references).toEqual(original.references);
    associations(host);

    // No-choice -> choice on the same AddPart mount keeps unconditional DOM ids valid.
    const hiddenChoices = structuredClone(current);
    hiddenChoices.release.properties['schema:author']!.qualifiers = [];
    await render(pair(hiddenChoices));
    expect([...first.querySelectorAll('label')].some((node) => node.textContent === m.correction_add_qualifier())).toBe(
      false,
    );
    await render(pair());
    associations(host);
    expect(control(first, m.correction_add_qualifier()).id).toBe(addQualifier.id);
    expect(supplied.calls).toHaveLength(0);

    // Supplied-data growth only: 64 parts fit FOUR references of 16, never 64 references
    // or qualifiers. Native bounds stay intact. An unrelated population cannot be traversed.
    for (const size of [1, 8, 64]) {
      const draft = statementInput(supplied.source);
      draft.references = Array.from({ length: Math.ceil(size / 16) }, (_, group) => ({
        parts: Array.from({ length: Math.min(16, size - group * 16) }, (_, index) => ({
          property: { id: 'schema:url' },
          value: { type: 'value' as const, content: `https://example.org/growth/${group * 16 + index}` },
        })),
      }));
      expect(validateStatement(draft, supplied.release)).toEqual([]);
      const guarded = {
        ...current,
        public: {
          ...current.public,
          subject: {
            ...current.public.subject,
            statements: new Proxy(current.public.subject.statements, {
              ownKeys() {
                throw new Error('No whole-population traversal');
              },
            }),
          },
        },
      };
      await render(<Fields key={`growth:${size}`} name="growth" current={guarded} initial={draft} />);
      expect([...host.querySelectorAll('input[type="url"]')].map((node) => (node as HTMLInputElement).value)).toEqual(
        draft.references.flatMap((reference) =>
          reference.parts.map((part) => (part.value.type === 'value' ? part.value.content : '')),
        ),
      );
      expect(host.querySelectorAll('legend')).toHaveLength(Math.ceil(size / 16));
      expect(supplied.calls).toHaveLength(0);
      expect(fetch.mock.calls).toHaveLength(0);
    }
    const atLimit = statementInput(supplied.source);
    atLimit.references = Array.from({ length: 16 }, () => structuredClone(original.references[0]!));
    await render(<Fields key="limit" name="limit" current={current} initial={atLimit} />);
    expect(button(host, m.correction_add_reference()).disabled).toBe(true);
    expect(
      validateStatement({ ...atLimit, references: [...atLimit.references, original.references[0]!] }, supplied.release),
    ).toContainEqual({ pointer: '/statement/references', code: 'out_of_range' });
    const qualifierLimit = {
      ...statementInput(supplied.source),
      qualifiers: Array.from({ length: 16 }, () => structuredClone(original.qualifiers![0]!)),
    };
    expect(validateStatement(qualifierLimit, supplied.release)).toEqual([]);
    expect(
      validateStatement(
        { ...qualifierLimit, qualifiers: [...qualifierLimit.qualifiers, original.qualifiers![0]!] },
        supplied.release,
      ),
    ).toContainEqual({ pointer: '/statement/qualifiers', code: 'out_of_range' });
    const partLimit = {
      ...statementInput(supplied.source),
      references: [{ parts: Array.from({ length: 16 }, () => structuredClone(original.references[0]!.parts[0]!)) }],
    };
    expect(validateStatement(partLimit, supplied.release)).toEqual([]);
    expect(
      validateStatement(
        {
          ...partLimit,
          references: [{ parts: [...partLimit.references[0]!.parts, original.references[0]!.parts[0]!] }],
        },
        supplied.release,
      ),
    ).toContainEqual({ pointer: '/statement/references/0/parts', code: 'out_of_range' });

    // Original scalar route: public + active + one release, no per-part hydration.
    await render(null);
    const fixture = statementFixture('lost-response');
    const read = await currentRead(fixture);
    expect(fixture.calls.map((call) => call.path)).toEqual([
      `/v1/subjects/${fixture.id}`,
      '/v1/definitions/active',
      `/v1/definitions/releases/${encodeURIComponent(recorded.digest)}`,
    ]);
    const publicBefore = structuredClone(read.source);
    await render(
      <StatementEditor initial={read} locale="en" transport={fixture.editor} review={() => fixture.review} />,
    );
    expect(writes(fixture)).toHaveLength(0);
    associations(host);
    const year = control(host, m.correction_year());
    await input(year, '1946');
    await click(host, m.correction_add_reference());
    const citationSelect = control(host, m.correction_add_part(), 1);
    await input(citationSelect, 'schema:url');
    await click(citationSelect.closest('[data-slot="field"]')!.parentElement!, m.correction_add());
    const citation = 'https://example.org/complete/citation-that-is-retained-through-uncertain-replay';
    await input(control(host, m.correction_url(), 1), citation);
    expect(fixture.calls).toHaveLength(3);
    await submit();
    await until(() => buttons(host, m.correction_retry()).length === 1);
    expect(host.textContent).toContain(m.correction_unavailable());
    expect(year.value).toBe('1946');
    expect(year.matches(':disabled')).toBe(true);
    expect(buttons(host, m.correction_reload())).toHaveLength(0);
    expect(writes(fixture)).toHaveLength(1);
    const frozen = structuredClone(writes(fixture)[0]!);
    expect(frozen.body).toMatchObject({
      statement: {
        references: [
          ...statementInput(publicBefore).references,
          { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] },
        ],
      },
    });
    await submit();
    await until(() => host.textContent!.includes(m.correction_proposed()));
    expect(writes(fixture)).toHaveLength(2);
    expect(writes(fixture)[1]).toEqual(frozen);
    expect(fixture.publicRead.subject.statements[fixture.address.property]![0]).toEqual(publicBefore);
    expect(fixture.candidate.decision).toBeNull();
    expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
    await click(host, m.correction_review());
    await until(() => buttons(host, m.candidate_accept()).length === 1);
    const review = host.querySelector<HTMLElement>('#candidate-review')!;
    const publicHeading = () =>
      [...review.querySelectorAll('h3, h4')].find((node) => node.textContent === m.candidate_current())!;
    expect(publicHeading().parentElement!.textContent).toContain('1943');
    expect(publicHeading().parentElement!.textContent).not.toContain('1946');
    const confirm = async (action: string) => {
      const count = fixture.calls.filter((call) => call.method === 'POST').length;
      await click(review, action);
      const confirmation = [...review.querySelectorAll<HTMLElement>('section[aria-labelledby]')].find(
        (node) =>
          window.document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent ===
          m.candidate_confirm_title({ action }),
      )!;
      expect(confirmation).not.toBeUndefined();
      expect(window.document.activeElement).toBe(confirmation);
      expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(count);
      await click(confirmation, action);
    };
    await confirm(m.candidate_accept());
    await until(() => review.textContent!.includes(m.candidate_accepted()));
    expect(publicHeading().parentElement!.textContent).toContain('1943');
    await click(review, m.candidate_reload());
    await until(() => buttons(review, m.candidate_reject()).some((node) => !node.disabled));
    const choices = [...review.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    for (const choice of choices)
      if (choice.getAttribute('aria-checked') === 'true') await act(async () => choice.click());
    await act(async () => choices.at(-1)!.click());
    await confirm(m.candidate_adopt());
    await until(() => review.textContent!.includes(m.candidate_selection_confirmed()));
    expect(publicHeading().parentElement!.textContent).toContain('1946');
    expect(review.querySelector(`a[href*="/subjects/"]`)).not.toBeNull();
    await click(review, m.candidate_reload());
    await until(() => buttons(review, m.candidate_close()).some((node) => !node.disabled));
    expect(publicHeading().parentElement!.textContent).toContain('1946');
    expect(
      fixture.calls
        .filter((call) => call.path === `/v1/subjects/${fixture.id}` && call.method === 'GET')
        .every((call) => call.authorization === null),
    ).toBe(true);

    // Real invalid-field summary still owns its native date anchor and local focus.
    await render(null);
    const invalid = statementFixture('invalid');
    await render(
      <StatementEditor
        initial={await currentRead(invalid)}
        locale="en"
        transport={invalid.editor}
        review={() => invalid.review}
      />,
    );
    await input(control(host, m.correction_year()), '1946');
    await submit();
    await until(() => host.textContent!.includes(m.correction_invalid()));
    const errors = host.querySelector('ul[aria-label]')!;
    const anchor = errors.querySelector<HTMLAnchorElement>('a')!;
    const target = window.document.getElementById(anchor.hash.slice(1))!;
    expect(target.getAttribute('aria-invalid')).toBe('true');
    expect(target.getAttribute('aria-describedby')).toBe(errors.querySelector('li')!.id);
    await act(async () => anchor.click());
    expect(window.document.activeElement).toBe(target);
    expect(control(host, m.correction_year()).value).toBe('1946');

    // Truthful empty/denied/stale/unavailable are distinct and keep their recovery.
    for (const reason of ['denied', 'stale', 'unavailable', 'invalid'] as const) {
      await render(<EditorFailure reason={reason} locale="en" />);
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        reason === 'denied'
          ? m.correction_denied()
          : reason === 'stale'
            ? m.correction_stale()
            : reason === 'invalid'
              ? m.correction_invalid()
              : m.correction_unavailable(),
      );
      expect(host.querySelector('form')).toBeNull();
    }
    await render(
      <StatementEditor
        initial={{ ...read, source: null }}
        locale="en"
        transport={fixture.editor}
        review={() => fixture.review}
      />,
    );
    expect(host.textContent).toContain(m.correction_empty());
    expect(buttons(host, m.correction_reload())).toHaveLength(1);
    expect(host.querySelector('form')).toBeNull();

    // Actual editor retirement: late proposal delivery and queued form callbacks cannot
    // change the next reader's draft, trigger a review read or steal independent focus.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      for (const transition of ['reader', 'locale', 'target', 'unmount'] as const) {
        await render(null);
        const retiring = statementFixture();
        const initial = await currentRead(retiring);
        let resolve!: (result: ProposalResult) => void;
        let reject!: (error: Error) => void;
        const held = new Promise<ProposalResult>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        let proposals = 0;
        const transport = {
          ...retiring.editor,
          propose: async () => {
            proposals++;
            return held;
          },
        };
        const observed = { state: 'signed-in' as const, subject: 'original-reader', csrfToken: 'original-csrf' };
        const editor = (reader = observed, locale = 'en', source = initial): ReactNode => (
          <CandidateReaderBoundary observed={reader} address="statement-family">
            <StatementEditor initial={source} locale={locale} transport={transport} review={() => retiring.review} />
          </CandidateReaderBoundary>
        );
        await render(editor());
        await input(control(host, m.correction_year()), '1946');
        const oldSubmit = queued(host.querySelector('form')!, 'onSubmit');
        await submit();
        expect(proposals).toBe(1);
        if (transition === 'reader') await render(editor({ ...observed, subject: 'replacement-reader' }));
        if (transition === 'locale') await render(editor(observed, 'fr'));
        if (transition === 'target')
          await render(editor(observed, 'en', { ...initial, source: { ...initial.source, id: crypto.randomUUID() } }));
        if (transition === 'unmount') await render(null);
        const before = host.textContent;
        const calls = retiring.calls.length;
        outside.focus();
        await act(async () => {
          void oldSubmit();
        });
        expect(proposals).toBe(1);
        await act(async () => {
          if (delivery === 'throw') reject(new Error('Late unavailable result'));
          else
            resolve(
              delivery === 'failure'
                ? { ok: false, reason: 'unavailable' }
                : {
                    ok: true,
                    kind: 'proposed-awaiting-review',
                    candidate: retiring.candidate.id,
                    revision: 2,
                    session: 'old-continuity',
                  },
            );
        });
        await settle();
        expect(host.textContent).toBe(before);
        expect(host.textContent).not.toContain(m.correction_proposed());
        expect(retiring.calls).toHaveLength(calls);
        expect(window.document.activeElement).toBe(outside);
      }
    }
    expect(fetch.mock.calls).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    fetch.mockRestore();
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
