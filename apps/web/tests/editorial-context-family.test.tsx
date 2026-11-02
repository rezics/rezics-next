// Authored UNRUN. Mounted DOM assertions do not establish browser geometry or native authority.
// Original lifecycle, reader/session/credential, ABA and retirement campaigns remain unchanged.
import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ReactNode } from 'react';
import { editorialContextFixture } from '../src/kernel/fake/editorial-context';
import { contextFixture } from '../src/kernel/fake/context-curation';
import type { EditorialTransport } from '../src/features/catalogue/editorial-context';

// One actual-component regression, deliberately separate from the native campaign.
test('Editorial Context family retains supplied comparison, independent controls and exact deliberate lifecycle recovery', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://editorial.test/en' });
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
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { userEvent } = await import('storybook/test');
  const { EditorialContextWorkspace } = await import('../src/features/catalogue/editorial-context-view');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { ContextComparisonView } = await import('../src/features/catalogue/context-curation-view');
  const { CandidateReview } = await import('../src/subject/candidate-review');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { pageText } = await import('../src/features/pages/data');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const o = { locale: 'en' as const };
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (node: ReactNode) => {
    await act(async () => root.render(node));
  };
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const until = async (predicate: () => boolean) => {
    for (let turn = 0; turn < 60 && !predicate(); turn++) await flush();
    expect(predicate()).toBe(true);
  };
  const buttons = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].filter((node) => node.textContent?.trim() === text);
  const button = (text: string, scope: ParentNode = host) => {
    const node = buttons(scope, text).at(-1);
    if (!node) throw new Error(`Missing button: ${text}`);
    return node;
  };
  const click = async (text: string, scope: ParentNode = host) => {
    await act(async () => userEvent.click(button(text, scope)));
  };
  const supplied = async (scenario: Parameters<typeof contextFixture>[0] = 'inherited') => {
    const fixture = contextFixture(scenario);
    const read = await fixture.transport.read(fixture.property);
    if (!read.ok || !read.contextReview) throw new Error('Missing supplied comparison');
    return { fixture, read };
  };
  const reader = (subject: string) => ({ state: 'signed-in' as const, subject, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' });
  try {
    // Pure supplied rendering: names, authority and outcome precede distinct current public/selected panels.
    const { fixture, read } = await supplied('replaced');
    const property = 'schema:description';
    const longName = '読者と物語 — Gemeinschaft de lecture '.repeat(6).trim();
    const globalValue = 'Global 公開内容 '.repeat(100).trim();
    const selectedValue = 'Selected 選択内容 '.repeat(100).trim();
    const statement = (value: string) => ({
      ...fixture.candidate.statement,
      property: { id: property, data_type: 'string' as const },
      value: { type: 'value' as const, content: value },
    });
    const comparison = {
      ...read,
      public: {
        ...read.public,
        subject: { ...read.public.subject, statements: { [property]: [statement(globalValue)] } },
      },
      contextReview: {
        ...read.contextReview!,
        context: { ...read.contextReview!.context, labels: { en: longName } },
        selected: [statement(selectedValue)],
        inherited: [statement(globalValue)],
      },
    };
    const before = structuredClone(comparison);
    const calls = fixture.calls.length;
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      await render(
        <div dir="rtl">
          <ContextComparisonView read={comparison} property={property} locale={locale} />
        </div>,
      );
      const options = { locale: locale as never };
      const panel = host.querySelector<HTMLElement>('[data-context-comparison]')!;
      expect(panel.className).toContain('group');
      expect(panel.className).toContain('[overflow-wrap:anywhere]');
      expect(panel.querySelector('h3[data-content-item-slot="title"]')!.textContent).toBe(longName);
      expect([...panel.querySelectorAll('h4')].map((node) => node.textContent)).toEqual([
        m.context_global_values({}, options),
        m.context_selected_values({}, options),
      ]);
      const text = panel.textContent!;
      expect(text.indexOf(m.context_authority({}, options))).toBeLessThan(text.indexOf(globalValue));
      expect(text.indexOf(m.context_replaced({}, options))).toBeLessThan(text.indexOf(globalValue));
      const sections = [...panel.querySelectorAll('section')];
      expect(sections).toHaveLength(2);
      expect(sections[0]!.textContent).toContain(globalValue);
      expect(sections[1]!.textContent).toContain(selectedValue);
      for (const section of sections)
        expect(section.querySelector('[data-context-values]')!.className).toContain('group');
      const link = panel.querySelector('a')!;
      expect(link.getAttribute('href')).toBe(
        subjectHref({ id: read.public.subject.id, label: pageText(read.public.subject.labels, locale).text }, locale)
          .href,
      );
      for (const token of [
        'min-h-11',
        'min-w-11',
        'whitespace-normal',
        '[overflow-wrap:anywhere]',
        'focus-visible:outline-2',
      ])
        expect(link.className).toContain(token);
      expect(
        panel.querySelector('a a, a button, [tabindex], details, [class*="line-clamp"], [class*="truncate"]'),
      ).toBeNull();
      expect(fixture.calls).toHaveLength(calls);
    }
    expect(comparison).toEqual(before);
    for (const scenario of ['inherited', 'replaced', 'suppressed', 'unresolved', 'empty'] as const) {
      const { fixture: sample, read: value } = await supplied(scenario);
      const count = sample.calls.length;
      await render(<ContextComparisonView read={value} property={sample.property} locale="en" />);
      const outcome = scenario === 'empty' ? 'inherited' : scenario;
      expect(host.querySelector('[role="status"]')!.textContent).toBe(m[`context_${outcome}`]({}, o));
      if (['suppressed', 'unresolved', 'empty'].includes(scenario))
        expect(host.querySelectorAll('section')[1]!.textContent).toContain(m.context_no_values({}, o));
      expect(sample.calls).toHaveLength(count);
      await render(<ContextComparisonView read={value} property="" locale="en" />);
      expect(host.querySelector('h3')).not.toBeNull();
      expect(host.querySelector('h4, [role="status"]')).toBeNull();
    }
    const relation = structuredClone(comparison);
    relation.contextReview.slot = { target: fixture.id, key: fixture.context.id };
    relation.contextReview.reading.subject.resolution[property] = 'unresolved';
    const relationBefore = structuredClone(relation);
    await render(<ContextComparisonView read={relation} property={property} locale="en" />);
    expect(host.textContent).toContain(m.context_relation_resolution({}, o));
    expect(host.textContent).toContain(m.context_unresolved({}, o));
    expect(host.querySelector('[role="status"]')!.textContent).toBe(m.context_replaced({}, o));
    expect(relation).toEqual(relationBefore);
    await render(
      <ContextComparisonView read={{ ...read, contextReview: undefined }} property={property} locale="en" />,
    );
    expect(host.innerHTML).toBe('');

    // 1/8/64 independent supplied panels, each within the native single-value bound.
    // This measures presentation work only, not backend/native growth. No population is traversed.
    for (const scale of [1, 8, 64]) {
      let rows = 0;
      const counted = (items: typeof comparison.contextReview.selected) =>
        new Proxy(items, {
          get(target, key, receiver) {
            if (key === 'map')
              return (visit: (value: (typeof target)[number], index: number) => ReactNode) =>
                target.map((value, index) => {
                  rows++;
                  return visit(value, index);
                });
            return Reflect.get(target, key, receiver);
          },
        });
      const bounded = {
        ...comparison,
        contextReview: {
          ...comparison.contextReview,
          inherited: counted(comparison.contextReview.inherited),
          selected: counted(comparison.contextReview.selected),
        },
      };
      // A renderer must not scan subject statements, competition, fields or a global population.
      const guarded = {
        ...bounded,
        public: {
          ...bounded.public,
          subject: {
            ...bounded.public.subject,
            get statements(): never {
              throw new Error('Unexpected whole-subject traversal');
            },
          },
        },
        get page(): never {
          throw new Error('Unexpected competition traversal');
        },
        get fields(): never {
          throw new Error('Unexpected field traversal');
        },
      };
      await render(
        <>
          {Array.from({ length: scale }, (_, index) => (
            <ContextComparisonView key={index} read={guarded} property={property} locale="en" />
          ))}
        </>,
      );
      expect(host.querySelectorAll('[data-context-comparison]')).toHaveLength(scale);
      expect(host.querySelectorAll('[data-context-values]')).toHaveLength(2 * scale);
      expect(rows).toBe(2 * scale);
      expect(fixture.calls).toHaveLength(calls);
    }

    // Independent creation forms retain unconditional unique field IDs and native keyboard order.
    const first = editorialContextFixture('create');
    const second = editorialContextFixture('create');
    await render(
      <>
        <EditorialContextWorkspace locale="en" transport={first.transport} />
        <EditorialContextWorkspace locale="en" transport={second.transport} />
      </>,
    );
    const workspaces = [...host.querySelectorAll<HTMLElement>('[data-editorial-workspace]')];
    const fields = [...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')];
    expect(new Set(fields.map((node) => node.id)).size).toBe(4);
    for (const workspace of workspaces) {
      expect(workspace.querySelector('[data-editorial-panel]')!.className).toContain('group');
      expect(workspace.querySelector('h2[data-content-item-slot="title"]')).not.toBeNull();
      for (const label of workspace.querySelectorAll('label'))
        expect(workspace.querySelector(`[id="${label.htmlFor}"]`)).not.toBeNull();
    }
    fields[0]!.focus();
    await act(async () => userEvent.tab());
    expect(window.document.activeElement).toBe(fields[1]);
    await act(async () => userEvent.type(fields[1]!, longName));
    expect((fields[3] as HTMLInputElement).value).toBe('');
    expect(first.calls).toHaveLength(0);
    await click(m.editorial_create({}, o), workspaces[0]);
    await until(() => !!workspaces[0]!.querySelector('a'));
    expect(workspaces[0]!.querySelector('h2')!.textContent).toBe(longName);
    expect(second.calls).toHaveLength(0);
    expect(first.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(first.calls[0]!.body).toEqual({ labels: { en: longName } });

    // A queued confirmation stays retired after a mounted current reread.
    await render(null);
    const queued = editorialContextFixture('uncertain');
    const sent: Parameters<EditorialTransport['submit']>[0][] = [];
    const queuedTransport: EditorialTransport = {
      read: queued.transport.read,
      submit: async (command) => {
        sent.push(command);
        const result = await queued.transport.submit(command);
        return result.ok ? result : { ...result, session: 'rotated-session' };
      },
    };
    await render(<EditorialContextWorkspace id={queued.id} locale="en" transport={queuedTransport} />);
    await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
    await click(m.editorial_delete({}, o));
    const retained = (node: Element, event: string) => {
      const key = Object.keys(node).find((key) => key.startsWith('__reactProps'))!;
      return Reflect.get(node, key)[event] as (event?: unknown) => void;
    };
    const oldConfirm = retained(button(m.contribution_confirm({}, o)), 'onClick');
    await click(m.candidate_reload({}, o));
    await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
    await act(async () => oldConfirm());
    expect(queued.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    await click(m.editorial_delete({}, o));
    await click(m.contribution_confirm({}, o));
    const oldRetry = retained(button(m.editorial_retry({}, o)), 'onClick');
    const sealed = structuredClone(sent[0]);
    expect(buttons(host, m.editorial_revise({}, o))).toHaveLength(0);
    await act(async () => oldRetry());
    await until(() => buttons(host, m.editorial_restore({}, o)).length === 1);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[1]).toEqual(sealed);
    expect(sent[1]).toMatchObject({ operation: 'delete', id: queued.id, session: 'editorial-session' });
    await act(async () => {
      oldConfirm();
      oldRetry();
    });
    expect(sent).toHaveLength(2);
    await click(m.editorial_restore({}, o));
    await click(m.contribution_confirm({}, o));
    await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
    await act(async () => oldRetry());
    expect(sent).toHaveLength(3);

    await render(null);
    const draft = editorialContextFixture('create');
    await render(<EditorialContextWorkspace locale="en" transport={draft.transport} />);
    await act(async () => retained(host.querySelector('input')!, 'onChange')({ target: { value: 'Old' } }));
    const oldDraft = retained(host.querySelector('form')!, 'onSubmit');
    await act(async () => retained(host.querySelector('select')!, 'onChange')({ target: { value: 'ja' } }));
    await act(async () => retained(host.querySelector('input')!, 'onChange')({ target: { value: 'Current' } }));
    await act(async () => oldDraft({ preventDefault() {} }));
    expect(draft.calls).toHaveLength(0);
    const createCurrent = retained(host.querySelector('form')!, 'onSubmit');
    await act(async () => createCurrent({ preventDefault() {} }));
    await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
    await act(async () => createCurrent({ preventDefault() {} }));
    expect(draft.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(draft.calls[0]!.body).toEqual({ labels: { ja: 'Current' } });

    // A deliberate delete confirmation keeps confirm/cancel adjacency, then removes review content.
    await render(null);
    const lifecycle = editorialContextFixture();
    await render(
      <EditorialContextWorkspace
        id={lifecycle.id}
        locale="en"
        transport={lifecycle.transport}
        reviewHref={(id) => `/exact-review?context=${id}`}
      >
        {(id) => <span data-review-entry>{id}</span>}
      </EditorialContextWorkspace>,
    );
    await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
    expect(lifecycle.calls).toHaveLength(1);
    await click(m.editorial_delete({}, o));
    expect(host.textContent).toContain(m.editorial_authority({}, o));
    expect(host.textContent).toContain(m.editorial_confirm_delete({}, o));
    expect(host.querySelector('details')).toBeNull();
    const confirm = button(m.contribution_confirm({}, o));
    confirm.focus();
    await act(async () => userEvent.tab());
    expect(window.document.activeElement).toBe(button(m.candidate_cancel({}, o)));
    await act(async () => userEvent.tab({ shift: true }));
    expect(window.document.activeElement).toBe(confirm);
    expect(lifecycle.calls).toHaveLength(1);
    await act(async () => userEvent.keyboard('{Enter}'));
    await until(
      () =>
        buttons(host, m.editorial_restore({}, o)).length === 1 &&
        host.querySelector('section')!.getAttribute('aria-busy') === 'false',
    );
    expect(host.querySelector('[data-review-entry]')).toBeNull();
    expect(host.querySelector('a[href^="/exact-review"]')).toBeNull();
    expect(host.textContent).toContain(m.editorial_deleted({}, o));
    expect(document.activeElement).toBe(confirm.isConnected ? confirm : host.querySelector('[data-editorial-result]'));
    await click(m.editorial_restore({}, o));
    expect(host.textContent).toContain(m.editorial_confirm_restore({}, o));
    const restoreConfirm = button(m.contribution_confirm({}, o));
    restoreConfirm.focus();
    await act(async () => userEvent.keyboard('{Enter}'));
    await until(
      () =>
        host.textContent!.includes(m.editorial_restored({}, o)) &&
        host.querySelector('section')!.getAttribute('aria-busy') === 'false',
    );
    expect(document.activeElement).toBe(
      restoreConfirm.isConnected ? restoreConfirm : host.querySelector('[data-editorial-result]'),
    );
    expect(lifecycle.calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET', 'POST', 'GET']);
    expect(host.querySelector('[data-review-entry]')).not.toBeNull();
    expect(
      lifecycle.calls.slice(1).every((call) => call.headers.get('rezics-session-token') === 'editorial-session'),
    ).toBe(true);

    for (const scenario of ['global', 'missing', 'unavailable', 'loading'] as const) {
      await render(null);
      const sample = editorialContextFixture(scenario);
      await render(<EditorialContextWorkspace id={sample.id} locale="en" transport={sample.transport} />);
      if (scenario === 'loading') expect(host.querySelector('section')!.getAttribute('aria-busy')).toBe('true');
      else
        await until(
          () => sample.calls.length === 1 && host.querySelector('section')!.getAttribute('aria-busy') === 'false',
        );
      expect(buttons(host, m.editorial_restore({}, o))).toHaveLength(0);
      expect(buttons(host, m.editorial_delete({}, o))).toHaveLength(0);
      if (scenario === 'global') expect(host.textContent).toContain(m.editorial_global({}, o));
      if (scenario === 'unavailable') {
        expect(host.textContent).toContain(m.editorial_unavailable({}, o));
        await click(m.candidate_reload({}, o));
        await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
        expect(sample.calls).toHaveLength(2);
      }
    }
    for (const scenario of ['denied', 'expired'] as const) {
      await render(null);
      const sample = editorialContextFixture(scenario);
      await render(<EditorialContextWorkspace id={sample.id} locale="en" transport={sample.transport} />);
      await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
      await click(m.editorial_delete({}, o));
      await click(m.contribution_confirm({}, o));
      if (scenario === 'denied') {
        await until(() => host.textContent!.includes(m.editorial_denied({}, o)));
        expect(buttons(host, m.editorial_restore({}, o))).toHaveLength(0);
        expect(sample.calls.map((call) => call.method)).toEqual(['GET', 'DELETE']);
      } else {
        await until(() => buttons(host, m.editorial_restore({}, o)).length === 1);
        await click(m.editorial_restore({}, o));
        await click(m.contribution_confirm({}, o));
        await until(() => host.textContent!.includes(m.editorial_conflict({}, o)));
        expect(host.querySelector('[data-review-entry], a[href^="/exact-review"]')).toBeNull();
        expect(sample.calls.map((call) => call.method)).toEqual(['GET', 'DELETE', 'GET', 'POST']);
      }
    }
    for (const scenario of ['invalid', 'conflict'] as const) {
      await render(null);
      const sample = editorialContextFixture(scenario);
      await render(<EditorialContextWorkspace locale="en" transport={sample.transport} />);
      await act(async () => userEvent.type(host.querySelector('input')!, longName));
      await click(m.editorial_create({}, o));
      await until(() => !!host.querySelector('[role="alert"]'));
      expect(host.textContent).toContain(
        scenario === 'invalid' ? m.editorial_invalid({}, o) : m.editorial_conflict({}, o),
      );
      expect(host.querySelector('input')!.value).toBe(longName);
      expect(sample.calls.map((call) => call.method)).toEqual(['POST']);
    }
    await render(null);
    const uncertain = editorialContextFixture('uncertain');
    await render(<EditorialContextWorkspace locale="en" transport={uncertain.transport} />);
    const input = host.querySelector('input')!;
    await act(async () => userEvent.type(input, longName));
    await click(m.editorial_create({}, o));
    await until(() => buttons(host, m.editorial_retry({}, o)).length === 1);
    expect(input.disabled).toBe(true);
    expect(input.value).toBe(longName);
    expect(host.querySelector('select')!.disabled).toBe(true);
    expect(buttons(host, m.editorial_revise({}, o))).toHaveLength(0);
    const retryCreate = button(m.editorial_retry({}, o));
    retryCreate.focus();
    await act(async () => userEvent.keyboard('{Enter}'));
    await until(
      () =>
        host.textContent!.includes(m.editorial_created({}, o)) &&
        host.querySelector('section')!.getAttribute('aria-busy') === 'false',
    );
    expect(document.activeElement).toBe(
      retryCreate.isConnected ? retryCreate : host.querySelector('[data-editorial-result]'),
    );
    expect(uncertain.calls[0]!.body).toEqual(uncertain.calls[1]!.body);
    expect([...uncertain.calls[0]!.headers]).toEqual([...uncertain.calls[1]!.headers]);
    expect(uncertain.calls.map((call) => call.method)).toEqual(['POST', 'POST', 'GET']);

    // Native creation is settled even when its ordinary read is unavailable; only current keyboard intent orients.
    for (const intent of [
      'current',
      'pointer',
      'moved away and back',
      'retired away and back',
      'replaced',
      'unmounted',
    ]) {
      await render(null);
      const sample = editorialContextFixture('create');
      let deliver!: () => void;
      const gate = new Promise<void>((resolve) => {
        deliver = resolve;
      });
      const transport: EditorialTransport = {
        read: async (address) => {
          await sample.transport.read(address);
          throw new Error('Follow-up read unavailable');
        },
        submit: async (command) => {
          const result = await sample.transport.submit(command);
          await gate;
          return result;
        },
      };
      const view = (ready = true, id?: string) => (
        <CatalogueCurrentReading visible ready={ready} revision="context">
          <EditorialContextWorkspace locale="en" id={id} transport={transport} reviewHref={() => '/private-review'}>
            {() => <span data-review-entry>Private comparison</span>}
          </EditorialContextWorkspace>
        </CatalogueCurrentReading>
      );
      await render(view());
      await act(async () => userEvent.type(host.querySelector('input')!, 'Private draft'));
      if (intent === 'pointer') await click(m.editorial_create({}, o));
      else {
        button(m.editorial_create({}, o)).focus();
        await act(async () => userEvent.keyboard('{Enter}'));
      }
      await until(() => sample.calls.length === 1);
      if (intent === 'moved away and back') {
        const outside = document.createElement('button');
        document.body.append(outside);
        outside.focus();
        outside.blur();
        outside.remove();
      }
      if (intent === 'retired away and back') {
        await render(view(false));
        await render(view());
      }
      if (intent === 'replaced') await render(view(true, sample.id));
      if (intent === 'unmounted') await render(null);
      await act(async () => deliver());
      await flush();
      const boundary = host.querySelector('[data-editorial-result]');
      if (intent === 'current') expect(document.activeElement).toBe(boundary);
      else if (boundary) expect(document.activeElement).not.toBe(boundary);
      expect(host.querySelector('[data-review-entry], a[href="/private-review"]')).toBeNull();
      if (['current', 'pointer', 'moved away and back'].includes(intent)) {
        expect(boundary!.textContent).toContain(m.editorial_created({}, o));
        expect(boundary!.textContent).toContain(m.editorial_unavailable({}, o));
        expect(host.querySelector('input')).toBeNull();
        expect(sample.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
      } else expect(host.textContent).not.toContain(m.editorial_created({}, o));
    }

    await render(null);
    const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
      await import('@tanstack/react-router');
    const draft = editorialContextFixture();
    const existing = editorialContextFixture();
    const commands: Parameters<EditorialTransport['submit']>[0][] = [];
    let finishCommand!: (value: Awaited<ReturnType<EditorialTransport['submit']>>) => void;
    let finishRead!: (value: Awaited<ReturnType<EditorialTransport['read']>>) => void;
    let holdRead = false;
    let reads = 0;
    const existingTransport: EditorialTransport = {
      read: (address) => {
        reads++;
        return holdRead
          ? new Promise((resolve) => {
              finishRead = resolve;
            })
          : existing.transport.read(address);
      },
      submit: (command) => {
        commands.push(command);
        return new Promise((resolve) => {
          finishCommand = resolve;
        });
      },
    };
    let replaceIdentity!: (kind: 'context' | 'session') => void;
    let arrivals = 0;
    const rootRoute = createRootRoute({ component: Outlet });
    const createRouteView = createRoute({
      getParentRoute: () => rootRoute,
      path: '/en/contexts/new',
      component: () => (
        <div>
          <Link to="/next">Next</Link>
          <EditorialContextWorkspace locale="en" transport={draft.transport} />
        </div>
      ),
    });
    const nextRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/next',
      onEnter: () => {
        arrivals++;
      },
      component: () => <h1>Next</h1>,
    });
    const existingRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/en/contexts/existing',
      component: () => {
        const [identity, setIdentity] = useState({ id: existing.id, csrfToken: 'original' });
        replaceIdentity = (kind) =>
          setIdentity((value) =>
            kind === 'context'
              ? { ...value, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12' }
              : { ...value, csrfToken: 'replacement' },
          );
        return (
          <CandidateReaderBoundary
            observed={{ ...reader('reader'), csrfToken: identity.csrfToken }}
            address="editorial"
          >
            <Link to="/next">Next</Link>
            <EditorialContextWorkspace id={identity.id} locale="en" transport={existingTransport} />
          </CandidateReaderBoundary>
        );
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([createRouteView, existingRoute, nextRoute]),
      history: createMemoryHistory({ initialEntries: ['/en/contexts/new'] }),
    });
    await router.load();
    await render(<RouterProvider router={router} />);
    await until(() => !!host.querySelector('[data-editorial-form]'));
    const nameInput = host.querySelector('input')!;
    const languageSelect = host.querySelector('select')!;
    await act(async () => userEvent.type(nameInput, 'Unfinished Context'));
    await act(async () => {
      languageSelect.value = 'ja';
      languageSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const unload = () => {
      const event = new window.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(true);
    const navigateNext = async () => {
      await act(async () => userEvent.click(host.querySelector('a')!));
      await until(() => !!window.document.querySelector('[role="alertdialog"]'));
      return window.document.querySelector('[role="alertdialog"]')!;
    };
    const draftDialog = await navigateNext();
    expect(draftDialog.textContent).toContain(m.thread_authoring_leave_unsaved({}, o));
    const dialogButton = (label: string) =>
      [...window.document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
        (node) => node.textContent?.trim() === label,
      )!;
    await act(async () => userEvent.click(dialogButton(m.thread_authoring_stay({}, o))));
    await until(() => !window.document.querySelector('[role="alertdialog"]'));
    expect(nameInput.value).toBe('Unfinished Context');
    expect(languageSelect.value).toBe('ja');
    await act(async () => userEvent.clear(nameInput));
    await act(async () => {
      languageSelect.value = 'en';
      languageSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(unload()).toBe(false);
    await act(async () => userEvent.click(host.querySelector('a')!));
    await until(() => router.state.location.pathname === '/next');
    expect(arrivals).toBe(1);

    await act(async () => router.navigate({ to: '/en/contexts/new' }));
    await until(() => !!host.querySelector('[data-editorial-form]'));
    await act(async () => userEvent.type(host.querySelector('input')!, 'Leave this draft'));
    const leaveDialog = await navigateNext();
    expect(leaveDialog.textContent).toContain(m.thread_authoring_leave_unsaved({}, o));
    await act(async () => userEvent.click(dialogButton(m.zone_editor_discard({}, o))));
    await until(() => router.state.location.pathname === '/next');
    expect(arrivals).toBe(2);

    await act(async () => router.navigate({ to: '/en/contexts/new' }));
    await until(() => !!host.querySelector('[data-editorial-form]'));
    await act(async () => userEvent.type(host.querySelector('input')!, 'Saved Context'));
    await click(m.editorial_create({}, o));
    await until(
      () =>
        host.textContent!.includes(m.editorial_created({}, o)) &&
        host.querySelector('[data-editorial-workspace]')?.getAttribute('aria-busy') === 'false',
    );
    await act(async () => userEvent.click(host.querySelector('a')!));
    await until(() => router.state.location.pathname === '/next');
    expect(arrivals).toBe(3);

    // Existing commands share the creation departure owner; ordinary reads stay unprotected.
    const openExisting = async () => {
      holdRead = false;
      await act(async () => router.navigate({ to: '/en/contexts/existing' }));
      await until(() => buttons(host, m.editorial_delete({}, o)).length === 1);
      expect(unload()).toBe(false);
    };
    const stay = async () => {
      expect((await navigateNext()).textContent).toContain(m.thread_authoring_leave_pending({}, o));
      await act(async () => userEvent.click(dialogButton(m.thread_authoring_stay({}, o))));
      await until(() => !window.document.querySelector('[role="alertdialog"]'));
      expect(unload()).toBe(true);
    };
    const sendDelete = async () => {
      await click(m.editorial_delete({}, o));
      await click(m.contribution_confirm({}, o));
    };
    await openExisting();
    await sendDelete();
    expect(commands[0]).toMatchObject({ operation: 'delete', id: existing.id, session: 'editorial-session' });
    expect(commands[0]!.key).toBeTruthy();
    await stay();
    expect(button(m.editorial_retry({}, o)).disabled).toBe(true);
    await act(async () => finishCommand({ ok: false, reason: 'unavailable', session: 'new-session' }));
    const retryDelete = button(m.editorial_retry({}, o));
    await stay();
    expect(button(m.editorial_retry({}, o))).toBe(retryDelete);
    expect(buttons(host, m.editorial_revise({}, o))).toHaveLength(0);
    await click(m.editorial_retry({}, o));
    expect(commands[1]).toBe(commands[0]);
    holdRead = true;
    await act(async () => finishCommand({ ok: true, operation: 'delete', id: existing.id }));
    expect(unload()).toBe(false); // Confirmed completion releases even its still-running ordinary read.
    await act(async () => finishRead({ ok: false, reason: 'unavailable' }));
    expect(unload()).toBe(false);
    await click(m.editorial_restore({}, o));
    await click(m.contribution_confirm({}, o));
    await act(async () => finishCommand({ ok: false, reason: 'unavailable' }));
    await stay();
    await click(m.editorial_retry({}, o));
    expect(commands[3]).toBe(commands[2]);
    expect(commands[2]).toMatchObject({ operation: 'restore', id: existing.id, session: 'new-session' });
    await navigateNext();
    await act(async () => userEvent.click(dialogButton(m.thread_authoring_leave({}, o))));
    await until(() => router.state.location.pathname === '/next');
    expect(arrivals).toBe(4);
    const readsBeforeLate = reads;
    await act(async () => finishCommand({ ok: true, operation: 'restore', id: existing.id }));
    expect(reads).toBe(readsBeforeLate);
    expect(host.textContent).not.toContain(m.editorial_restored({}, o));

    for (const kind of ['context', 'session'] as const) {
      await openExisting();
      await sendDelete();
      const late = finishCommand;
      const oldRetry = button(m.editorial_retry({}, o));
      await navigateNext();
      await act(async () => replaceIdentity(kind));
      await until(() => !window.document.querySelector('[role="alertdialog"]'));
      const readsAfterRetirement = reads;
      const sent = commands.length;
      await act(async () => {
        oldRetry.click();
        late({ ok: true, operation: 'delete', id: existing.id });
      });
      expect(commands).toHaveLength(sent);
      expect(reads).toBe(readsAfterRetirement);
      expect(host.textContent).not.toContain(m.editorial_deleted({}, o));
      expect(unload()).toBe(false);
      await act(async () => userEvent.click(host.querySelector('a')!));
      await until(() => router.state.location.pathname === '/next');
    }
    await render(null);

    // Local acceptance does not adopt a value or turn the selected Context into publication.
    await render(null);
    const local = contextFixture('unresolved');
    await render(
      <CandidateReview
        id={local.id}
        context={local.context.id}
        locale="en"
        initialProperty={local.property}
        transport={local.transport}
      />,
    );
    await click(m.candidate_entry({}, o));
    await until(() => buttons(host, m.candidate_review({}, o)).length > 0);
    await click(m.candidate_review({}, o));
    await click(m.candidate_accept({}, o));
    expect(host.textContent).toContain(m.context_confirm_accept({}, o));
    expect(local.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    await click(m.candidate_accept({}, o));
    await until(() => host.textContent!.includes(m.context_accepted({}, o)));
    const localWrites = local.calls.filter((call) => call.method === 'POST');
    expect(localWrites).toHaveLength(1);
    expect(localWrites[0]!.path.endsWith(':accept')).toBe(true);
    expect(localWrites[0]!.body?.expected_head).toBe(4);
    expect(host.querySelector('[data-context-comparison] [role="status"]')!.textContent).toBe(
      m.context_unresolved({}, o),
    );

    // Keep the original Context curation oracles: choice survives stale; denied withdraws modes.
    for (const scenario of ['conflict', 'adopt-denied', 'empty', 'unavailable', 'loading'] as const) {
      await render(null);
      const sample = contextFixture(scenario);
      await render(
        <CandidateReview
          id={sample.id}
          context={sample.context.id}
          locale="en"
          initialProperty={sample.property}
          transport={sample.transport}
        />,
      );
      await click(m.candidate_entry({}, o));
      if (scenario === 'loading') {
        expect(host.textContent).toContain(m.candidate_loading({}, o));
        continue;
      }
      if (scenario === 'unavailable') {
        await until(() => host.textContent!.includes(m.candidate_unavailable({}, o)));
        expect(host.querySelector('[data-context-comparison]')).toBeNull();
        continue;
      }
      await until(() => !!host.querySelector('[data-context-comparison]'));
      const competition = sample.calls.find((call) => call.path.endsWith('/candidates'))!;
      expect(new URLSearchParams(competition.query).get('limit')).toBe('20');
      expect(new URLSearchParams(competition.query).get('context')).toBe(sample.context.id);
      if (scenario === 'empty') {
        expect(host.textContent).toContain(m.candidate_empty({}, o));
        continue;
      }
      await act(async () => userEvent.selectOptions(host.querySelector('#context-mode')!, 'replace'));
      for (const choice of host.querySelectorAll<HTMLElement>('[role="checkbox"]'))
        if (choice.getAttribute('aria-checked') === 'true') await act(async () => userEvent.click(choice));
      const choice = [...host.querySelectorAll<HTMLElement>('[role="checkbox"]')].at(-1)!;
      await act(async () => userEvent.click(choice));
      await click(m.context_adopt({}, o));
      expect(sample.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      await click(m.context_adopt({}, o));
      await until(() =>
        host.textContent!.includes(
          scenario === 'conflict' ? m.candidate_draft_stale({}, o) : m.candidate_denied({}, o),
        ),
      );
      if (scenario === 'adopt-denied') expect(host.querySelector('#context-mode')).toBeNull();
      else {
        await click(m.candidate_reload({}, o));
        await until(() => !!host.querySelector('#context-mode'));
        expect([...host.querySelectorAll('[role="checkbox"]')].at(-1)!.getAttribute('aria-checked')).toBe('true');
        await click(m.context_adopt({}, o));
        await click(m.context_adopt({}, o));
        await until(() => host.textContent!.includes(m.context_saved({}, o)));
        const writes = sample.calls.filter((call) => call.method === 'POST');
        expect(writes.map((call) => call.body?.expected_head)).toEqual([7, 8]);
        expect(writes[0]!.body?.selection).toEqual(writes[1]!.body?.selection);
        expect(writes[0]!.headers.get('idempotency-key')).not.toBe(writes[1]!.headers.get('idempotency-key'));
      }
    }

    // A late creation from a retired actual reader cannot start the secondary Context read.
    await render(null);
    const retired = editorialContextFixture('create');
    let deliver!: (value: Awaited<ReturnType<EditorialTransport['submit']>>) => void;
    let result!: Awaited<ReturnType<EditorialTransport['submit']>>;
    const transport: EditorialTransport = {
      read: retired.transport.read,
      submit: async (command) => {
        result = await retired.transport.submit(command);
        return new Promise((resolve) => {
          deliver = resolve;
        });
      },
    };
    const boundary = (subject: string) => (
      <CandidateReaderBoundary observed={reader(subject)} address="editorial">
        <EditorialContextWorkspace locale="en" transport={transport} />
      </CandidateReaderBoundary>
    );
    await render(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
    await act(async () => userEvent.type(host.querySelector('input')!, 'Retired private name'));
    await click(m.editorial_create({}, o));
    await until(() => !!deliver);
    await render(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
    await act(async () => deliver(result));
    await flush();
    expect(retired.calls.map((call) => call.method)).toEqual(['POST']);
    expect(host.querySelector('input')!.value).toBe('');
    expect(host.textContent).not.toContain(m.editorial_created({}, o));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 60_000);
