import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { StatementFieldsRead } from '../src/features/catalogue/statement-editor-view';
import {
  statementInput,
  validateStatement,
  type EditorRead,
  type ProposalResult,
  type StatementInput,
  type SnakInput,
} from '../src/features/catalogue/statement-editor';
import { statementFixture } from '../src/kernel/fake/catalogue-statements';
import recorded from '../src/kernel/recorded/definitions-release.json';
import { contributionFixture } from '../src/kernel/fake/contribution-lifecycle';
import type { ContributionCommand, ContributionResult } from '../src/features/catalogue/contribution-lifecycle';

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
  let showSearchLink = false;
  function Surface() {
    const [node, setNode] = useState<ReactNode>(null);
    show = (next) => setNode(() => next);
    return showSearchLink
      ? createElement('div', null, createElement(Link, { to: '/search' }, 'Search destination'), node)
      : node;
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const editorRoute = createRoute({ getParentRoute: () => rootRoute, path: '/edit', component: Surface });
  let arrivals = 0;
  const destinationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/search',
    onEnter: () => arrivals++,
    component: () => createElement('h1', null, 'Actual search destination'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editorRoute, destinationRoute]),
    history: createMemoryHistory({ initialEntries: ['/edit'] }),
  });
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
  const unloadIsProtected = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
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
    for (const label of [
      m.correction_remove_qualifier(),
      m.correction_remove_reference(),
      m.correction_remove_reference_part(),
    ])
      expect(buttons(host, label)).toHaveLength(0);
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

    // Undo only local additions, including a duplicate in the middle. Surviving controls
    // keep their DOM identity and uncommitted property selection after indexes shift.
    await click(first, m.correction_remove_qualifier());
    expect(draftChanges.A).toEqual(original);
    expect(window.document.activeElement).toBe(addQualifier);
    for (let count = 0; count < 2; count++) {
      await input(addQualifier, 'schema:position');
      await click(addScope, m.correction_add());
    }
    const qualifierRemovals = buttons(first, m.correction_remove_qualifier());
    const survivingValue = qualifierRemovals[1]!.parentElement!.querySelector<HTMLInputElement>('input')!;
    await input(survivingValue, 'Keep this ordinal');
    await act(async () => qualifierRemovals[0]!.click());
    expect(draftChanges.A!.qualifiers).toEqual([
      ...original.qualifiers!,
      { property: { id: 'schema:position' }, value: { type: 'value', content: 'Keep this ordinal' } },
    ]);
    expect(button(first, m.correction_remove_qualifier()).parentElement!.querySelector('input')).toBe(survivingValue);
    expect(window.document.activeElement).toBe(addQualifier);
    await click(first, m.correction_remove_qualifier());
    await click(second, m.correction_remove_reference_part());
    expect(draftChanges.B!.references).toEqual(original.references);
    expect(draftChanges.B!.qualifiers![1]!.value).toEqual({
      type: 'value',
      content: 'Independent spelling · 別の表記',
    });
    expect(window.document.activeElement).toBe(addPart);
    await click(first, m.correction_add_reference());
    const localGroup = first.querySelectorAll('fieldset')[2]!;
    const localPartChoice = control(localGroup, m.correction_add_part());
    await input(localPartChoice, 'schema:url');
    await click(localPartChoice.closest('[data-slot="field"]')!.parentElement!, m.correction_add());
    await click(localGroup, m.correction_remove_reference_part());
    expect(draftChanges.A!.references).toEqual([...original.references, { parts: [] }]);
    expect(window.document.activeElement).toBe(localPartChoice);
    await click(first, m.correction_add_reference());
    const survivingChoice = control(first, m.correction_add_part(), 3);
    await input(survivingChoice, 'schema:url');
    await click(localGroup, m.correction_remove_reference());
    expect(control(first, m.correction_add_part(), 2)).toBe(survivingChoice);
    expect(survivingChoice.value).toBe('schema:url');
    expect(window.document.activeElement).toBe(button(first, m.correction_add_reference()));
    for (let count = 0; count < 13; count++) await click(first, m.correction_add_reference());
    expect(button(first, m.correction_add_reference()).disabled).toBe(true);
    while (buttons(first, m.correction_remove_reference()).length) {
      await act(async () => buttons(first, m.correction_remove_reference())[0]!.click());
      expect(button(first, m.correction_add_reference()).disabled).toBe(false);
      expect(window.document.activeElement).toBe(button(first, m.correction_add_reference()));
    }
    expect(draftChanges.A).toEqual(original);
    associations(host);

    // No-choice -> choice on the same AddPart mount keeps unconditional DOM ids valid.
    const hiddenChoices = structuredClone(current);
    hiddenChoices.release.properties['schema:author']!.qualifiers = [];
    await input(addQualifier, 'schema:position');
    await click(addScope, m.correction_add());
    await render(pair(hiddenChoices));
    await click(first, m.correction_remove_qualifier());
    expect(window.document.activeElement).toBe(first.querySelectorAll('section')[1]!);
    expect(draftChanges.A).toEqual(original);
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
    for (const label of [m.correction_remove_reference(), m.correction_remove_reference_part()]) {
      expect(button(host, label).matches(':disabled')).toBe(true);
      await click(host, label);
    }
    expect(control(host, m.correction_url(), 1).value).toBe(citation);
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
    expect(unloadIsProtected()).toBe(false);
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

    // Explicit single-statement reload retires public authority before I/O settles.
    await render(null);
    const refreshing = statementFixture();
    const fresh = await currentRead(refreshing);
    let deliver!: (next: EditorRead) => void;
    let rejectRead!: (error: Error) => void;
    let refreshes = 0;
    await render(
      <StatementEditor initial={fresh} locale="en" review={() => refreshing.review} transport={{
        ...refreshing.editor,
        read: () => { refreshes++; return new Promise((resolve, reject) => { deliver = resolve; rejectRead = reject; }); },
      }} />,
    );
    await input(control(host, m.correction_year()), '1947');
    const oldSubmit = queued(host.querySelector('form')!, 'onSubmit');
    const publicLabel = host.querySelector('header a')!.textContent;
    const keyboardReload = async () => {
      const opener = button(host, m.correction_reload());
      await act(async () => { opener.focus(); opener.click(); });
    };
    const privateDraft = () => {
      expect(host.querySelector('form')).toBeNull();
      expect(host.querySelector('header a')).toBeNull();
      expect(host.textContent).toContain(m.facts_private());
      expect(host.querySelector('pre')!.textContent).toContain('+1947-');
      expect(buttons(host, m.correction_submit())).toHaveLength(0);
    };
    await keyboardReload();
    privateDraft();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => oldSubmit());
    expect(writes(refreshing)).toHaveLength(0);
    await act(async () => deliver({ ok: false, reason: 'denied' }));
    privateDraft();
    expect(host.textContent).toContain(m.correction_denied());
    expect(window.document.activeElement).toBe(host.querySelector('[role="alert"]')!.parentElement);
    await keyboardReload();
    await act(async () => rejectRead(new Error('Read unavailable')));
    privateDraft();
    expect(host.textContent).toContain(m.correction_unavailable());
    for (const next of [
      { ok: true },
      { ...fresh, public: { ...fresh.public, subject: { ...fresh.public.subject, id: 'different-subject' } } },
      { ...fresh, source: { ...fresh.source, id: 'different-source' } },
      { ...fresh, release: { ...fresh.release, properties: {} } },
    ] as EditorRead[]) {
      await keyboardReload();
      await act(async () => deliver(next));
      privateDraft();
    }
    await keyboardReload();
    // A newer focus choice cancels the keyboard return, even when focus later becomes idle.
    outside.focus();
    outside.blur();
    await act(async () => deliver(fresh));
    expect(control(host, m.correction_year()).value).toBe('1947');
    expect(host.querySelector('header a')!.textContent).toBe(publicLabel);
    expect(window.document.activeElement).not.toBe(host.querySelector('h1'));
    await keyboardReload();
    await act(async () => deliver(fresh));
    expect(window.document.activeElement).toBe(host.querySelector('h1'));
    expect(control(host, m.correction_year()).value).toBe('1947');
    expect(refreshes).toBe(8);
    expect(writes(refreshing)).toHaveLength(0);
    await submit();
    await until(() => host.textContent!.includes(m.correction_proposed()));
    expect(JSON.stringify(writes(refreshing)[0]!.body)).toContain('+1947-');

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
    await render(null);
    const navigationFixture = statementFixture();
    const navigationRead = await currentRead(navigationFixture);
    if (!navigationRead.ok) throw new Error('Expected a correction for navigation');
    showSearchLink = true;
    await render(
      createElement(StatementEditor, {
        initial: navigationRead,
        locale: 'en',
        transport: navigationFixture.editor,
        review: () => navigationFixture.review,
      }),
    );
    const year = control(host, m.correction_year());
    await input(year, '1946');
    await click(host, m.correction_add_reference());
    const citationSelect = control(host, m.correction_add_part(), 1);
    await input(citationSelect, 'schema:url');
    await click(citationSelect.closest('[data-slot="field"]')!.parentElement!, m.correction_add());
    const citation = 'https://example.org/navigation-retained-citation';
    await input(control(host, m.correction_url(), 1), citation);
    expect(unloadIsProtected()).toBe(true);
    const departure = host.querySelector<HTMLAnchorElement>('a[href="/search"]')!;
    await act(async () => {
      departure.focus();
      departure.click();
    });
    await until(() => !!window.document.querySelector('[role="alertdialog"]'));
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(m.thread_authoring_discard_unsaved());
    await click(dialog, m.thread_authoring_stay());
    await until(() => !window.document.querySelector('[role="alertdialog"]'));
    await until(() => window.document.activeElement === departure);
    expect(control(host, m.correction_year()).value).toBe('1946');
    expect(control(host, m.correction_url(), 1).value).toBe(citation);
    expect(unloadIsProtected()).toBe(true);
    await act(async () => {
      departure.focus();
      departure.click();
    });
    await until(() => !!window.document.querySelector('[role="alertdialog"]'));
    await click(window.document.querySelector('[role="alertdialog"]')!, m.thread_authoring_leave());
    await until(() => router.state.location.pathname === '/search');
    expect(arrivals).toBe(1);
    expect(unloadIsProtected()).toBe(false);

    // The reachable scalar editor embeds lifecycle recovery under its single departure owner.
    const lifecycle = contributionFixture('uncertain');
    const commands: ContributionCommand[] = [];
    let loseRestore = true;
    let held: ((result: ContributionResult) => void) | undefined;
    let hold = false;
    let clears = 0;
    const lifecyclePage = () => (
      <StatementEditor
        initial={navigationRead}
        locale="en"
        transport={navigationFixture.editor}
        review={() => navigationFixture.review}
        lifecycle={{
          ...lifecycle.transport,
          change: async (command) => {
            commands.push(command);
            if (hold)
              return new Promise<ContributionResult>((resolve) => {
                held = resolve;
              });
            const result = await lifecycle.transport.change(command);
            if (command.operation === 'restore' && loseRestore) {
              loseRestore = false;
              return { ok: false, reason: 'unavailable' };
            }
            return result;
          },
        }}
        onLifecycleClear={() => {
          clears++;
          throw new Error('Clearing failed after confirmed effect');
        }}
      />
    );
    const dialogNow = () => window.document.querySelector('[role="alertdialog"]')!;
    const depart = async () => {
      await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/search"]')!.click());
      await until(() => !!dialogNow());
      expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
      expect(dialogNow().textContent).toContain(m.thread_authoring_leave_pending());
    };
    const send = async (action: string) => {
      await click(host, action);
      await until(() => !!dialogNow());
      await click(dialogNow(), m.contribution_confirm());
    };
    await act(async () => {
      await router.navigate({ to: '/edit' });
    });
    await render(lifecyclePage());
    expect(unloadIsProtected()).toBe(false);
    await input(control(host, m.correction_year()), '1946');
    await submit();
    await until(() => buttons(host, m.contribution_withdraw()).length === 1);
    await click(host, m.contribution_withdraw());
    await until(() => !!dialogNow());
    await click(dialogNow(), m.candidate_cancel());
    expect(unloadIsProtected()).toBe(false);
    for (const action of [m.contribution_withdraw(), m.contribution_restore()]) {
      await send(action);
      await until(() => buttons(host, m.contribution_retry()).some((button) => !button.disabled));
      expect(unloadIsProtected()).toBe(true);
      const original = structuredClone(commands.at(-1)!);
      const request = structuredClone(lifecycle.calls.filter((call) => call.method !== 'GET').at(-1)!);
      const count = commands.length;
      await depart();
      await click(dialogNow(), m.thread_authoring_stay());
      await until(() => !dialogNow());
      expect(router.state.location.pathname).toBe('/edit');
      expect(commands).toHaveLength(count);
      expect(unloadIsProtected()).toBe(true);
      await click(host, m.contribution_retry());
      await until(() => !host.querySelector('[aria-busy="true"]'));
      expect(commands.at(-1)).toEqual(original);
      expect(lifecycle.calls.filter((call) => call.method !== 'GET').at(-1)).toEqual(request);
      expect(unloadIsProtected()).toBe(false);
      expect(host.textContent).not.toContain(m.contribution_unavailable());
    }
    expect(clears).toBe(1);
    hold = true;
    await send(m.contribution_withdraw());
    await until(() => !!held);
    const retiredAction = queued(button(host, m.contribution_retry()), 'onClick');
    await depart();
    await click(dialogNow(), m.thread_authoring_leave());
    await until(() => router.state.location.pathname === '/search');
    await act(async () => {
      await router.navigate({ to: '/edit' });
    });
    await render(lifecyclePage());
    outside.focus();
    const before = host.textContent;
    await act(async () => {
      retiredAction();
      held!({
        ok: true,
        operation: 'delete',
        current: { subject: 'available', candidate: 'deleted', selected: false },
      });
    });
    await settle();
    expect(host.textContent).toBe(before);
    expect(clears).toBe(1);
    expect(commands).toHaveLength(5);
    expect(window.document.activeElement).toBe(outside);
    expect(unloadIsProtected()).toBe(false);
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
