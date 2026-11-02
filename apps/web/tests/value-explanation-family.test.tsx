import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';
import type { ValuePage, ValueRead } from '../src/features/catalogue/value-explanation';

mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN. DOM assertions are semantic/source witnesses, never physical phone-layout proof.
test('selected-value evidence has independent family sections, complete supplied readings and unchanged manual controls', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  }
  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ConnectedStory } = await import('../src/stories/connected-story');
  const { ValueExplanation, ValueExplanationPage } = await import('../src/features/catalogue/value-explanation-page');
  const { valueExplanationFixture, valueCursor, valueLastCursor } =
    await import('../src/kernel/fake/value-explanation');
  const { candidateContext } = await import('../src/subject/candidates');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const container = window.document.createElement('main') as HTMLElement;
  window.document.body.append(container);
  const focusSentinel = window.document.createElement('button');
  window.document.body.append(focusSentinel);
  const root = createRoot(container);
  const render = async (children: ReactNode) => {
    await act(async () => root.render(h(ConnectedStory, { storyId: 'value-evidence-family' }, children)));
  };
  const text = (region: Element) => {
    const copy = region.cloneNode(true) as Element;
    for (const details of copy.querySelectorAll('details')) details.remove();
    return copy.textContent ?? '';
  };
  const button = (region: Element, name: string) => {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const section = (region: Element, name: string) => {
    const heading = [...region.querySelectorAll('h2')].find((node) => node.textContent === name)!;
    expect(heading).toBeDefined();
    const own = [...region.querySelectorAll('section')].find(
      (node) => node.getAttribute('aria-labelledby') === heading.id,
    )!;
    expect(own).toBeDefined();
    expect(own.contains(heading)).toBe(true);
    expect(window.document.getElementById(heading.id)).toBe(heading);
    return own;
  };
  const privateAbsent = () => {
    for (const bytes of ['UNSELECTED PRIVATE ALTERNATIVE', 'PRIVATE SOURCE', 'PRIVATE RECORD']) {
      expect(container.textContent).not.toContain(bytes);
      expect(container.innerHTML).not.toContain(bytes);
    }
  };
  try {
    const fixture = valueExplanationFixture('paged');
    const supplied = await fixture.transport();
    if (supplied.kind !== 'ready' || !supplied.page.statement) throw new Error('Expected selected evidence');
    const initialCalls = fixture.calls.length;
    const title = '旅人の物語 — 読み継がれる長い名前と記録 '.repeat(6);
    const value = '選ばれた値 Édition originale العربية 한국어 '.repeat(8) + 'LongUnbrokenValue'.repeat(24);
    const qualifier = '補足された意味と原文のままの条件 '.repeat(12);
    const reference = '出典の全文 Référence complète العربية '.repeat(12);
    const url = `https://catalogue.example.test/${'long-reference'.repeat(25)}?source=exact%2Bvalue#original`;
    const labels = ['選ばれた書誌の値 — 第一の説明', '別の書誌の値 — 第二の説明'] as const;
    const page: ValuePage = {
      ...supplied.page,
      title: { text: title, lang: 'ja' },
      typeLabel: { text: '書籍とその書誌情報', lang: 'ja' },
      propertyLabel: { text: labels[0]!, lang: 'ja' },
      labels: { ...supplied.page.labels, 'example:reference': { text: '出典の説明', lang: 'ja' } },
      statement: {
        ...supplied.page.statement,
        property: { ...supplied.page.statement.property, data_type: 'monolingualtext' },
        value: { type: 'value', content: { text: value, language: 'ja' } },
        qualifiers: [
          ...supplied.page.statement.qualifiers,
          { property: { id: 'example:qualifier', data_type: 'string' }, value: { type: 'value', content: qualifier } },
        ],
        references: [
          ...supplied.page.statement.references,
          {
            hash: 'fixture-only-long-reference',
            parts: [
              {
                property: { id: 'example:reference', data_type: 'monolingualtext' },
                value: { type: 'value', content: { text: reference, language: 'fr' } },
              },
              { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: url } },
              {
                property: { id: 'schema:url', data_type: 'url' },
                value: { type: 'value', content: 'javascript:literal-unlinked-reference' },
              },
            ],
          },
          { hash: 'fixture-only-empty-reference', parts: [] },
        ],
      },
    };
    const original = structuredClone(page);
    const more: string[][] = [[], []];
    const reload = [0, 0];
    const pair = (busy = false, loading = false) =>
      labels.map((label, index) =>
        h(ValueExplanationPage, {
          key: label,
          result: loading ? undefined : { ...supplied, page: { ...page, propertyLabel: { text: label, lang: 'ja' } } },
          locale: 'en',
          busy: index === 0 && busy,
          onMore: (cursor: string) => more[index]!.push(cursor),
          onReload: () => {
            reload[index]!++;
          },
        }),
      );
    await render(pair());
    const articles = [...container.querySelectorAll<HTMLElement>('article[data-slot="value-explanation"]')];
    expect(articles).toHaveLength(2);
    const ids = articles.flatMap((article) => [...article.querySelectorAll('h2')].map((heading) => heading.id));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    for (const [index, article] of articles.entries()) {
      const selected = section(article, labels[index]!);
      const citations = section(article, m.sources_citations());
      const decision = section(article, m.value_decision());
      const change = section(article, m.value_change());
      const technical = article.querySelector<HTMLDetailsElement>('details')!;
      const ordered = [selected, citations, decision, change, technical];
      for (let at = 1; at < ordered.length; at++) {
        expect(
          ordered[at - 1]!.compareDocumentPosition(ordered[at]!) & window.Node.DOCUMENT_POSITION_FOLLOWING,
        ).not.toBe(0);
      }
      expect(selected.querySelector('h2')?.getAttribute('lang')).toBe('ja');
      expect(selected.querySelector('h2')?.getAttribute('data-content-item-slot')).toBe('title');
      // Installed ContentItemFrame surface, rather than a second card primitive or all-clickable citation.
      expect(selected.querySelector('.group.relative.isolate')).not.toBeNull();
      expect(decision.querySelector('.group.relative.isolate')).not.toBeNull();
      expect(citations.querySelectorAll('ol > li')).toHaveLength(page.statement!.references.length);
      expect(citations.querySelectorAll('ol > li > .group.relative.isolate')).toHaveLength(
        page.statement!.references.length,
      );
      expect(selected.querySelector('dl dt')?.textContent).toBe(m.value_qualifiers());
      expect(selected.querySelector('dl dd')?.textContent).toContain(qualifier);
      expect(decision.querySelectorAll('dl dt')).toHaveLength(2);
      expect(text(article)).toContain(title);
      expect(text(article)).toContain(value);
      expect(text(article)).toContain(reference);
      expect(article.querySelector('[lang="fr"]')?.textContent).toBe('Édition originale');
      expect([...citations.querySelectorAll('[lang="fr"]')].some((node) => node.textContent === reference)).toBe(true);
      const lastReference = citations.querySelectorAll('ol > li')[page.statement!.references.length - 2]!;
      const parts = [...lastReference.querySelectorAll(':scope > div > div')];
      expect(parts).toHaveLength(3);
      expect(parts[0]!.textContent).toContain(reference);
      expect(parts[1]!.textContent).toContain(url);
      expect(parts[2]!.textContent).toContain('javascript:literal-unlinked-reference');
      expect(citations.querySelector('a')?.getAttribute('href')).toBe('https://catalogue.example.test/books/prince');
      expect([...citations.querySelectorAll('a')].some((link) => link.getAttribute('href') === url)).toBe(true);
      expect(citations.textContent).toContain('javascript:literal-unlinked-reference');
      expect(citations.querySelector('a[href^="javascript:"]')).toBeNull();
      expect(citations.textContent).toContain(m.value_reference_unavailable());
      expect(text(decision)).toContain(m.value_not_returned());
      expect(text(decision)).toContain(m.value_page_bound());
      expect(text(decision)).not.toContain(m.candidate_rejected_state());
      expect(technical.open).toBe(false);
      for (const bytes of [
        page.id,
        page.context,
        page.statement!.id,
        page.statement!.property.id,
        page.statement!.rezics.release,
      ]) {
        expect(technical.textContent).toContain(bytes);
        expect(text(article)).not.toContain(bytes);
      }
      expect(technical.textContent).toContain(m.changes_revision({ revision: '2' }));
      for (const control of article.querySelectorAll<HTMLElement>('a,button,summary')) {
        control.focus();
        expect(window.document.activeElement).toBe(control);
      }
      expect(article.querySelector('a button, a summary, a a')).toBeNull();
      expect(article.className).toContain('[overflow-wrap:anywhere]');
      expect(
        article.querySelector('[class*="line-clamp"], [class*="truncate"], [class*="overflow-hidden"]'),
      ).toBeNull();
    }
    const firstDetails = articles[0]!.querySelector<HTMLDetailsElement>('details')!;
    await act(async () => firstDetails.querySelector('summary')!.click());
    expect(firstDetails.open).toBe(true);
    expect(articles[1]!.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    await act(async () => button(articles[0]!, m.value_more()).click());
    await act(async () => button(articles[1]!, m.candidate_reload()).click());
    expect(more).toEqual([[valueCursor], []]);
    expect(reload).toEqual([0, 1]);
    await render(pair(true));
    expect(articles[0]!.getAttribute('aria-busy')).toBe('true');
    expect(button(articles[0]!, m.value_more()).disabled).toBe(true);
    expect(button(articles[0]!, m.candidate_reload()).disabled).toBe(true);
    expect(button(articles[1]!, m.value_more()).disabled).toBe(false);
    await act(async () => button(articles[0]!, m.value_more()).click());
    await act(async () => button(articles[0]!, m.candidate_reload()).click());
    expect(more).toEqual([[valueCursor], []]);
    expect(reload).toEqual([0, 1]);
    expect(articles.flatMap((article) => [...article.querySelectorAll('h2')].map((heading) => heading.id))).toEqual(
      ids,
    );
    expect(firstDetails.open).toBe(true);
    await render(pair(true, true));
    expect(container.querySelector('h2')).toBeNull();
    await render(pair());
    expect([...container.querySelectorAll('h2')].map((heading) => heading.id)).toEqual(ids);
    expect(page).toEqual(original);
    expect(fixture.calls).toHaveLength(initialCalls);
    privateAbsent();

    const show = async (next: ValueRead | undefined, callbacks = false) => {
      await render(
        h(ValueExplanationPage, {
          result: next,
          locale: 'en',
          ...(callbacks
            ? {
                onMore: (cursor: string) => more[0]!.push(cursor),
                onReload: () => {
                  reload[0]!++;
                },
              }
            : {}),
        }),
      );
      privateAbsent();
    };
    for (const [decision, message] of [
      ['accepted', m.value_accepted()],
      ['rejected', m.candidate_rejected_state()],
      [null, m.candidate_unresolved()],
    ] as const) {
      for (const [adoption, adoptionMessage] of [
        ['inherit', m.context_inherited()],
        ['replace', m.context_replaced()],
        ['suppress', m.context_suppressed()],
        [null, m.value_adoption_unavailable()],
      ] as const) {
        await show({
          ...supplied,
          page: {
            ...page,
            competition: { kind: 'returned', decision, adoption, revision: 7, release: 'exact-decision-release' },
          },
        });
        const decisionSection = section(container, m.value_decision());
        expect(text(decisionSection)).toContain(message);
        expect(text(decisionSection)).toContain(adoptionMessage);
        expect(text(decisionSection)).toContain(m.context_global());
        expect(text(decisionSection)).toContain(m.candidate_rank_preferred());
        expect(container.querySelector('details')?.textContent).toContain(
          m.value_candidate_revision({ revision: '7' }),
        );
        expect(container.querySelector('details')?.textContent).toContain('exact-decision-release');
        expect(text(container)).not.toContain('exact-decision-release');
        expect([...container.querySelectorAll('button')].some((node) => node.textContent === m.value_more())).toBe(
          false,
        );
      }
    }
    for (const [kind, message] of [
      ['denied', m.value_metadata_denied()],
      ['missing', m.value_metadata_unavailable()],
      ['invalid', m.value_metadata_unavailable()],
      ['unavailable', m.value_metadata_unavailable()],
    ] as const) {
      await show({ ...supplied, page: { ...page, competition: { kind } } }, true);
      const decision = section(container, m.value_decision());
      expect(text(decision)).toContain(message);
      expect(text(decision)).not.toContain(m.value_not_returned());
      expect(text(container)).toContain(value);
      expect(button(container, m.candidate_reload()).disabled).toBe(false);
      expect(decision.querySelector('button')).toBeNull();
    }
    await show(
      {
        ...supplied,
        page: {
          ...page,
          context: '00000000-0000-8000-8000-000000000099',
          statement: { ...page.statement!, rank: 'normal' },
          competition: { kind: 'not-returned', next: null },
        },
      },
      true,
    );
    expect(text(section(container, m.value_decision()))).toContain(m.value_page_bound());
    expect(text(section(container, m.value_decision()))).toContain(m.context_unnamed());
    expect(text(section(container, m.value_decision()))).toContain(m.candidate_rank_normal());
    expect(section(container, m.value_decision()).querySelector('button')).toBeNull();
    const { competition: _competition, ...noCompetition } = page;
    await show({ ...supplied, page: noCompetition });
    expect(text(section(container, m.value_decision()))).toContain(m.value_metadata_unavailable());
    await show(supplied); // No callback means no continuation control, even with a non-null cursor.
    expect(container.querySelector('button')).toBeNull();
    for (const [absence, message] of [
      [undefined, m.value_not_selected()],
      ['not-selected', m.value_not_selected()],
      ['unresolved', m.context_unresolved()],
      ['suppressed', m.context_suppressed()],
      ['withheld', m.value_withheld()],
    ] as const) {
      const { statement: _statement, absence: _absence, ...without } = page;
      await show({ kind: 'ready', page: { ...without, ...(absence ? { absence } : {}) } });
      expect(container.querySelector('[role="status"]')?.textContent).toBe(message);
      expect(text(container)).not.toContain(value);
      expect(container.querySelector('h2')).toBeNull();
      expect(container.querySelector('details')?.textContent).toContain(candidateContext);
    }
    for (const [kind, message] of [
      ['denied', m.value_denied()],
      ['missing', m.value_missing()],
      ['invalid', m.value_invalid()],
      ['unavailable', m.value_error()],
    ] as const) {
      await show({ kind }, true);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
      expect(container.querySelector('details,section,nav')).toBeNull();
      expect(text(container)).not.toContain(value);
    }
    await show(undefined);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(m.candidate_loading());
    for (const [type, message] of [
      ['somevalue', m.subject_value_unknown()],
      ['novalue', m.subject_value_none()],
    ] as const) {
      await show({
        ...supplied,
        page: { ...page, statement: { ...page.statement!, value: { type }, qualifiers: [], references: [] } },
      });
      expect(text(section(container, labels[0]!))).toContain(message);
      expect(text(section(container, m.sources_citations()))).toContain(m.sources_no_citations());
      expect(section(container, m.sources_citations()).querySelector('ol')).toBeNull();
    }
    await show({
      ...supplied,
      page: {
        ...page,
        propertyLabel: { text: '', lang: 'fr' },
        title: { text: '', lang: 'fr' },
        typeLabel: { text: '' },
        change: { kind: 'denied' },
      },
    });
    expect(section(container, m.subject_value_unlabelled()).querySelector('h2')?.getAttribute('lang')).toBe('fr');
    expect(text(section(container, m.value_change()))).toBe(m.value_change() + m.value_metadata_denied());
    await show({
      ...supplied,
      page: {
        ...page,
        change: {
          kind: 'ready',
          detail: {
            id: page.id,
            revision: 2,
            summary: { kind: 'candidate', candidate: page.statement!.id, property: page.statement!.property.id },
          },
        },
      },
    });
    expect(text(section(container, m.value_change()))).toContain(m.changes_proposal_detail());
    const document = valueExplanationFixture('document');
    await show(await document.transport());
    expect(text(container)).toContain(m.candidate_value_unavailable());
    document.inlineDocument();
    await show(await document.transport());
    expect(text(container)).toContain('Authorized original words');
    expect(document.calls.some((call) => call.path.includes('/documents/'))).toBe(false);

    // Exercise the unchanged actual loader: no automatic continuation or request on disclosure/focus.
    const native = valueExplanationFixture('paged');
    const first = await native.transport();
    const calls: { cursor?: string; session?: string }[] = [];
    let release: (() => void) | undefined;
    const transport = async (cursor?: string, session?: string): Promise<ValueRead> => {
      calls.push({ ...(cursor !== undefined ? { cursor } : {}), ...(session !== undefined ? { session } : {}) });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return native.transport(cursor, session);
    };
    await render(h(ValueExplanation, { locale: 'en', transport, initial: first }));
    expect(calls).toHaveLength(0);
    expect(window.document.activeElement).not.toBe(container.querySelector('h1'));
    const complete = async () => {
      await act(async () => {
        release!();
      });
    };
    for (const cursor of [valueCursor, valueLastCursor]) {
      const more = button(container, m.value_more());
      more.focus();
      await act(async () => more.click());
      expect(calls.at(-1)).toEqual({ cursor, session: 'value-session' });
      expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
      expect(text(container)).not.toContain('9780156012195');
      expect(button(container, m.value_restart()).disabled).toBe(true);
      await act(async () => button(container, m.value_restart()).click());
      expect(calls).toHaveLength(cursor === valueCursor ? 1 : 2);
      await complete();
      expect(window.document.activeElement).toBe(container.querySelector('h1'));
      expect((container.querySelector('h1') as HTMLHeadingElement).tabIndex).toBe(-1);
      privateAbsent();
    }
    expect(text(container)).toContain(m.value_accepted());
    expect(container.querySelectorAll('button')).toHaveLength(1);
    await act(async () => button(container, m.value_restart()).click());
    expect(calls.at(-1)).toEqual({ session: 'value-session' });
    await complete();
    expect(text(container)).toContain(m.value_page_bound());
    expect(native.calls.filter((call) => call.path.endsWith('/candidates'))).toHaveLength(4);
    expect(native.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(native.calls.filter((call) => call.path.endsWith('/candidates')).map((call) => call.cursor)).toEqual([
      null,
      valueCursor,
      valueLastCursor,
      null,
    ]);
    expect(
      native.calls
        .filter((call) => call.path.endsWith('/candidates'))
        .every((call) => new URLSearchParams(call.query).get('limit') === '20'),
    ).toBe(true);
    privateAbsent();
    // Recover the failed continuation, including a refreshed producer session, without traversing again.
    const requests: { cursor: string | undefined; session: string | undefined }[] = [];
    const pending: ((result: ValueRead) => void)[] = [];
    const recover = (cursor?: string, session?: string) => {
      requests.push({ cursor, session });
      return new Promise<ValueRead>((resolve) => pending.push(resolve));
    };
    const resolve = async (result: ValueRead) => act(async () => pending.shift()!(result));
    await render(h(ValueExplanation, { locale: 'en', transport: recover, initial: { ...first } }));
    await act(async () => button(container, m.value_more()).click());
    await resolve(await native.transport(valueCursor, 'value-session'));
    const finalMore = button(container, m.value_more());
    finalMore.focus();
    await act(async () => finalMore.click());
    expect(text(container)).not.toContain('9780156012195');
    await resolve({ kind: 'unavailable' });
    expect(window.document.activeElement).toBe(container.querySelector('h1'));
    expect(container.querySelector('details,section,nav')).toBeNull();
    expect(requests).toHaveLength(2);
    const retry = button(container, m.value_retry());
    retry.focus();
    await act(async () => retry.click());
    expect(requests.at(-1)).toEqual({ cursor: valueLastCursor, session: 'value-session' });
    expect(button(container, m.value_restart()).disabled).toBe(true);
    if (first.kind !== 'ready') throw new Error('Expected first page');
    await resolve({
      ...first,
      session: 'refreshed-session',
      page: {
        ...first.page,
        competition: { kind: 'unavailable' },
      },
    });
    expect(window.document.activeElement).toBe(container.querySelector('h1'));
    const retryAgain = button(container, m.value_retry());
    retryAgain.focus();
    await act(async () => retryAgain.click());
    expect(requests.at(-1)).toEqual({ cursor: valueLastCursor, session: 'refreshed-session' });
    await resolve(await native.transport(valueLastCursor, 'refreshed-session'));
    expect(window.document.activeElement).toBe(container.querySelector('h1'));
    expect(text(container)).toContain(m.value_accepted());
    expect(requests.map(({ cursor }) => cursor)).toEqual([
      valueCursor,
      valueLastCursor,
      valueLastCursor,
      valueLastCursor,
    ]);
    expect([...container.querySelectorAll('button')].some((node) => node.textContent === m.value_retry())).toBe(false);
    await act(async () => button(container, m.value_restart()).click());
    expect(requests.at(-1)).toEqual({ cursor: undefined, session: 'value-session' });
    await resolve({ kind: 'denied' });
    expect(container.querySelector('details,section,nav')).toBeNull();
    await act(async () => button(container, m.candidate_reload()).click());
    expect(requests.at(-1)).toEqual({ cursor: undefined, session: undefined });
    await resolve({ kind: 'unavailable' });
    await act(async () => button(container, m.value_retry()).click());
    expect(requests.at(-1)).toEqual({ cursor: undefined, session: undefined });
    await resolve(first);

    // Transport, locale, visit and supplied-reading replacement retire outstanding reads and recovery.
    for (const changed of ['transport', 'locale', 'episode', 'initial'] as const) {
      const seed = { ...first };
      await render(h(ValueExplanation, { locale: 'en', transport: recover, initial: seed }));
      await act(async () => button(container, m.value_more()).click());
      await render(
        h(ValueExplanation, {
          locale: changed === 'locale' ? 'fr' : 'en',
          transport: changed === 'transport' ? (cursor, session) => recover(cursor, session) : recover,
          initial: changed === 'initial' ? { kind: 'denied' } : seed,
          ...(changed === 'episode' ? { episode: 'refreshed-visit' } : {}),
        }),
      );
      const current = container.innerHTML;
      expect(text(container)).not.toContain('9780156012195');
      focusSentinel.focus();
      await resolve(await native.transport(valueLastCursor, 'value-session'));
      expect(container.innerHTML).toBe(current);
      expect(window.document.activeElement).toBe(focusSentinel);
      expect([...container.querySelectorAll('button')].some((node) => node.textContent === m.value_retry())).toBe(
        false,
      );
      if (changed !== 'initial') {
        expect(requests.at(-1)).toEqual({ cursor: undefined, session: undefined });
        await resolve({ kind: 'denied' });
        expect(window.document.activeElement).toBe(focusSentinel);
      }
      expect(container.querySelector('details,section,nav')).toBeNull();
    }
    // Even a read started without an initial result is fenced when its transport changes.
    await render(h(ValueExplanation, { locale: 'en', transport: recover }));
    const replacement = (cursor?: string, session?: string) => recover(cursor, session);
    await render(h(ValueExplanation, { locale: 'en', transport: replacement }));
    expect(requests.at(-1)).toEqual({ cursor: undefined, session: undefined });
    focusSentinel.focus();
    await resolve(first);
    expect(text(container)).not.toContain('9780156012195');
    expect(window.document.activeElement).toBe(focusSentinel);
    await resolve({ kind: 'denied' });
    expect(window.document.activeElement).toBe(focusSentinel);
    expect(container.querySelector('details,section,nav')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    focusSentinel.remove();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
