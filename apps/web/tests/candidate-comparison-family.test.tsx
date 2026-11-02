import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { candidateFixture } from '../src/kernel/fake/subject-candidates';
import { contextFixture } from '../src/kernel/fake/context-curation';
import { relationFixture } from '../src/kernel/fake/catalogue-relations';
import { relationDescriptorReader } from '../src/kernel/fake/relation-descriptor';
import { readRelationEditor } from '../src/subject/relation-candidates';
import { selectCandidate } from '../src/subject/candidates';
import type { CandidateCommand, CandidateRead, CandidateResult } from '../src/subject/candidates';
import type { CandidateTransport } from '../src/subject/candidate-review';

// Authored UNRUN under MINIMAL. This uses the existing mounted React/router harness
// and real supplied fixtures. DOM and width intent establish no physical/browser proof.
test('candidate family preserves comparison, private whole selection, independent provenance and native recovery', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/book/title', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent,
    FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { userEvent } = await import('storybook/test');
  const { CandidateReview } = await import('../src/subject/candidate-review');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const originalLocale = getLocale;
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
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
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
  const buttons = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent?.trim() === text);
  const button = (scope: ParentNode, text: string) => {
    const found = buttons(scope, text).at(-1);
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (scope: ParentNode, text: string) => {
    const target = button(scope, text);
    expect(target.disabled).toBe(false);
    await act(async () => target.click());
  };
  const select = async (element: HTMLSelectElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const include = (scope: ParentNode, id: string) => scope.querySelector<HTMLElement>(`[id="include-${id}"]`)!;
  const toggle = async (scope: ParentNode, id: string) => {
    await act(async () => include(scope, id).click());
  };
  const rank = (scope: ParentNode, id: string) => scope.querySelector<HTMLSelectElement>(`[id="rank-${id}"]`)!;
  const confirmation = (scope: ParentNode, action: string) => {
    const region = [...scope.querySelectorAll<HTMLElement>('section[aria-labelledby]')].find(
      (node) => node.querySelector('h4')?.textContent === m.candidate_confirm_title({ action }),
    );
    expect(region).toBeDefined();
    expect(region!.getAttribute('aria-labelledby')).toBe(region!.querySelector('h4')!.id);
    return region!;
  };
  const open = async (fixture: ReturnType<typeof candidateFixture>, scope: HTMLElement = host) => {
    await click(scope, m.candidate_entry());
    await until(() => !!scope.querySelector('#candidate-field'));
    await select(scope.querySelector<HTMLSelectElement>('#candidate-field')!, fixture.property);
    await until(
      () => buttons(scope, m.candidate_review()).length > 0 || scope.textContent!.includes(m.candidate_empty()),
    );
  };
  const compare = async (scope: HTMLElement = host) => {
    await click(scope, m.candidate_review());
    expect(scope.querySelector('[data-candidate-panel="current"] h4')?.textContent).toBe(m.candidate_current());
    expect(scope.querySelector('[data-candidate-panel="proposed"] h4')?.textContent).toBe(m.candidate_proposed());
  };
  const confirm = async (scope: HTMLElement, action: string) => {
    await click(scope, action);
    const region = confirmation(scope, action);
    expect(window.document.activeElement).toBe(region);
    await click(region, action);
  };
  const view = (fixture: ReturnType<typeof candidateFixture>, extra = {}) => (
    <CandidateReview id={fixture.id} locale="en" transport={fixture.transport} {...extra} />
  );
  const posts = (fixture: ReturnType<typeof candidateFixture>) =>
    fixture.calls.filter((call) => call.method === 'POST');
  const outside = window.document.createElement('button');
  outside.textContent = 'Independent focus';
  window.document.body.append(outside);
  try {
    // Deliberate entry/field choice -> comparison -> three explicit cancel paths -> accept.
    const fixture = candidateFixture();
    await render(view(fixture));
    expect(fixture.calls).toHaveLength(0);
    await open(fixture);
    expect(fixture.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
    const row = host.querySelector('[data-candidate-item]')!;
    expect(row.parentElement!.tagName).toBe('LI');
    expect(row.parentElement!.parentElement!.tagName).toBe('UL');
    expect(row.className).toContain('group');
    const reads = fixture.calls.length;
    await compare();
    expect(host.querySelector('h2[data-content-item-slot="title"]')).not.toBeNull();
    expect(host.querySelector('h3[data-content-item-slot="title"]')).not.toBeNull();
    expect(host.querySelector('a[data-slot="list-row-link"], a a, a button')).toBeNull();
    for (const label of host.querySelectorAll<HTMLLabelElement>('label')) {
      expect(host.querySelector(`[id="${label.htmlFor}"]`)).not.toBeNull();
    }
    const selected = [...host.querySelectorAll('[role="checkbox"]')].map((node) => node.getAttribute('aria-checked'));
    for (const action of [m.candidate_accept(), m.candidate_reject(), m.candidate_adopt()]) {
      const trigger = button(host, action);
      await click(host, action);
      const region = confirmation(host, action);
      expect(window.document.activeElement).toBe(region);
      expect(trigger.disabled).toBe(true);
      expect(posts(fixture)).toHaveLength(0);
      await act(async () => userEvent.tab());
      expect(window.document.activeElement).toBe(button(region, action));
      await act(async () => userEvent.tab());
      expect(window.document.activeElement).toBe(button(region, m.candidate_cancel()));
      await act(async () => userEvent.keyboard('{Enter}'));
      expect(window.document.activeElement).toBe(trigger);
      expect(region.isConnected).toBe(false);
      expect([...host.querySelectorAll('[role="checkbox"]')].map((node) => node.getAttribute('aria-checked'))).toEqual(
        selected,
      );
    }
    expect(fixture.calls).toHaveLength(reads);
    await confirm(host, m.candidate_accept());
    await until(() => host.textContent!.includes(m.candidate_accepted()));
    expect(posts(fixture)).toHaveLength(1);
    expect(host.querySelector('[data-candidate-panel="current"]')!.textContent).toContain('1943');
    expect(host.querySelector(`a[href*="/subjects/"]`)).toBeNull();
    await click(host, m.candidate_reload());
    await until(() => buttons(host, m.candidate_review()).length > 0);
    for (const choice of host.querySelectorAll<HTMLElement>('[role="checkbox"]'))
      if (choice.getAttribute('aria-checked') === 'true') await act(async () => choice.click());
    await toggle(host, fixture.candidate.id);
    await select(rank(host, fixture.candidate.id), 'preferred');
    await confirm(host, m.candidate_adopt());
    await until(() => host.textContent!.includes(m.candidate_selection_confirmed()));
    expect(posts(fixture).at(-1)!.body).toMatchObject({
      selection: [{ candidate: fixture.candidate.id, rank: 'preferred' }],
      expected_head: 1,
    });
    expect(host.querySelector('a[href*="/subjects/"]')).not.toBeNull();
    await click(host, m.candidate_reload());
    await until(() => buttons(host, m.candidate_review()).length > 0);
    expect(include(host, fixture.candidate.id).getAttribute('aria-checked')).toBe('true');
    expect(rank(host, fixture.candidate.id).value).toBe('preferred');
    expect(fixture.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(3);

    // Whole multivalue draft keeps the public off-page value through native continuation.
    await render(null);
    const multiple = candidateFixture('multiple');
    await render(view(multiple));
    await open(multiple);
    expect(host.textContent).toContain(m.candidate_selection_limit({ limit: '32' }));
    const offPage = multiple.candidates[2]!.id;
    expect(include(host, offPage).getAttribute('aria-checked')).toBe('true');
    expect(host.querySelectorAll('[data-candidate-item]')).toHaveLength(2);
    await toggle(host, multiple.candidate.id);
    await select(rank(host, multiple.candidate.id), 'preferred');
    await click(host, m.candidate_more());
    await until(() => host.querySelectorAll('[data-candidate-item]').length === 3);
    expect(
      [...host.querySelectorAll('[role="checkbox"]')].filter((node) => node.getAttribute('aria-checked') === 'true'),
    ).toHaveLength(3);
    await confirm(host, m.candidate_adopt());
    await until(() => host.textContent!.includes(m.candidate_selection_confirmed()));
    expect(posts(multiple)[0]!.body).toMatchObject({
      selection: expect.arrayContaining([
        { candidate: offPage, rank: 'normal' },
        { candidate: multiple.candidate.id, rank: 'preferred' },
      ]),
    });
    expect(multiple.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(2);

    // Actual released scalar maximum is one, so the occupied choice cannot be added.
    await render(null);
    const scalar = candidateFixture();
    scalar.candidate.decision = 'accepted';
    await render(view(scalar));
    await open(scalar);
    expect(host.textContent).toContain(m.candidate_selection_limit({ limit: '1' }));
    expect(include(host, scalar.candidate.id).hasAttribute('disabled')).toBe(true);

    // Supplied-data growth: 1/8/32 current public language assertions, not a 32-row
    // candidate response (native candidate pages remain <=20). No backend cap is invented.
    const languages = [
      'en',
      'fr',
      'de',
      'ja',
      'ko',
      'es',
      'it',
      'pt',
      'nl',
      'sv',
      'da',
      'fi',
      'no',
      'is',
      'pl',
      'cs',
      'sk',
      'sl',
      'hr',
      'sr',
      'bg',
      'ro',
      'hu',
      'el',
      'tr',
      'ar',
      'he',
      'fa',
      'hi',
      'bn',
      'th',
      'vi',
    ];
    for (const size of [1, 8, 32]) {
      await render(null);
      const growth = candidateFixture('multiple');
      growth.publicRead.subject.statements[growth.property] = languages.slice(0, size).map((language, index) => ({
        ...structuredClone(growth.candidate.statement),
        id: `00000000-0000-8000-8000-${String(index + 1000).padStart(12, '0')}`,
        value: { type: 'value' as const, content: language },
      }));
      await render(view(growth));
      await open(growth);
      expect(host.querySelectorAll('[data-candidate-item]')).toHaveLength(2);
      expect(host.querySelectorAll('[data-candidate-choice]')).toHaveLength(size + 2);
      expect(
        [...host.querySelectorAll('[role="checkbox"]')].filter((node) => node.getAttribute('aria-checked') === 'true'),
      ).toHaveLength(size);
      expect(growth.calls).toHaveLength(3);
      expect(posts(growth)).toHaveLength(0);
      if (size === 32) expect(include(host, growth.candidate.id).hasAttribute('disabled')).toBe(true);
    }

    // A retained choice that disappears from the next bounded read is unresolved and
    // cannot be adopted until the reader explicitly removes it; no silent draft pruning.
    await render(null);
    const unresolved = candidateFixture('multiple');
    await render(view(unresolved));
    await open(unresolved);
    await toggle(host, unresolved.candidate.id);
    unresolved.candidates.splice(0, 1);
    await click(host, m.candidate_close());
    await click(host, m.candidate_entry());
    await until(() => !!host.querySelector('#candidate-field'));
    await select(host.querySelector<HTMLSelectElement>('#candidate-field')!, unresolved.property);
    await until(() => host.textContent!.includes(m.candidate_choice_unresolved()));
    expect(include(host, unresolved.candidate.id).getAttribute('aria-checked')).toBe('true');
    expect(rank(host, unresolved.candidate.id).disabled).toBe(true);
    expect(button(host, m.candidate_adopt()).disabled).toBe(true);
    await toggle(host, unresolved.candidate.id);
    expect(button(host, m.candidate_adopt()).disabled).toBe(false);

    // Retraction and exact-target absence never produce an actionable comparison.
    for (const kind of ['retracted', 'missing'] as const) {
      await render(null);
      const exact = candidateFixture();
      if (kind === 'retracted') exact.candidate.retracted = 4;
      await render(
        view(exact, {
          initialProperty: exact.property,
          exactCandidate: kind === 'missing' ? '00000000-0000-8000-8000-000000000999' : exact.candidate.id,
        }),
      );
      await until(() =>
        host.textContent!.includes(kind === 'missing' ? m.correction_exact_missing() : m.candidate_retracted()),
      );
      expect(buttons(host, m.candidate_accept())).toHaveLength(0);
      if (kind === 'retracted') expect(button(host, m.candidate_review()).disabled).toBe(true);
      expect(posts(exact)).toHaveLength(0);
    }

    // Keep stale, denial, invalid, unavailable, empty and pending distinct on real fixtures.
    for (const scenario of ['stale', 'denied', 'invalid'] as const) {
      await render(null);
      const failed = candidateFixture(scenario);
      await render(view(failed));
      await open(failed);
      await compare();
      await confirm(host, m.candidate_reject());
      await until(() => !!host.querySelector('[role="alert"]'));
      expect(host.textContent).toContain(
        scenario === 'stale'
          ? m.candidate_draft_stale()
          : scenario === 'denied'
            ? m.candidate_denied()
            : m.candidate_invalid(),
      );
      expect(posts(failed)).toHaveLength(1);
      expect(buttons(host, m.candidate_retry())).toHaveLength(0);
      if (scenario === 'denied')
        expect(host.querySelector('[data-candidate-draft], [data-candidate-panel]')).toBeNull();
      else expect(button(host, m.candidate_reject()).disabled).toBe(true);
      await click(host, m.candidate_reload());
      await until(() => buttons(host, m.candidate_review()).length > 0);
      expect(posts(failed)).toHaveLength(1);
    }
    for (const scenario of ['empty', 'unavailable'] as const) {
      await render(null);
      const failed = candidateFixture(scenario);
      await render(view(failed));
      await click(host, m.candidate_entry());
      await until(() => !!host.querySelector('#candidate-field'));
      await select(host.querySelector<HTMLSelectElement>('#candidate-field')!, failed.property);
      await until(() =>
        host.textContent!.includes(scenario === 'empty' ? m.candidate_empty() : m.candidate_unavailable()),
      );
      expect(buttons(host, m.candidate_review())).toHaveLength(0);
      expect(posts(failed)).toHaveLength(0);
    }
    await render(null);
    const pending = candidateFixture('pending');
    pending.candidate.decision = 'accepted';
    await render(view(pending));
    await open(pending);
    for (const choice of host.querySelectorAll<HTMLElement>('[role="checkbox"]'))
      if (choice.getAttribute('aria-checked') === 'true') await act(async () => choice.click());
    await toggle(host, pending.candidate.id);
    await confirm(host, m.candidate_adopt());
    await until(() => host.textContent!.includes(m.candidate_pending()));
    expect(host.querySelector('a[href*="/subjects/"]')).toBeNull();

    // Source attribution and independent licence destinations stay visible outside
    // the technical disclosure, including long values, qualifiers and all citation parts.
    const long = candidateFixture('ready', 'en', 'schema:alternateName');
    const text = '旅人の物語と長い道のり — récit intégral '.repeat(8).trim();
    const evidence = '原文と書誌情報 — attribution conservée '.repeat(6).trim();
    const rights = 'Contributeurs et droits de réutilisation · 権利を保持 '.repeat(6).trim();
    long.candidate.statement.value = { type: 'value', content: { text, language: 'ja' } };
    long.candidate.statement.qualifiers = [
      { property: { id: 'wdt:P1932', data_type: 'string' }, value: { type: 'value', content: evidence } },
    ];
    long.candidate.statement.references[0]!.parts.push({
      property: { id: 'schema:name', data_type: 'monolingualtext' },
      value: { type: 'value', content: { text: evidence, language: 'fr' } },
    });
    Object.assign(long.publicRead.subject, {
      sourceRecords: [
        {
          name: evidence,
          url: 'https://www.wikidata.org/wiki/Q25338',
          attribution: rights,
          licence: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
        },
      ],
    });
    const source = long.candidate.source!;
    if (!('source' in source)) throw new Error('Expected import provenance');
    source.external_id = `Q25338/${'exact-record-'.repeat(8)}`;
    source.record_revision = `revision/${'a'.repeat(64)}`;
    source.converter_revision = `wikidata/${'b'.repeat(64)}`;
    for (const [width, dir, locale] of [
      [390, 'ltr', 'en'],
      [1280, 'rtl', 'de'],
    ] as const) {
      await render(null);
      window.happyDOM.setWindowSize({ width, height: 844 });
      await render(<div dir={dir}>{view(long, { locale })}</div>);
      // Localized messages in production follow the supplied locale, while fallback
      // Japanese/French content language remains attached by CandidateValue itself.
      const options = { locale: locale as never };
      await click(host, m.candidate_entry({}, options));
      await until(() => !!host.querySelector('#candidate-field'));
      await select(host.querySelector<HTMLSelectElement>('#candidate-field')!, long.property);
      await until(() => buttons(host, m.candidate_review({}, options)).length > 0);
      await click(host, m.candidate_review({}, options));
      const panel = host.querySelector<HTMLElement>('[data-candidate-panel="proposed"]')!;
      expect(panel.textContent).toContain(text);
      expect(panel.textContent).toContain(evidence);
      expect(panel.textContent).toContain(rights);
      expect(panel.querySelector('[lang="ja"]')!.textContent).toBe(text);
      expect(panel.querySelector('[lang="fr"]')!.textContent).toBe(evidence);
      const details = panel.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(panel.querySelector('a a, a button, a summary')).toBeNull();
      const count = long.calls.length;
      const summary = details.querySelector('summary')!;
      expect(summary.className).toContain('pointer-coarse:min-h-11');
      expect(summary.className).toContain('focus-visible:outline-2');
      summary.focus();
      await act(async () => userEvent.keyboard('{Enter}'));
      expect(details.open).toBe(true);
      expect([...details.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
        source.external_id,
        source.record_revision,
        source.converter_revision,
      ]);
      expect(
        [...details.querySelectorAll('dd')].every(
          (node) => node.className.includes('select-text') && node.dir === 'ltr',
        ),
      ).toBe(true);
      const links = [...panel.querySelectorAll<HTMLAnchorElement>('a')];
      expect(links.map((node) => node.getAttribute('href'))).toEqual([
        'https://www.wikidata.org/wiki/Q25338',
        'https://www.wikidata.org/wiki/Q25338',
        'https://creativecommons.org/publicdomain/zero/1.0/',
      ]);
      for (const link of links) {
        link.focus();
        expect(window.document.activeElement).toBe(link);
      }
      expect(long.calls).toHaveLength(count);
      const region = host.querySelector('#candidate-review')!;
      expect(region.className).toContain('[overflow-wrap:anywhere]');
      expect(region.className).toContain('pointer-coarse:[&_a]:min-h-11');
    }

    // Unsafe reference/source/licence URLs remain readable text, never destinations.
    await render(null);
    const unsafe = candidateFixture();
    const unsafeUrl = 'javascript:alert(1)';
    unsafe.candidate.statement.references[0]!.parts[0]!.value = { type: 'value', content: unsafeUrl };
    Object.assign(unsafe.publicRead.subject, {
      sourceRecords: [
        {
          name: 'Wikidata',
          url: unsafeUrl,
          attribution: 'Wikidata contributors',
          licence: { id: 'CC0-1.0', url: 'data:text/html,unsafe' },
        },
      ],
    });
    await render(view(unsafe));
    await open(unsafe);
    await compare();
    const unsafePanel = host.querySelector('[data-candidate-panel="proposed"]')!;
    expect(unsafePanel.textContent).toContain(unsafeUrl);
    expect(unsafePanel.textContent).toContain('Wikidata contributors');
    expect(unsafePanel.textContent).toContain('CC0-1.0');
    expect(unsafePanel.querySelector('a')).toBeNull();

    // Independent mounted instances: scope fixed legacy IDs locally; never assert
    // their global uniqueness or use document.getElementById to address instance B.
    await render(null);
    const first = candidateFixture('multiple');
    const second = candidateFixture('multiple');
    await render(
      <>
        <div data-instance="a">{view(first)}</div>
        <div data-instance="b">{view(second)}</div>
      </>,
    );
    const a = host.querySelector<HTMLElement>('[data-instance="a"]')!;
    const b = host.querySelector<HTMLElement>('[data-instance="b"]')!;
    await open(first, a);
    await open(second, b);
    await toggle(a, first.candidate.id);
    await select(rank(a, first.candidate.id), 'preferred');
    expect(include(b, second.candidate.id).getAttribute('aria-checked')).toBe('false');
    await compare(a);
    await compare(b);
    await click(a, m.candidate_reject());
    const aConfirmation = confirmation(a, m.candidate_reject());
    await click(b, m.candidate_reject());
    const bConfirmation = confirmation(b, m.candidate_reject());
    expect(aConfirmation.getAttribute('aria-labelledby')).not.toBe(bConfirmation.getAttribute('aria-labelledby'));
    await click(aConfirmation, m.candidate_cancel());
    expect(window.document.activeElement).toBe(button(a, m.candidate_reject()));
    expect(bConfirmation.isConnected).toBe(true);
    await click(bConfirmation, m.candidate_reject());
    await until(() => b.textContent!.includes(m.candidate_rejected()));
    expect(posts(first)).toHaveLength(0);
    expect(posts(second)).toHaveLength(1);
    expect(a.textContent).not.toContain(m.candidate_rejected());
    expect(rank(a, first.candidate.id).value).toBe('preferred');

    // Community inherit/replace/suppress use real Context reads, separate from Global.
    for (const mode of ['inherit', 'replace', 'suppress'] as const) {
      await render(null);
      const context = contextFixture();
      await render(
        <CandidateReview
          id={context.id}
          locale="en"
          context={context.context.id}
          initialProperty={context.property}
          transport={context.transport}
        />,
      );
      await click(host, m.candidate_entry());
      await until(() => !!host.querySelector('#context-mode'));
      await select(host.querySelector<HTMLSelectElement>('#context-mode')!, mode);
      if (mode === 'replace') {
        for (const choice of host.querySelectorAll<HTMLElement>('[role="checkbox"]'))
          if (choice.getAttribute('aria-checked') === 'true') await act(async () => choice.click());
        await toggle(host, context.candidate.id);
      }
      const before = context.calls.length;
      await click(host, m.context_adopt());
      expect(context.calls).toHaveLength(before);
      const region = confirmation(host, m.context_adopt());
      expect(region.textContent).toContain(
        mode === 'inherit' ? m.context_inherit() : mode === 'replace' ? m.context_replace() : m.context_suppress(),
      );
      await click(region, m.context_adopt());
      await until(() => host.textContent!.includes(m.context_saved()));
      const writes = context.calls.filter((call) => call.method === 'POST');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body).toMatchObject({
        context: context.context.id,
        mode,
        selection: mode === 'replace' ? [{ candidate: context.candidate.id, rank: 'normal' }] : [],
      });
      await click(host, m.candidate_reload());
      await until(() => !!host.querySelector('#context-mode'));
      expect(host.querySelector<HTMLSelectElement>('#context-mode')!.value).toBe(mode);
    }

    // Context uncertain recovery preserves its distinct context, mode and native receipt.
    await render(null);
    const uncertainContext = contextFixture('uncertain');
    const contextCommands: CandidateCommand[] = [];
    const contextTransport: CandidateTransport = {
      ...uncertainContext.transport,
      confirm: (command, work) => {
        contextCommands.push(command);
        return uncertainContext.transport.confirm(command, work);
      },
    };
    await render(
      <CandidateReview
        id={uncertainContext.id}
        locale="en"
        initialProperty={uncertainContext.property}
        context={uncertainContext.context.id}
        transport={contextTransport}
      />,
    );
    await click(host, m.candidate_entry());
    await until(() => !!host.querySelector('#context-mode'));
    await select(host.querySelector<HTMLSelectElement>('#context-mode')!, 'suppress');
    await confirm(host, m.context_adopt());
    await until(() => buttons(host, m.candidate_retry()).length === 1);
    const oldContextCommand = structuredClone(contextCommands[0]!);
    expect(oldContextCommand).toMatchObject({
      head: 7,
      session: 'context-session',
      context: uncertainContext.context.id,
      mode: 'suppress',
      selection: [],
    });
    expect(host.querySelector<HTMLSelectElement>('#context-mode')!.disabled).toBe(true);
    await click(host, m.candidate_retry());
    await until(() => host.textContent!.includes(m.context_saved()));
    expect(contextCommands).toHaveLength(2);
    expect(contextCommands[1]).toBe(contextCommands[0]);
    expect(contextCommands[1]).toEqual(oldContextCommand);
    const contextWrites = uncertainContext.calls.filter((call) => call.method === 'POST');
    expect(contextWrites).toHaveLength(2);
    expect(contextWrites[1]!.body).toEqual(contextWrites[0]!.body);
    for (const header of ['idempotency-key', 'rezics-session-token'])
      expect(contextWrites[1]!.headers.get(header)).toBe(contextWrites[0]!.headers.get(header));

    // Lost delivery after an actual commit freezes exact old head/session/key/selection.
    await render(null);
    const uncertain = candidateFixture('multiple');
    const commands: CandidateCommand[] = [];
    let lost = true;
    const transport: CandidateTransport = {
      ...uncertain.transport,
      confirm: async (command, work) => {
        commands.push(command);
        const result = await uncertain.transport.confirm(command, work);
        if (lost) {
          lost = false;
          return { ok: false, reason: 'unavailable' };
        }
        return result;
      },
    };
    await render(view(uncertain, { transport }));
    await open(uncertain);
    await toggle(host, uncertain.candidate.id);
    await select(rank(host, uncertain.candidate.id), 'preferred');
    await confirm(host, m.candidate_adopt());
    await until(() => buttons(host, m.candidate_retry()).length === 1);
    const frozen = structuredClone(commands[0]!);
    expect(Object.isFrozen(commands[0])).toBe(true);
    expect(Object.isFrozen(commands[0]!.selection)).toBe(true);
    expect(frozen).toMatchObject({
      head: 1,
      session: 'candidate-session',
      operation: 'adopt',
      expectedReader: transport.reader,
    });
    expect(button(host, m.candidate_cancel()).disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('#candidate-field')!.disabled).toBe(true);
    await click(host, m.candidate_retry());
    await until(() => host.textContent!.includes(m.candidate_selection_confirmed()));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(commands[1]).toEqual(frozen);
    expect(posts(uncertain)[1]).toEqual(posts(uncertain)[0]);
    expect(uncertain.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(1);

    // The supplied exact relation slot travels in the immutable command as well.
    // This acceptance replay complements the whole-selection adoption replay above.
    await render(null);
    const relation = relationFixture();
    const relationCommands: CandidateCommand[] = [];
    let lostSlot = true;
    const relationTransport: CandidateTransport = {
      reader: uncertain.transport.reader!,
      read: (_property, cursor, session) =>
        readRelationEditor(
          relation.client,
          'Bearer fixture',
          relationDescriptorReader(relation.release),
          relation.id,
          'en',
          relation.slot,
          cursor,
          session,
        ),
      confirm: async (command) => {
        relationCommands.push(command);
        const result = await selectCandidate(relation.client, 'Bearer fixture', command);
        if (lostSlot) {
          lostSlot = false;
          return { ok: false, reason: 'unavailable' };
        }
        return result;
      },
    };
    await render(
      <CandidateReview
        id={relation.id}
        locale="en"
        transport={relationTransport}
        initialProperty={relation.slot.property}
        exactCandidate={relation.candidate.id}
        slot={relation.slot}
      />,
    );
    await until(() => buttons(host, m.candidate_accept()).length > 0);
    await confirm(host, m.candidate_accept());
    await until(() => buttons(host, m.candidate_retry()).length === 1);
    const oldSlot = structuredClone(relationCommands[0]!);
    expect(oldSlot).toMatchObject({
      candidate: relation.candidate.id,
      head: null,
      session: 'relation-session',
      slot: { target: relation.slot.target, key: relation.slot.key },
    });
    expect(Object.isFrozen(relationCommands[0]!.slot)).toBe(true);
    await click(host, m.candidate_retry());
    await until(() => host.textContent!.includes(m.candidate_accepted()));
    expect(relationCommands[1]).toBe(relationCommands[0]);
    expect(relationCommands[1]).toEqual(oldSlot);
    const slotWrites = relation.calls.filter((call) => call.method === 'POST');
    expect(slotWrites).toHaveLength(2);
    expect(slotWrites[1]).toEqual(slotWrites[0]);

    // A committed result with no current public read is honestly unconfirmed; a
    // failed Context refresh stays separately committed, and withdraws stale comparison.
    for (const kind of ['public', 'context'] as const) {
      await render(null);
      const context = contextFixture();
      const base = kind === 'context' ? context : candidateFixture();
      const transport: CandidateTransport = {
        ...base.transport,
        confirm: async (command, work) => {
          const result = await base.transport.confirm(command, work);
          if (!result.ok) return result;
          const committed = { ...result, public: null };
          if (kind === 'context') {
            delete committed.contextReview;
            committed.contextRefreshFailed = true;
          }
          return committed;
        },
      };
      await render(
        <CandidateReview
          id={base.id}
          locale="en"
          initialProperty={base.property}
          transport={transport}
          {...(kind === 'context' ? { context: context.context.id } : {})}
        />,
      );
      await click(host, m.candidate_entry());
      await until(() => buttons(host, m.candidate_review()).length > 0);
      await click(host, m.candidate_review());
      await confirm(host, m.candidate_reject());
      await until(() =>
        host.textContent!.includes(
          kind === 'context' ? m.context_read_unavailable() : m.candidate_public_unconfirmed(),
        ),
      );
      expect(host.querySelector('a[href*="/subjects/"]')).toBeNull();
      if (kind === 'context') expect(host.querySelector('[data-candidate-panel]')).toBeNull();
    }

    // Retired real-component reads and writes cannot revive private content, focus,
    // or queued actions. A new reader can open its own independent fixture immediately.
    for (const operation of ['read', 'confirm'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        await render(null);
        const retired = candidateFixture();
        let resolve!: (result: CandidateRead | CandidateResult) => void;
        let reject!: (error: Error) => void;
        const held = new Promise<CandidateRead | CandidateResult>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        let entered = false;
        let result!: CandidateRead | CandidateResult;
        let dispatched = 0;
        const heldTransport: CandidateTransport = {
          ...retired.transport,
          read: async (...args) => {
            const read = await retired.transport.read(...args);
            if (operation !== 'read' || !args[0]) return read;
            result = read;
            entered = true;
            return held as Promise<CandidateRead>;
          },
          confirm: async (...args) => {
            dispatched++;
            const confirmed = await retired.transport.confirm(...args);
            if (operation !== 'confirm') return confirmed;
            result = confirmed;
            entered = true;
            return held as Promise<CandidateResult>;
          },
        };
        const boundary = (subject: string, transport = heldTransport) => (
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }}
            address="candidate-family"
          >
            <CandidateReview id={retired.id} locale="en" transport={transport} />
          </CandidateReaderBoundary>
        );
        await render(boundary('original-reader'));
        await click(host, m.candidate_entry());
        await until(() => !!host.querySelector('#candidate-field'));
        await select(host.querySelector<HTMLSelectElement>('#candidate-field')!, retired.property);
        if (operation === 'confirm') {
          await until(() => buttons(host, m.candidate_review()).length > 0);
          await compare();
          await confirm(host, m.candidate_accept());
        }
        await until(() => entered);
        const queuedButton = button(host, operation === 'read' ? m.candidate_close() : m.candidate_accept());
        const key = Object.keys(queuedButton).find((key) => key.startsWith('__reactProps$'))!;
        const callback = Reflect.get(queuedButton, key).onClick as (event: {
          currentTarget: HTMLButtonElement;
        }) => void;
        const fresh = candidateFixture();
        await render(boundary('replacement-reader', fresh.transport));
        outside.focus();
        const before = host.textContent;
        const calls = retired.calls.length;
        await act(async () => callback({ currentTarget: queuedButton }));
        await act(async () => {
          if (delivery === 'throw') reject(new Error('Late unavailable delivery'));
          else resolve(delivery === 'failure' ? { ok: false, reason: 'unavailable' } : result);
        });
        await settle();
        expect(host.textContent).toBe(before);
        expect(window.document.activeElement).toBe(outside);
        expect(retired.calls).toHaveLength(calls);
        expect(dispatched).toBe(operation === 'confirm' ? 1 : 0);
        expect(host.querySelector('#candidate-field, [id^="include-"]')).toBeNull();
        await open(fresh);
        expect(host.querySelector('[data-candidate-item]')).not.toBeNull();
      }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    overwriteGetLocale(originalLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}, 60_000);
