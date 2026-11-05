import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { ReactNode } from 'react';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('A contributor reads the selected value and composition evidence before technical identities', async () => {
  const require = createRequire(import.meta.url);
  const domPath = createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom');
  const { Window } = await import(domPath);
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    const value = key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ConnectedStory } = await import('../src/stories/connected-story');
  const { ValueExplanationPage } = await import('../src/features/catalogue/value-explanation-page');
  const { WorkPartsPage } = await import('../src/features/catalogue/work-parts-page');
  const { valueExplanationFixture, valueCursor, valueLastCursor } =
    await import('../src/kernel/fake/value-explanation');
  const { workPartsFixture, workPartId } = await import('../src/kernel/fake/work-parts');
  const { partCorrection } = await import('../src/features/catalogue/work-parts');
  const { relationDraft } = await import('../src/subject/relation-candidates');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const container = window.document.createElement('main') as HTMLElement;
  window.document.body.append(container);
  window.document.documentElement.lang = 'en';
  window.document.documentElement.classList.add('light');
  setLocale('en', { reload: false });
  const root = createRoot(container);
  const button = (region: Element, name: string) => {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const mainText = (region: Element) => {
    const copy = region.cloneNode(true) as Element;
    for (const details of copy.querySelectorAll('details')) details.remove();
    return copy.textContent;
  };
  const precedes = (evidence: Element, details: Element) =>
    expect(evidence.compareDocumentPosition(details) & window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  const detailsFor = (region: Element, bytes: string) => {
    const details = [...region.querySelectorAll<HTMLDetailsElement>('details')].find((item) =>
      item.textContent?.includes(bytes),
    );
    expect(details).toBeDefined();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe(m.catalogue_technical_details());
    expect(mainText(region)).not.toContain(bytes);
    return details!;
  };
  const render = async (id: string, page: ReactNode) => {
    await act(async () => root.render(h(ConnectedStory, { key: id, storyId: id }, page)));
  };
  try {
    const value = valueExplanationFixture();
    const result = await value.transport();
    if (result.kind !== 'ready') throw new Error('Expected the current selected value');
    await render('pages-catalogue-why-this-value--selected', h(ValueExplanationPage, { result, locale: 'en' }));
    const technical = detailsFor(container, value.selected.rezics.release);
    const selected = [...container.querySelectorAll('h2')].find(
      (heading) => heading.textContent === result.page.propertyLabel.text,
    )!;
    const citations = container.querySelector(
      `section[aria-labelledby="${[...container.querySelectorAll('h2')].find((heading) => heading.textContent === m.sources_citations())!.id}"]`,
    )!;
    precedes(selected, citations);
    precedes(
      citations,
      [...container.querySelectorAll('h2')].find((heading) => heading.textContent === m.value_decision())!,
    );
    precedes(citations, technical);
    expect(mainText(container)).toContain('9780156012195');
    expect(mainText(container)).toContain('Édition originale');
    expect(container.querySelector('[lang="fr"]')?.textContent).toContain('Édition originale');
    expect(citations.querySelector('a')?.href).toBe('https://catalogue.example.test/books/prince');
    for (const bytes of [value.selected.id, value.id, result.page.context, value.property]) {
      expect(technical.textContent).toContain(bytes);
    }
    expect(technical.textContent).toContain(m.changes_revision({ revision: '2' }));
    expect(technical.textContent).toContain(m.value_candidate_revision({ revision: '2' }));
    expect(mainText(container)).toContain(m.value_accepted());
    expect(mainText(container)).toContain(m.context_global());
    expect(mainText(container)).toContain(m.context_replaced());
    const hrefs = [...container.querySelectorAll<HTMLAnchorElement>('nav a')].map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      result.page.href,
      `${result.page.href}/sources`,
      `${result.page.href}/changes`,
      result.page.reviewHref,
    ]);
    expect(container.textContent).not.toContain('UNSELECTED PRIVATE ALTERNATIVE');
    expect(container.textContent).not.toContain('PRIVATE SOURCE');
    // A closed disclosure retains the exact bytes and can be opened without another request.
    technical.open = true;
    expect(technical.textContent).toContain(value.selected.rezics.release);
    expect(value.calls.every((call) => call.method === 'GET')).toBe(true);

    const paged = valueExplanationFixture('paged');
    let current = await paged.transport();
    for (const cursor of [valueCursor, valueLastCursor]) {
      let requested: string | undefined;
      await render(
        'pages-catalogue-why-this-value--continue-review',
        h(ValueExplanationPage, {
          result: current,
          locale: 'en',
          onMore: (next) => {
            requested = next;
          },
        }),
      );
      expect(mainText(container)).toContain(m.value_not_returned());
      expect(mainText(container)).toContain('9780156012195');
      await act(async () => button(container, m.value_more()).click());
      expect(requested).toBe(cursor);
      current = await paged.transport(requested, current.kind === 'ready' ? current.session : undefined);
      expect(paged.calls.at(-1)).toMatchObject({ cursor, session: 'value-session' });
    }
    expect(current.kind === 'ready' && current.page.competition?.kind).toBe('returned');
    for (const [scenario, message] of [
      ['review-denied', m.value_metadata_denied()],
      ['review-error', m.value_metadata_unavailable()],
      ['not-selected', m.value_not_selected()],
      ['concealed', m.value_missing()],
      ['error', m.value_error()],
    ] as const) {
      const fixture = valueExplanationFixture(scenario);
      await render(
        'pages-catalogue-why-this-value--selected',
        h(ValueExplanationPage, { result: await fixture.transport(), locale: 'en' }),
      );
      expect(mainText(container)).toContain(message);
      expect(mainText(container)).not.toContain('UNSELECTED PRIVATE ALTERNATIVE');
    }

    const parts = workPartsFixture('partial');
    const read = await parts.transport.read();
    if (!read.ok || !read.stream) throw new Error('Expected the current part slice');
    const original = structuredClone(read.rows[0]!.statement!);
    expect(read.stream.direction).toBe('inverse');
    expect(read.count).toEqual({ value: 2, exact: false });
    expect(read.labels['schema:position']?.text).toBe(parts.release.properties['schema:position']!.labels.en!);
    expect(parts.calls).toHaveLength(2);
    expect(parts.calls.every((call) => call.authorization === 'Bearer contributor')).toBe(true);
    await render(
      'patterns-catalogue-work-parts--current',
      h(WorkPartsPage, {
        id: parts.id,
        locale: 'en',
        transport: parts.transport,
        search: parts.search,
        initial: read,
      }),
    );
    const row = container.querySelector('li')!;
    expect(mainText(container)).toContain('The Traveller');
    expect(mainText(row)).toContain('Volume Two');
    expect(mainText(row)).toContain(parts.release.properties[parts.property]!.labels.en!);
    expect(mainText(row)).toContain(parts.release.properties['schema:position']!.labels.en!);
    expect(mainText(row)).toContain('2');
    expect(mainText(row)).not.toContain('1');
    expect(mainText(container)).toContain(m.work_parts_count({ accuracy: m.work_parts_at_least(), count: 2 }));
    const rowDetails = detailsFor(row, original.id);
    expect(rowDetails.textContent).toContain(workPartId);
    expect(rowDetails.textContent).toContain(parts.property);
    expect(JSON.parse(rowDetails.querySelector('pre')!.textContent!)).toEqual(original);
    precedes(row.querySelector('a')!, rowDetails);
    precedes(row.querySelector(`section[aria-label="${m.sources_citations()}"]`)!, rowDetails);
    expect(row.querySelector<HTMLAnchorElement>('a[href="https://example.org/contents"]')).not.toBeNull();
    for (const bytes of [parts.id, parts.anchor.subject.type, parts.property, 'schema:position']) {
      detailsFor(container, bytes);
    }
    expect(partCorrection(read.rows[0]!, read.stream)).toEqual({
      id: workPartId,
      statement: relationDraft(original),
      slot: { property: parts.property, target: parts.id },
      positionEditable: true,
    });
    await act(async () => button(row, m.work_parts_correct()).click());
    await act(async () => button(container, m.relation_open()).click());
    const positionLabel = [...container.querySelectorAll<HTMLLabelElement>('label')].find(
      (label) => label.textContent === parts.release.properties['schema:position']!.labels.en,
    )!;
    const position = container.querySelector<HTMLInputElement>(`[id="${positionLabel.htmlFor}"]`)!;
    expect(position.value).toBe('2');
    expect(position.closest('fieldset')?.disabled).toBe(false);
    expect(container.querySelectorAll('a[href="https://example.org/contents"]').length).toBeGreaterThan(1);
    const comparison = parts.calls.find((call) => call.path.endsWith('/candidates'))!;
    expect(comparison).toMatchObject({
      query: { property: parts.property, target: parts.id, context: parts.anchor.subject.context },
      session: 'parts-session',
      authorization: 'Bearer contributor',
    });
    await act(async () => button(container, m.relation_propose()).click());
    const confirmation = [...container.querySelectorAll('[role="group"]')].find(
      (node) => node.getAttribute('aria-label') === m.candidate_confirm_title({ action: m.relation_propose() }),
    )!;
    await act(async () => button(confirmation, m.relation_propose()).click());
    const post = parts.calls.find((call) => call.method === 'POST')!;
    const input = (snak: typeof original) => ({ property: { id: snak.property.id }, value: snak.value });
    expect(post.path).toBe(`/v1/subjects/${workPartId}/candidates`);
    expect(post.authorization).toBe('Bearer contributor');
    expect(post.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toEqual({
      statement: {
        ...input(original),
        qualifiers: original.qualifiers.map((snak) => ({ property: { id: snak.property.id }, value: snak.value })),
        references: original.references.map(({ parts }) => ({
          parts: parts.map((snak) => ({ property: { id: snak.property.id }, value: snak.value })),
        })),
      },
    });
    expect(parts.holder.subject.statements[parts.property]![0]).toEqual(original);
    expect(parts.calls.some((call) => /:(accept|adopt)$/.test(call.path))).toBe(false);
    await act(async () => button(container, m.work_parts_more()).click());
    expect(container.querySelector('li a')?.textContent).toBe('Volume Ten');
    expect(parts.calls.at(-1)).toMatchObject({
      query: { cursor: 'native-next', property: parts.property, language: 'en', limit: '20' },
      session: 'parts-session',
    });

    const readonly = workPartsFixture('no-position');
    const readonlyRead = await readonly.transport.read();
    if (!readonlyRead.ok || !readonlyRead.stream) throw new Error('Expected the read-only part stream');
    await render(
      'patterns-catalogue-work-parts--no-position',
      h(WorkPartsPage, {
        id: readonly.id,
        locale: 'en',
        transport: readonly.transport,
        search: readonly.search,
        initial: readonlyRead,
      }),
    );
    expect(mainText(container)).toContain(m.work_parts_order_readonly());
    expect(mainText(container)).toContain(m.work_parts_count({ accuracy: m.work_parts_exact(), count: 1 }));
    expect(mainText(container.querySelector('li')!)).not.toContain('schema:position');
    await act(async () => button(container, m.work_parts_correct()).click());
    await act(async () => button(container, m.relation_open()).click());
    const addLabel = [...container.querySelectorAll<HTMLLabelElement>('label')].find(
      (label) => label.textContent === m.relation_qualifier(),
    )!;
    expect(container.querySelector<HTMLSelectElement>(`[id="${addLabel.htmlFor}"]`)!.disabled).toBe(true);
    const correction = partCorrection(readonlyRead.rows[0]!, readonlyRead.stream)!;
    expect(correction.positionEditable).toBe(false);
    correction.statement.qualifiers.push({
      property: { id: 'schema:position', data_type: 'string' },
      value: { type: 'value', content: '1' },
    });
    expect(
      await readonly.transport.relation(correction.id).propose({ ...correction, key: crypto.randomUUID() }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(readonly.calls.some((call) => call.method === 'POST')).toBe(false);

    for (const [scenario, message] of [
      ['missing-assertion', m.work_parts_assertion_unavailable()],
      ['pending', m.work_parts_pending()],
      ['empty', m.work_parts_empty()],
      ['unavailable', m.candidate_unavailable()],
      ['denied', m.candidate_denied()],
    ] as const) {
      const fixture = workPartsFixture(scenario);
      await render(
        `patterns-catalogue-work-parts--${scenario}`,
        h(WorkPartsPage, {
          id: fixture.id,
          locale: 'en',
          transport: fixture.transport,
          search: fixture.search,
          initial: await fixture.transport.read(),
        }),
      );
      expect(mainText(container)).toContain(message);
      if (scenario === 'missing-assertion') {
        expect(container.querySelector('li a')?.textContent).toBe('Volume Two');
        expect(
          [...container.querySelectorAll('button')].some((node) => node.textContent === m.work_parts_correct()),
        ).toBe(false);
      }
      if (scenario === 'unavailable' || scenario === 'denied') expect(mainText(container)).not.toContain('Volume Two');
    }
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('Work Parts summary headings preserve supplied language, unresolved authority and independent evidence focus', async () => {
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
  const { WorkPartsPage } = await import('../src/features/catalogue/work-parts-page');
  const { workPartsFixture } = await import('../src/kernel/fake/work-parts');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const container = window.document.createElement('main') as HTMLElement;
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    const fixture = workPartsFixture('partial');
    const supplied = await fixture.transport.read();
    if (!supplied.ok || !supplied.rows[0]?.summary) throw new Error('Expected a resolved Work Part');
    const title = '旅人の物語 第二巻 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
    const first = supplied.rows[0];
    const summary = { ...first.summary!, label: { value: title, language: 'ja' } };
    const row = { ...first, summary };
    const initial = { ...supplied, rows: [row] };
    const before = structuredClone(initial);
    const calls = fixture.calls.length;
    const render = async (key: string, rows: typeof supplied.rows = initial.rows) => {
      await act(async () =>
        root.render(
          h(
            ConnectedStory,
            { key, storyId: key },
            h(WorkPartsPage, {
              id: fixture.id,
              locale: 'en',
              transport: fixture.transport,
              search: fixture.search,
              initial: { ...initial, rows },
            }),
          ),
        ),
      );
      return container.querySelector('ul > li')!;
    };
    const item = await render('semantic-parts-resolved');
    expect(item.querySelector('li')).toBeNull();
    const heading = item.querySelector('h2')!;
    expect(heading.textContent).toBe(title);
    expect(heading.getAttribute('lang')).toBe('ja');
    const primary = item.querySelector<HTMLAnchorElement>('a')!;
    const href = subjectHref({ id: summary.id, label: title }, 'en').href;
    expect(primary.getAttribute('href')).toBe(href);
    expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
    const citation = item.querySelector<HTMLAnchorElement>('a[href="https://example.org/contents"]')!;
    const correction = [...item.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.work_parts_correct(),
    )!;
    const disclosure = item.querySelector('details')!;
    const toggle = disclosure.querySelector('summary')!;
    expect(disclosure.open).toBe(false);
    expect(JSON.parse(disclosure.querySelector('pre')!.textContent!)).toEqual(first.statement);
    expect(item.querySelector('a a, a button, a details')).toBeNull();
    for (const control of [primary, citation, correction, toggle]) {
      control.focus();
      expect(window.document.activeElement).toBe(control);
    }
    expect(fixture.calls).toHaveLength(calls);
    await act(async () => correction.click());
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === m.relation_open())).toBe(
      true,
    );
    expect(disclosure.open).toBe(false);
    expect(fixture.calls).toHaveLength(calls);
    expect(initial).toEqual(before);

    const unresolved = await render('semantic-parts-unresolved', [{ ...row, summary: null }]);
    expect(unresolved.querySelector('h2')?.textContent).toBe(m.work_parts_unresolved());
    expect([...unresolved.querySelectorAll('a')].some((link) => link.getAttribute('href') === href)).toBe(false);
    expect(unresolved.querySelector('a[href="https://example.org/contents"]')).not.toBeNull();
    expect(
      [...unresolved.querySelectorAll('button')].some((button) => button.textContent === m.work_parts_correct()),
    ).toBe(true);
    expect(JSON.parse(unresolved.querySelector('pre')!.textContent!)).toEqual(first.statement);

    const { statement: _statement, ...withoutAssertion } = row;
    const missing = await render('semantic-parts-missing', [withoutAssertion]);
    expect(missing.querySelector('h2')?.textContent).toBe(title);
    expect(missing.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(missing.textContent).toContain(m.work_parts_assertion_unavailable());
    expect(
      [...missing.querySelectorAll('button')].some((button) => button.textContent === m.work_parts_correct()),
    ).toBe(false);
    expect(missing.querySelector('details')?.open).toBe(false);
    expect(missing.querySelector('pre')).toBeNull();
    expect(fixture.calls).toHaveLength(calls);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
