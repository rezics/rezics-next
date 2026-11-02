// Authored UNRUN: focused presentation regressions; native and browser proof remain with integration.
import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps, type ReactNode } from 'react';
import { contextFixture, fixtureId } from '../src/features/contexts/fixtures';
import { ContextWork } from '../src/features/contexts/lifetime';
import {
  detailHref,
  directoryHref,
  directoryInput,
  type Command,
  type MutationResult,
  type Workspace,
} from '../src/features/contexts/model';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://context.invalid/en/my/contexts' });
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
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { userEvent } = await import('storybook/test');
const { ContextCreateView, ContextDetailView, ContextDirectoryView } = await import('../src/features/contexts/view');
const { m } = await import('../src/paraglide/messages.js');
const o = { locale: 'en' as const };
const denied = async (): Promise<MutationResult> => ({ kind: 'denied' });
const noop = async () => {};
function props(scenario: Parameters<typeof contextFixture>[0] = 'active'): ComponentProps<typeof ContextDetailView> {
  return { id: fixtureId, locale: 'en', data: contextFixture(scenario).initialDetail(), submit: denied, reload: noop };
}
function ready(value: ComponentProps<typeof ContextDetailView>['data']): Workspace {
  if (value?.kind !== 'ready') throw new Error('Expected supplied workspace');
  return value.value;
}
async function mount(node: ReactNode) {
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    render: async (next: ReactNode) => {
      await act(async () => root.render(next));
    },
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function visibleText(host: HTMLElement) {
  const copy = host.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll('details:not([open])')) {
    for (const child of [...details.children]) if (child.tagName !== 'SUMMARY') child.remove();
  }
  return copy.textContent ?? '';
}
function button(host: ParentNode, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function summary(host: ParentNode, label: string) {
  const result = [...host.querySelectorAll<HTMLElement>('summary')].find((node) => node.textContent === label);
  if (!result) throw new Error(`Missing disclosure: ${label}`);
  return result;
}
function recoveryTarget(link: HTMLAnchorElement | HTMLElement) {
  expect(link.className).toContain('min-h-11');
  expect(link.className).toContain('min-w-11');
  expect(link.className).toContain('focus-visible:');
  expect(link.className).toContain('[overflow-wrap:anywhere]');
  expect(link.className).not.toContain('whitespace-nowrap');
}
afterAll(async () => {
  await window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('human settings and ordered inherit/suppress facts lead while exact references remain in closed selectable details', async () => {
  const fixture = contextFixture('read-only');
  const data = fixture.initialDetail();
  const context = ready(data).context!;
  const before = structuredClone(data);
  let sends = 0;
  let reads = 0;
  let searches = 0;
  const panel = await mount(
    <ContextDetailView
      {...props()}
      data={data}
      submit={async () => {
        sends++;
        return { kind: 'denied' };
      }}
      reload={async () => {
        reads++;
      }}
      search={async () => {
        searches++;
        return [];
      }}
    />,
  );
  try {
    const text = visibleText(panel.host);
    expect(text).toContain(m.ctxw_settings({}, o));
    expect(text).toContain(m.ctxw_settings_help({}, o));
    expect(text).toContain(m.ctx_reader_settings_selected({}, o));
    expect(text).not.toContain('editorial');
    expect(text).not.toContain('released-settings-digest');
    expect(text).not.toContain('core:description');
    expect(text).not.toContain('core:rating');
    expect(text.indexOf(m.ctx_reader_rule({ number: 1 }, o))).toBeLessThan(
      text.indexOf(m.ctx_reader_rule({ number: 2 }, o)),
    );
    expect(text.indexOf(m.ctxw_inherit({}, o))).toBeLessThan(text.indexOf(m.ctxw_suppress({}, o)));
    const settings = summary(panel.host, m.ctx_reader_settings_details({}, o));
    const details = settings.closest('details')!;
    expect(details.open).toBe(false);
    expect([...details.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
      m.ctxw_setting({}, o),
      m.ctxw_release({}, o),
    ]);
    expect([...details.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
      context.settings!.id,
      context.settings!.release,
    ]);
    for (const node of details.querySelectorAll('dd')) {
      expect(node.className).toContain('select-text');
      expect(node.className).toContain('[overflow-wrap:anywhere]');
      expect(node.getAttribute('dir')).toBe('auto');
    }
    settings.focus();
    expect(window.document.activeElement).toBe(settings);
    recoveryTarget(settings);
    await act(async () => userEvent.click(settings));
    expect(details.open).toBe(true);
    await act(async () => userEvent.click(settings));
    await act(async () => userEvent.tab());
    const firstRule = summary(panel.host, m.ctx_reader_rule_reference({ number: 1 }, o));
    expect(window.document.activeElement).toBe(firstRule);
    await act(async () => userEvent.click(firstRule));
    expect(firstRule.closest('details')!.open).toBe(true);
    expect(visibleText(panel.host)).toContain('core:description');
    expect(firstRule.closest('details')!.textContent).toContain(m.ctx_reader_property_key({}, o));
    expect(visibleText(panel.host)).not.toContain('core:rating');
    expect(panel.host.querySelector('input[type="checkbox"], select')).toBeNull();
    expect([reads, sends, searches, fixture.calls.length]).toEqual([0, 0, 0, 0]);
    expect(data).toEqual(before);
  } finally {
    await panel.dispose();
  }
});

test('many long supplied references preserve insertion order and independent disclosure state without reads', async () => {
  const supplied = props('read-only');
  const context = ready(supplied.data).context!;
  const long = 'unbroken-reference'.repeat(90);
  context.settings = { id: `settings:${long}`, release: `release:${long}` };
  const entries = Array.from(
    { length: 160 },
    (_, index) => [`property:${160 - index}:${long}`, index % 2 ? 'suppress' : 'inherit'] as const,
  );
  context.defaults = Object.fromEntries(entries);
  const before = structuredClone(supplied.data);
  let reads = 0;
  const panel = await mount(
    <>
      <ContextDetailView
        {...supplied}
        reload={async () => {
          reads++;
        }}
      />
      <ContextDetailView
        {...supplied}
        reload={async () => {
          reads++;
        }}
      />
    </>,
  );
  try {
    const [first, second] = [...panel.host.querySelectorAll('article')];
    expect(first!.querySelectorAll('details')).toHaveLength(161);
    const references = [...first!.querySelectorAll('details')].slice(1);
    expect(references.map((node) => node.querySelector('dd')!.textContent)).toEqual(entries.map(([key]) => key));
    expect(first!.querySelectorAll('details[open]')).toHaveLength(0);
    await act(async () => userEvent.click(summary(first!, m.ctx_reader_settings_details({}, o))));
    await act(async () => userEvent.click(summary(first!, m.ctx_reader_rule_reference({ number: 160 }, o))));
    expect(first!.querySelectorAll('details[open]')).toHaveLength(2);
    expect(second!.querySelectorAll('details[open]')).toHaveLength(0);
    expect(reads).toBe(0);
    expect(supplied.data).toEqual(before);
    for (const node of first!.querySelectorAll('details dd'))
      expect(node.className).toContain('[overflow-wrap:anywhere]');
  } finally {
    await panel.dispose();
  }
});

test('no settings, no defaults, Global and community preserve honest separate meanings', async () => {
  const panel = await mount(null);
  try {
    for (const scenario of ['active', 'global'] as const) {
      const supplied = props(scenario);
      const context = ready(supplied.data).context!;
      context.settings = null;
      context.defaults = {};
      await panel.render(<ContextDetailView key={scenario} {...supplied} />);
      const text = visibleText(panel.host);
      expect(text).toContain(m.ctxw_no_settings({}, o));
      expect(text).toContain(m.ctx_reader_no_defaults({}, o));
      expect(text).toContain(scenario === 'global' ? m.ctxw_global_help({}, o) : m.ctxw_community({}, o));
      expect(panel.host.querySelector('details')).toBeNull();
      expect(text).not.toContain(m.ctx_reader_settings_selected({}, o));
      if (scenario === 'global') expect(text).not.toContain(m.ctxw_delete({}, o));
    }
  } finally {
    await panel.dispose();
  }
});

test('every supplied unavailable/refusal and lifecycle state keeps decision facts visible and withdrawn metadata absent', async () => {
  const panel = await mount(null);
  try {
    for (const kind of [
      'signed-out',
      'denied',
      'missing',
      'invalid',
      'conflict',
      'stale',
      'unavailable',
      'unknown',
    ] as const) {
      await panel.render(<ContextDetailView key={kind} {...props()} data={{ kind }} />);
      expect(panel.host.querySelector('[role="alert"]')).not.toBeNull();
      expect(panel.host.textContent).not.toContain('Readers');
      expect(panel.host.querySelector('details')).toBeNull();
      expect(panel.host.textContent).not.toContain('editorial');
    }
    for (const scenario of ['read-only', 'permission-unavailable', 'deleted', 'expired', 'hold', 'revoked'] as const) {
      await panel.render(<ContextDetailView key={scenario} {...props(scenario)} />);
      const text = visibleText(panel.host);
      if (scenario === 'read-only' || scenario === 'permission-unavailable') {
        expect(button(panel.host, m.ctxw_delete({}, o)).disabled).toBe(true);
        expect(text).toContain(scenario === 'read-only' ? m.ctxw_no_action({}, o) : m.ctxw_actions_unavailable({}, o));
      } else if (scenario === 'revoked') {
        expect(text).not.toContain('Readers');
      } else {
        expect(text).toContain(m.ctxw_restore_help({}, o));
        expect(panel.host.querySelector('time[datetime="2026-10-01T10:00:00Z"]')).not.toBeNull();
        expect(panel.host.querySelector('time[datetime="2026-10-31T10:00:00Z"]')).not.toBeNull();
        expect(panel.host.querySelector('details')).toBeNull();
        expect(text).not.toContain(m.ctx_reader_settings_selected({}, o));
      }
    }
    for (const kind of ['denied', 'missing', 'signed-out', 'unavailable'] as const) {
      const supplied = props();
      ready(supplied.data).actions = { kind };
      await panel.render(<ContextDetailView key={`actions-${kind}`} {...supplied} />);
      expect(button(panel.host, m.ctxw_delete({}, o)).disabled).toBe(true);
      expect(visibleText(panel.host)).toContain(m.ctxw_actions_unavailable({}, o));
      expect(visibleText(panel.host)).toContain(m.ctx_reader_settings_selected({}, o));
    }
    const noDeadline = props('deleted');
    ready(noDeadline.data).lifecycle!.purgeAfter = null;
    await panel.render(<ContextDetailView key="no-deadline" {...noDeadline} />);
    expect(button(panel.host, m.ctxw_restore({}, o)).disabled).toBe(true);
    expect(visibleText(panel.host)).toContain(m.ctxw_no_action({}, o));
    const unavailable = props();
    ready(unavailable.data).lifecycleUnavailable = true;
    await panel.render(<ContextDetailView key="lifecycle-unavailable" {...unavailable} />);
    expect(visibleText(panel.host)).toContain(m.ctxw_lifecycle_unavailable({}, o));
  } finally {
    await panel.dispose();
  }
});

test('directory links preserve exact selection, cursor, native form and independent per-instance labels with keyboard recovery', async () => {
  const input = directoryInput({ query: 'Readers & 旅', deleted: true, cursor: 'previous+/==' });
  const data = contextFixture('deleted').initialDirectory(input);
  if (data.page.kind !== 'ready') throw new Error('Expected page');
  const rows = contextFixture('deleted').initialDirectory(directoryInput({ deleted: true })).page;
  if (rows.kind !== 'ready') throw new Error('Expected supplied rows');
  data.page.value.contexts = rows.value.contexts.map((entry) => ({ ...entry, labels: { ja: '読者の選択' } }));
  data.page.value.next = 'next+/==';
  const args: unknown[][] = [];
  const reload = async (...values: unknown[]) => {
    args.push(values);
  };
  const panel = await mount(
    <>
      <ContextDirectoryView locale="en" input={input} data={data} reload={reload} />
      <ContextDirectoryView locale="en" input={input} data={data} reload={reload} />
    </>,
  );
  try {
    const articles = [...panel.host.querySelectorAll('article')];
    const ids = [...panel.host.querySelectorAll('input[type="search"]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    for (const [index, article] of articles.entries()) {
      expect(article.querySelector('label')!.htmlFor).toBe(ids[index]);
      const form = article.querySelector('form')!;
      expect(form.getAttribute('action')).toBe(directoryHref('en'));
      expect(form.getAttribute('method')).toBe('get');
      expect(form.querySelector<HTMLInputElement>('[name="query"]')!.value).toBe(input.query!);
      expect(form.querySelector<HTMLInputElement>('[name="deleted"]')!.value).toBe('true');
      const links = [...article.querySelectorAll('a')];
      expect(links.map((node) => node.getAttribute('href'))).toEqual([
        `${directoryHref('en')}/new`,
        directoryHref('en', { query: input.query }),
        directoryHref('en', { query: input.query, deleted: true }),
        detailHref('en', fixtureId),
        directoryHref('en', { ...input, cursor: 'next+/==' }),
        directoryHref('en', { ...input, cursor: undefined }),
      ]);
      for (const link of links.filter((link) => !link.closest('li'))) recoveryTarget(link);
      const list = article.querySelector('ul')!;
      expect(list.children).toHaveLength(1);
      expect(list.firstElementChild!.tagName).toBe('LI');
      expect(list.querySelector('li li')).toBeNull();
      const heading = list.querySelector('h2')!;
      expect(heading.lang).toBe('ja');
      expect(list.querySelector('a')!.getAttribute('aria-labelledby')).toBe(heading.id);
      const restart = links.at(-1)!;
      links.at(-2)!.focus();
      await act(async () => userEvent.tab());
      expect(window.document.activeElement).toBe(restart);
      expect(article.querySelector('nav [aria-current="page"]')!.textContent).toBe(m.ctxw_deleted({}, o));
    }
    await panel.render(
      <ContextDirectoryView locale="en" input={input} data={{ ...data, page: { kind: 'stale' } }} reload={reload} />,
    );
    expect(visibleText(panel.host)).toContain(m.ctxw_stale({}, o));
    expect(visibleText(panel.host)).not.toContain(m.ctxw_no_matches({}, o));
    for (const kind of ['signed-out', 'denied', 'missing', 'unavailable', 'stale'] as const) {
      await panel.render(
        <ContextDirectoryView locale="en" input={input} data={{ ...data, page: { kind } }} reload={reload} />,
      );
      expect(panel.host.querySelector('[role="alert"]')).not.toBeNull();
      expect(panel.host.querySelector('ul')).toBeNull();
      expect(visibleText(panel.host)).not.toContain(m.ctxw_no_matches({}, o));
      expect(
        [...panel.host.querySelectorAll('a')].some(
          (link) => link.getAttribute('href') === directoryHref('en', { ...input, cursor: undefined }),
        ),
      ).toBe(true);
    }
    const retry = button(panel.host, m.ctxw_reread({}, o));
    retry.focus();
    await act(async () => userEvent.keyboard('{Enter}'));
    expect(args).toEqual([[]]);
    expect(
      panel.host.querySelector(`a[href="${directoryHref('en', { ...input, cursor: undefined })}"]`),
    ).not.toBeNull();
  } finally {
    await panel.dispose();
  }
});

test('signed-out recovery and detail/create returns remain native exact focused links with independent creation fields', async () => {
  const panel = await mount(
    <>
      <ContextDetailView {...props()} data={{ kind: 'signed-out' }} />
      <ContextCreateView locale="en" actions={{ kind: 'ready', value: [] }} submit={denied} reload={noop} />
      <ContextCreateView locale="en" actions={{ kind: 'ready', value: [] }} submit={denied} reload={noop} />
    </>,
  );
  try {
    const links = [...panel.host.querySelectorAll('a')];
    expect(links.map((node) => node.getAttribute('href'))).toEqual([
      directoryHref('en'),
      `/auth/sign-in?return_to=${encodeURIComponent(directoryHref('en'))}`,
      directoryHref('en'),
      directoryHref('en'),
    ]);
    for (const link of links) recoveryTarget(link);
    links[0]!.focus();
    await act(async () => userEvent.tab());
    expect(window.document.activeElement).toBe(links[1]);
    const fields = [...panel.host.querySelectorAll('input, select')];
    expect(new Set(fields.map((node) => node.id)).size).toBe(4);
    for (const label of panel.host.querySelectorAll('label')) {
      const field = panel.host.querySelector(`[id="${label.htmlFor}"]`)!;
      expect(field.closest('form')).toBe(label.closest('form'));
    }
  } finally {
    await panel.dispose();
  }
});

test('confirmed creation exposes an explicit exact detail return without automatic navigation or another read', async () => {
  const fixture = contextFixture('create');
  let reads = 0;
  const panel = await mount(
    <ContextCreateView
      locale="en"
      actions={fixture.initialCreation()}
      submit={fixture.api.submit}
      reload={async () => {
        reads++;
      }}
    />,
  );
  try {
    const input = panel.host.querySelector('input')!;
    await act(async () => userEvent.type(input, 'Supplied community name'));
    await act(async () => userEvent.click(button(panel.host, m.ctxw_create({}, o))));
    expect(visibleText(panel.host)).toContain(m.ctxw_confirmed({}, o));
    const links = [...panel.host.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([directoryHref('en'), detailHref('en', fixtureId)]);
    recoveryTarget(links[1]!);
    links[1]!.focus();
    expect(window.document.activeElement).toBe(links[1]);
    expect(window.location.pathname).toBe('/en/my/contexts');
    expect(reads).toBe(0);
    expect(fixture.calls.filter((call) => call.method === 'POST' && call.path === '/v1/contexts')).toHaveLength(1);
  } finally {
    await panel.dispose();
  }
});

test('unknown and expired lifecycle results preserve exact retry commands, refusal and original explicit reload calls', async () => {
  for (const scenario of ['unknown', 'expired', 'hold'] as const) {
    const commands: Command[] = [];
    const reloads: unknown[][] = [];
    const fixture = contextFixture(scenario);
    const panel = await mount(
      <ContextDetailView
        {...props(scenario)}
        submit={async (command) => {
          commands.push(command);
          return fixture.api.submit(command);
        }}
        reload={async (...args: unknown[]) => {
          reloads.push(args);
        }}
      />,
    );
    try {
      const label = scenario === 'unknown' ? m.ctxw_delete({}, o) : m.ctxw_restore({}, o);
      await act(async () => userEvent.click(button(panel.host, label)));
      const dialog = window.document.querySelector('[role="alertdialog"]') as unknown as HTMLElement;
      expect(dialog).not.toBeNull();
      expect(dialog.textContent).toContain(
        scenario === 'unknown' ? m.ctxw_delete_help({}, o) : m.ctxw_restore_help({}, o),
      );
      await act(async () => userEvent.click(button(dialog, label)));
      expect(commands).toHaveLength(1);
      expect(visibleText(panel.host)).toContain(
        scenario === 'unknown' ? m.ctxw_unknown({}, o) : m.ctxw_conflict({}, o),
      );
      expect(panel.host.querySelector('details')).toBeNull();
      if (scenario === 'unknown') {
        const retry = button(panel.host, m.ctxw_retry_same({}, o));
        retry.focus();
        await act(async () => userEvent.keyboard('{Enter}'));
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual(commands[0]);
      } else {
        const reread = button(panel.host, m.ctxw_reread({}, o));
        reread.focus();
        await act(async () => userEvent.keyboard('{Enter}'));
        expect(reloads).toEqual([[]]);
        expect(commands).toHaveLength(1);
      }
    } finally {
      await panel.dispose();
    }
  }
});

test('all eight catalogs supply the same additive reader messages with neutral numbered labels', async () => {
  const keys = [
    'settings_selected',
    'settings_details',
    'defaults',
    'rule',
    'rule_reference',
    'property_key',
    'no_defaults',
  ]
    .map((name) => `ctx_reader_${name}`)
    .sort();
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    const catalog = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
    expect(
      Object.keys(catalog)
        .filter((key) => key.startsWith('ctx_reader_'))
        .sort(),
    ).toEqual(keys);
    expect(catalog.ctx_reader_rule).toContain('{number}');
    expect(catalog.ctx_reader_rule_reference).toContain('{number}');
    const supplied = props('read-only');
    const panel = await mount(<ContextDetailView {...supplied} locale={locale} />);
    try {
      expect(visibleText(panel.host)).toContain(catalog.ctx_reader_settings_selected);
      expect(visibleText(panel.host)).not.toContain('editorial');
      expect(panel.host.querySelectorAll('details')).toHaveLength(3);
    } finally {
      await panel.dispose();
    }
  }
});

test('personal Context departure keeps creation and delete recovery on Stay and retires it on Leave', async () => {
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import(
    '@tanstack/react-router'
  );
  const commands: Command[] = [];
  const completions: ((result: MutationResult) => void)[] = [];
  const submit = (command: Command) => {
    commands.push(command);
    return new Promise<MutationResult>((resolve) => completions.push(resolve));
  };
  const current = () => true;
  const parent = createRootRoute({
    component: () => (
      <ContextWork.Provider value={current}>
        <Outlet />
      </ContextWork.Provider>
    ),
  });
  const create = createRoute({
    getParentRoute: () => parent,
    path: '/my/contexts/new',
    component: () => (
      <ContextCreateView locale="en" actions={contextFixture().initialCreation()} submit={submit} reload={async () => {}} />
    ),
  });
  const detail = createRoute({
    getParentRoute: () => parent,
    path: '/my/contexts/$id',
    component: () => (
      <ContextDetailView
        id={fixtureId}
        locale="en"
        data={contextFixture().initialDetail()}
        submit={submit}
        reload={async () => {}}
      />
    ),
  });
  const readOnly = createRoute({
    getParentRoute: () => parent,
    path: '/my/contexts/read-only',
    component: () => (
      <ContextDetailView
        id={fixtureId}
        locale="en"
        data={contextFixture('read-only').initialDetail()}
        submit={submit}
        reload={async () => {}}
      />
    ),
  });
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => <p>Destination</p> });
  const router = createRouter({
    routeTree: parent.addChildren([create, detail, readOnly, away]),
    history: createMemoryHistory({ initialEntries: ['/my/contexts/new'] }),
  });
  await act(async () => router.load());
  const panel = await mount(<RouterProvider router={router} />);
  const go = async (to: '/away' | '/my/contexts/new' | '/my/contexts/read-only' | `/my/contexts/${string}`) =>
    act(async () => {
      void router.navigate({ to });
    });
  const click = async (target: ParentNode, label: string) => act(async () => userEvent.click(button(target, label)));
  const unloadBlocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const complete = async (index: number, result: MutationResult) =>
    act(async () => completions[index]!(result));
  try {
    let label = panel.host.querySelector('input') as HTMLInputElement;
    let language = panel.host.querySelector('select') as HTMLSelectElement;
    await act(async () => userEvent.type(label, 'temporary'));
    await act(async () => userEvent.clear(label));
    await act(async () => userEvent.selectOptions(language, 'ja'));
    await act(async () => userEvent.selectOptions(language, 'en'));
    expect(unloadBlocked()).toBe(false);
    await go('/away');
    expect(router.state.location.pathname).toBe('/away');
    await go('/my/contexts/new');
    label = panel.host.querySelector('input') as HTMLInputElement;
    language = panel.host.querySelector('select') as HTMLSelectElement;
    await act(async () => userEvent.type(label, 'Private Context'));
    await act(async () => userEvent.selectOptions(language, 'ja'));
    expect(unloadBlocked()).toBe(true);
    await go('/away');
    await click(window.document.body, m.thread_authoring_stay({}, o));
    expect([label.value, language.value, commands.length]).toEqual(['Private Context', 'ja', 0]);
    await click(panel.host, m.ctxw_create({}, o));
    const original = commands[0]!;
    const exact = structuredClone(original);
    await go('/away');
    expect(window.document.body.textContent).toContain(m.thread_authoring_leave_pending({}, o));
    await click(window.document.body, m.thread_authoring_stay({}, o));
    expect(commands).toHaveLength(1);
    expect(original).toEqual(exact);
    await complete(0, { kind: 'unknown' });
    await click(panel.host, m.ctxw_retry_same({}, o));
    expect(commands[1]).toBe(original);
    const lateCreate = completions[1]!;
    await go('/away');
    await click(window.document.body, m.thread_authoring_leave({}, o));
    expect(router.state.location.pathname).toBe('/away');
    await act(async () =>
      lateCreate({ kind: 'confirmed', operation: 'create', id: fixtureId, current: { kind: 'unavailable' } }),
    );
    expect(window.document.body.textContent).not.toContain(m.ctxw_confirmed({}, o));

    await go('/my/contexts/read-only');
    await go('/away');
    expect(router.state.location.pathname).toBe('/away');
    await go(`/my/contexts/${fixtureId}`);
    await click(panel.host, m.ctxw_delete({}, o));
    const deleteDialog = window.document.body.querySelector('[role="alertdialog"]') as HTMLElement;
    await click(deleteDialog, m.ctxw_delete({}, o));
    const deletion = commands[2]!;
    expect(deletion.operation).toBe('delete');
    await go('/away');
    await click(window.document.body, m.thread_authoring_stay({}, o));
    expect(commands[2]).toBe(deletion);
    await complete(2, { kind: 'unknown' });
    expect(unloadBlocked()).toBe(true);
    await go('/away');
    await click(window.document.body, m.thread_authoring_leave({}, o));

    await go('/my/contexts/new');
    const completedLabel = panel.host.querySelector('input') as HTMLInputElement;
    await act(async () => userEvent.type(completedLabel, 'Confirmed Context'));
    await click(panel.host, m.ctxw_create({}, o));
    await complete(3, { kind: 'confirmed', operation: 'create', id: fixtureId, current: { kind: 'unavailable' } });
    expect(unloadBlocked()).toBe(false);
    await go('/away');
    expect(router.state.location.pathname).toBe('/away');
  } finally {
    await panel.dispose();
  }
});
