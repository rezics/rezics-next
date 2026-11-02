import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkPartsRead } from '../src/features/catalogue/work-parts';

mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN. This actual-component campaign is supplied-data/HTTP-seam evidence only.
// Real keyboard, hit testing and geometry belong to the connected browser plays; native,
// BFF reader/credential and SSR acceptance remain with the unchanged original campaigns.
async function mounted(
  run: (ui: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    click: (name: string, scope?: ParentNode) => Promise<void>;
    change: (select: HTMLSelectElement, value: string) => Promise<void>;
    input: (element: HTMLInputElement, value: string) => Promise<void>;
    until: (predicate: () => boolean) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
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
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await run({
      host,
      render: async (node) => {
        await act(async () => root.render(h(QueryClientProvider, { client }, node)));
      },
      click: async (name, scope = host) => {
        const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(
          (button) => button.textContent?.trim() === name,
        );
        const button = buttons.at(-1)!;
        expect(button).toBeDefined();
        expect(button.disabled).toBe(false);
        await act(async () => button.click());
      },
      change: async (select, value) => {
        await act(async () => {
          select.value = value;
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
      },
      input: async (element, value) => {
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
          element.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
      },
      until: async (predicate) => {
        for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
        expect(predicate()).toBe(true);
      },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function queuedClick(element: Element) {
  const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
  const callback = Reflect.get(element, key).onClick as () => unknown;
  return callback;
}

test('Work Parts keeps independent streams, full supplied composition, deliberate native actions and retired controls', async () => {
  await mounted(async ({ host, render, click, change, input, until }) => {
    const { WorkPartsPage } = await import('../src/features/catalogue/work-parts-page');
    const { workPartsFixture, workPartId } = await import('../src/kernel/fake/work-parts');
    const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
    const { partCorrection } = await import('../src/features/catalogue/work-parts');
    const { subjectHref } = await import('../src/subject/subject-href');
    const { m } = await import('../src/paraglide/messages.js');
    const ready = (value: WorkPartsRead) => {
      if (!value.ok || !value.stream) throw new Error('Expected supplied native stream');
      return value;
    };
    const button = (name: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
    let mount = 0;
    const show = (
      fixture: ReturnType<typeof workPartsFixture>,
      initial = fixture.snapshot(),
      locale = 'en',
      transport = fixture.transport,
    ) =>
      render(
        h(WorkPartsPage, {
          key: ++mount,
          id: fixture.id,
          locale,
          initial,
          search: fixture.search,
          transport,
        }),
      );

    const left = workPartsFixture('partial');
    const right = workPartsFixture('partial');
    await render(
      h(
        'div',
        {},
        ...[left, right].map((fixture, index) =>
          h(WorkPartsPage, {
            key: `independent-${index}`,
            id: fixture.id,
            locale: 'en',
            initial: fixture.snapshot(),
            search: fixture.search,
            transport: fixture.transport,
          }),
        ),
      ),
    );
    const panels = [...host.querySelectorAll<HTMLElement>('article')];
    const controls = panels.map((panel) => panel.querySelector<HTMLSelectElement>('select')!);
    expect(controls[0]!.id).not.toBe(controls[1]!.id);
    for (const [index, panel] of panels.entries()) {
      const label = panel.querySelector<HTMLLabelElement>('label')!;
      expect(label.htmlFor).toBe(controls[index]!.id);
      expect(label.control).toBe(controls[index]);
      expect(host.ownerDocument.getElementById(label.htmlFor)).toBe(controls[index]);
      const row = panel.querySelector('li')!;
      const heading = row.querySelector('h2')!;
      expect(row.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(row.querySelector('a')!.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(row.parentElement!.tagName).toBe('UL');
      expect(row.querySelector('h3')!.textContent).toBe(m.sources_citations());
      expect(row.querySelector('[data-slot="list-row-control"]')).toBeNull();
      expect(row.querySelector('a a, a button, a summary')).toBeNull();
      for (const control of row.querySelectorAll<HTMLElement>('a,button,summary')) {
        control.focus();
        expect(host.ownerDocument.activeElement).toBe(control);
      }
    }
    const leftInitial = ready(left.snapshot());
    const alternative = leftInitial.streams.find(
      (stream) => stream.direction === 'inverse' && stream.key !== leftInitial.stream!.key,
    )!;
    expect(alternative).toBeDefined();
    await change(controls[0]!, alternative.key);
    await until(() => controls[0]!.value === alternative.key);
    expect(controls[1]!.value).toBe(leftInitial.stream!.key);
    expect(right.calls).toHaveLength(0);
    expect(left.calls).toHaveLength(2);
    expect(left.calls[1]!.query).toMatchObject({ property: alternative.property, language: 'en', limit: '20' });
    expect(left.calls[1]!.session).toBe('parts-session');
    await change(controls[0]!, leftInitial.stream!.key);
    await until(() => !!panels[0]!.querySelector('li'));
    await click(m.work_parts_correct(), panels[0]);
    const correction = panels[0]!.querySelector(':scope > div > section > details > summary')!;
    expect(correction).not.toBeNull();
    expect(panels[1]!.querySelector(':scope > div > section > details > summary')).toBeNull();
    expect(left.calls).toHaveLength(4); // Opening a correction is local; opening the editor is deliberate.
    expect(right.calls).toHaveLength(0);
    await click(m.relation_open(), panels[0]);
    await until(() => !!panels[0]!.querySelector('input[id$="qualifier-0"]'));
    const position = panels[0]!.querySelector<HTMLInputElement>('input[id$="qualifier-0"]')!;
    await input(position, '3');
    const beforeMore = left.calls.length;
    const sliceStatus = panels[0]!.querySelector<HTMLElement>('p[role="status"]')!;
    button(m.work_parts_more(), panels[0]).focus();
    await click(m.work_parts_more(), panels[0]);
    await until(() => panels[0]!.textContent!.includes('Volume Ten'));
    expect(host.ownerDocument.activeElement).toBe(sliceStatus);
    expect(button(m.work_parts_more(), panels[0])).toBeUndefined();
    expect(position.value).toBe('3');
    expect(host.contains(position)).toBe(true);
    expect(left.calls).toHaveLength(beforeMore + 2);
    expect(left.calls.at(-1)!.query).toMatchObject({
      property: left.property,
      cursor: 'native-next',
      language: 'en',
      limit: '20',
    });
    expect(left.calls.at(-1)!.session).toBe('parts-session');
    await click(m.work_parts_correct(), panels[0]);
    expect(panels[0]!.querySelectorAll(':scope > div > section')).toHaveLength(3); // Add plus two drafts.
    expect(position.value).toBe('3');
    const continued = panels[0]!.querySelector<HTMLAnchorElement>('li a')!.href;
    await click(m.candidate_reload(), panels[0]);
    await until(() => panels[0]!.getAttribute('aria-busy') === 'false');
    expect(panels[0]!.querySelector<HTMLAnchorElement>('li a')!.href).toBe(continued);
    expect(left.calls.at(-1)!.query.cursor).toBe('native-next');
    button(m.work_parts_restart(), panels[0]).focus();
    await click(m.work_parts_restart(), panels[0]);
    await until(() => panels[0]!.querySelector('li h2')?.textContent === 'Volume Two');
    expect(host.ownerDocument.activeElement).toBe(sliceStatus);
    expect(left.calls.at(-1)!.query).not.toHaveProperty('cursor');
    expect(position.value).toBe('3');
    expect(right.calls).toHaveLength(0);

    const recovery = workPartsFixture('partial');
    const seed = ready(recovery.snapshot());
    let failMore = true;
    const attempted: Array<[string | undefined, string | undefined, string | undefined]> = [];
    await show(recovery, seed, 'en', {
      ...recovery.transport,
      read: async (key, cursor, session): Promise<WorkPartsRead> => {
        attempted.push([key, cursor, session]);
        if (failMore && cursor === seed.next) {
          failMore = false;
          return { ok: false, reason: 'unavailable' };
        }
        return recovery.transport.read(key, cursor, session);
      },
    });
    const retryStatus = host.querySelector<HTMLElement>('p[role="status"]')!;
    button(m.work_parts_more()).focus();
    await click(m.work_parts_more());
    await until(() => !!host.querySelector('[role="alert"]'));
    expect(host.ownerDocument.activeElement).toBe(host.querySelector('[role="alert"]'));
    button(m.candidate_reload()).focus();
    await click(m.candidate_reload());
    await until(() => host.querySelector('article')!.getAttribute('aria-busy') === 'false');
    expect(host.ownerDocument.activeElement).toBe(retryStatus);
    expect(attempted).toEqual([
      [seed.stream!.key, seed.next, seed.session],
      [seed.stream!.key, undefined, seed.session],
    ]);

    // Full reading data is supplied, including content not admitted for editing by current definitions.
    const rich = workPartsFixture();
    const supplied = ready(rich.snapshot());
    const row = supplied.rows[0]!;
    const long = '旅人の物語 第二巻 — 長い道のりを越えて、ふたたび出会う人々と終わらない読書の記録';
    row.summary = { ...row.summary!, label: { value: long, language: 'ja' } };
    row.statement = structuredClone(row.statement!);
    row.statement.qualifiers.push({
      property: { id: 'schema:name', data_type: 'monolingualtext' },
      value: {
        type: 'value',
        content: { text: 'Édition originale — toutes les informations conservées', language: 'fr' },
      },
    });
    row.statement.references.push({
      hash: 'second-reference',
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: 'https://archive.example.test/' + 'complete-reference/'.repeat(12) },
        },
      ],
    });
    supplied.labels['schema:name'] = { text: 'معلومات الطبعة الأصلية كاملة', lang: 'ar' };
    const immutable = structuredClone(supplied);
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
      await show(rich, supplied, locale);
      const item = host.querySelector('li')!;
      expect(item.querySelector('h2')!.textContent).toBe(long);
      expect(item.querySelector('h2')!.getAttribute('lang')).toBe('ja');
      expect(item.querySelector('a')!.getAttribute('href')).toBe(
        subjectHref({ id: row.summary.id, label: long }, locale).href,
      );
      expect(item.textContent).toContain('Édition originale — toutes les informations conservées');
      expect(item.querySelector('[lang="ar"]')!.textContent).toBe(supplied.labels['schema:name']!.text);
      expect(item.querySelector('pre')!.textContent).toBe(JSON.stringify(row.statement, null, 2));
      const references = item.querySelector('details dl')!.textContent!;
      for (const reference of [row.holder, supplied.stream!.property, row.statementId])
        expect(references).toContain(reference);
      expect(item.querySelector('details')!.open).toBe(false);
      expect(item.querySelectorAll('a')).toHaveLength(4); // Primary, value subject, two independent citations.
      const clone = partCorrection(row, supplied.stream!)!;
      expect(clone.statement.qualifiers).toEqual(row.statement.qualifiers);
      expect(clone.statement.references).toEqual(row.statement.references.map(({ parts }) => ({ parts })));
    }
    expect(supplied).toEqual(immutable);
    expect(rich.calls).toHaveLength(0);

    for (const scenario of [
      'empty',
      'denied',
      'stale',
      'unavailable',
      'pending',
      'missing-assertion',
      'no-position',
    ] as const) {
      const fixture = workPartsFixture(scenario);
      await show(fixture);
      if (scenario === 'denied' || scenario === 'stale' || scenario === 'unavailable') {
        expect(host.querySelector('[role="alert"]')!.textContent).toBe(
          scenario === 'denied'
            ? m.candidate_denied()
            : scenario === 'stale'
              ? m.relation_stale()
              : m.candidate_unavailable(),
        );
        expect(host.textContent).not.toContain('Volume Two');
      } else if (scenario === 'empty') {
        expect(host.textContent).toContain(m.work_parts_empty());
        expect(host.querySelectorAll('li')).toHaveLength(0);
      } else if (scenario === 'pending') expect(host.textContent).toContain(m.work_parts_pending());
      else if (scenario === 'missing-assertion') {
        expect(host.textContent).toContain(m.work_parts_assertion_unavailable());
        expect(button(m.work_parts_correct())).toBeUndefined();
        expect(host.querySelector('li a')).not.toBeNull();
      } else {
        expect(host.textContent).toContain(m.work_parts_order_readonly());
        await click(m.work_parts_correct());
        await click(m.relation_open());
        await until(() => !!button(m.relation_propose()));
        expect(host.querySelector('input[id$="qualifier-0"]')).toBeNull();
      }
      expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
    }
    const unresolved = ready(workPartsFixture().snapshot());
    unresolved.rows[0]!.summary = null;
    await show(workPartsFixture(), unresolved);
    expect(host.querySelector('li h2')!.textContent).toBe(m.work_parts_unresolved());
    expect(host.querySelector('li [data-slot="list-row-link"]')).toBeNull();
    expect(host.querySelector('li a[href="https://example.org/contents"]')).not.toBeNull();

    const loading = workPartsFixture();
    let loadingReads = 0;
    await render(
      h(WorkPartsPage, {
        key: 'loading',
        id: loading.id,
        locale: 'en',
        search: loading.search,
        transport: {
          ...loading.transport,
          read: () => {
            loadingReads++;
            return new Promise(() => {});
          },
        },
      }),
    );
    expect(host.querySelector('article')!.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="status"]')!.textContent).toBe(m.candidate_loading());
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(loadingReads).toBe(1);
    expect(loading.calls).toHaveLength(0);

    // Real fixture HTTP seam: proposing, accepting and adopting remain three deliberate steps.
    const action = workPartsFixture('uncertain');
    await show(action);
    await click(m.work_parts_correct());
    expect(action.calls).toHaveLength(0);
    await click(m.relation_open());
    await until(() => !!button(m.relation_propose()));
    expect(action.calls.every((call) => call.method === 'GET')).toBe(true);
    const original = structuredClone(action.original);
    await click(m.relation_propose());
    expect(action.calls.some((call) => call.method === 'POST')).toBe(false);
    await click(m.relation_propose());
    await until(() => host.textContent!.includes(m.candidate_unavailable()));
    const post = action.calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe(`/v1/subjects/${workPartId}/candidates`);
    expect(post.authorization).toBe('Bearer contributor');
    expect(post.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toEqual({
      statement: {
        property: { id: original.property.id },
        value: original.value,
        qualifiers: original.qualifiers.map(({ property, value }) => ({ property: { id: property.id }, value })),
        references: original.references.map(({ parts }) => ({
          parts: parts.map(({ property, value }) => ({ property: { id: property.id }, value })),
        })),
      },
    });
    expect(action.holder.subject.statements[action.property]![0]).toEqual(original);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(button(m.candidate_cancel()).disabled).toBe(true);
    await click(m.relation_propose());
    await until(() => !!button(m.candidate_accept()));
    expect(action.calls.filter((call) => call.method === 'POST')).toEqual([post, post]);
    expect(action.receipts.size).toBe(1);
    await click(m.candidate_accept());
    expect(action.calls.filter((call) => call.path.endsWith(':accept'))).toHaveLength(0);
    await click(m.candidate_accept());
    await until(() => host.textContent!.includes(m.candidate_accepted()));
    const accept = action.calls.find((call) => call.path.endsWith(':accept'))!;
    expect(accept.body).toEqual({ context: action.anchor.subject.context, expected_head: null });
    expect(accept.authorization).toBe('Bearer contributor');
    expect(action.holder.subject.statements[action.property]![0]).toEqual(original);
    const editor = host.querySelector(`section[aria-label="${m.relation_title()}"]`)!;
    await click(m.candidate_reload(), editor);
    await until(() => !!button(m.candidate_review(), editor));
    await click(m.candidate_review(), editor);
    await click(m.candidate_adopt(), editor);
    expect(action.calls.filter((call) => call.path.endsWith(':adopt'))).toHaveLength(0);
    await click(m.candidate_adopt(), editor);
    await until(() => action.calls.some((call) => call.path.endsWith(':adopt')));
    const adopt = action.calls.find((call) => call.path.endsWith(':adopt'))!;
    expect(adopt.body).toMatchObject({
      property: action.property,
      target: action.id,
      expected_head: 3,
      selection: [{ candidate: '00000000-0000-4000-8000-000000000804', rank: 'normal' }],
    });
    expect(adopt.authorization).toBe('Bearer contributor');
    expect(adopt.session).toBe('parts-session');
    expect(adopt.key).not.toBe(accept.key);
    expect(action.holder.subject.statements[action.property]![0]!.id).toBe('00000000-0000-4000-8000-000000000804');

    // Retain a queued control across reader A-B-A and unmount: no late action/read or focus theft.
    const retired = workPartsFixture('partial');
    const retiredInitial = ready(retired.snapshot());
    let finishRetiredRead!: (value: WorkPartsRead) => void;
    const retiredTransport = {
      ...retired.transport,
      read: () => new Promise<WorkPartsRead>((resolve) => (finishRetiredRead = resolve)),
    };
    const observed = (subject: string) => ({
      state: 'signed-in' as const,
      subject,
      csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const boundary = (reader: string) =>
      h(
        CandidateReaderBoundary,
        { observed: observed(reader), address: 'work-parts-family' },
        h(WorkPartsPage, {
          id: retired.id,
          locale: 'en',
          initial: retiredInitial,
          search: retired.search,
          transport: retiredTransport,
        }),
      );
    await render(boundary('reader-a'));
    const old = queuedClick(button(m.work_parts_correct()));
    button(m.work_parts_more()).focus();
    await click(m.work_parts_more());
    await render(boundary('reader-b'));
    await render(boundary('reader-a'));
    const reads = retired.calls.length;
    const outside = host.ownerDocument.createElement('button');
    host.ownerDocument.body.append(outside);
    outside.focus();
    await act(async () => {
      old();
    });
    await act(async () => {
      finishRetiredRead(retiredInitial);
    });
    expect(retired.calls).toHaveLength(reads);
    expect(button(m.relation_open())).toBeUndefined();
    expect(host.ownerDocument.activeElement).toBe(outside);
    const unmounted = queuedClick(button(m.work_parts_restart()));
    await render(null);
    await act(async () => {
      unmounted();
    });
    expect(retired.calls).toHaveLength(reads);
    outside.remove();

    // Supplied-data growth only: 64 rows occupy four independent <=20-row pages.
    // This does not claim a 64-row native page or backend examined-row/growth proof.
    for (const scale of [1, 8, 64]) {
      const fixture = workPartsFixture();
      const seed = ready(fixture.snapshot());
      const nodes: ReactNode[] = [];
      for (let offset = 0; offset < scale; offset += 20) {
        const page = {
          ...seed,
          rows: Array.from({ length: Math.min(20, scale - offset) }, (_, index) => ({
            ...seed.rows[0]!,
            holder: `supplied-holder-${offset + index}`,
            statementId: `supplied-statement-${offset + index}`,
            summary: { ...seed.rows[0]!.summary!, label: { value: `Supplied part ${offset + index}`, language: 'en' } },
          })),
        };
        // A rendering pass must not inspect unrelated whole-subject statement populations.
        Object.defineProperty(page.public.subject, 'statements', {
          configurable: true,
          get: () => {
            throw new Error('Unexpected whole-population traversal');
          },
        });
        nodes.push(
          h(WorkPartsPage, {
            key: `growth-${scale}-${offset}`,
            id: fixture.id,
            locale: 'en',
            initial: page,
            search: fixture.search,
            transport: fixture.transport,
          }),
        );
      }
      await render(h('div', {}, ...nodes));
      expect(host.querySelectorAll('li')).toHaveLength(scale);
      expect(host.querySelectorAll('li h2')).toHaveLength(scale);
      expect(host.querySelectorAll('li pre')).toHaveLength(scale);
      expect(fixture.calls).toHaveLength(0);
    }
  });
}, 30_000);
