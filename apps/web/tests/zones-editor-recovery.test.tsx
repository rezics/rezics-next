// UNRUN: focused, stack-free editor outcomes for later normal verification. No native/browser claim.
import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { UI_LOCALES } from '@rezics/composition';
import { zoneEditorFixture } from '../src/features/zones/editor/fixture';
import { ZoneEditorSession, type Failure, type Transport } from '../src/features/zones/editor/model';
import { EditorFailure, fieldGuidance } from '../src/features/zones/editor/error-guidance';
import { ZoneConfigurationEditor } from '../src/features/zones/editor/view';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/my/zones/example/edit' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
setLocale('en', { reload: false });
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function mounted(session: ZoneEditorSession, run: (host: HTMLDivElement) => Promise<void>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ZoneConfigurationEditor session={session} locale="en" />));
    await run(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const value = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!value) throw new Error(`Missing button: ${label}`);
  return value;
}
function correction(host: HTMLElement, field: string) {
  return button(host, m.zone_recovery_correct({ field }));
}
function withoutDiagnostics(host: HTMLElement) {
  const copy = host.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('details').forEach((details) => details.remove());
  return copy.textContent;
}

test('Zone draft navigation stays with the exact edits, allows a deliberate leave once, and is clear after save', async () => {
  const fixture = zoneEditorFixture();
  const session = new ZoneEditorSession(fixture.transport, fixture.initial);
  let arrivals = 0;
  const rootRoute = createRootRoute({ component: Outlet });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/edit',
    component: () => <ZoneConfigurationEditor session={session} locale="en" />,
  });
  const awayRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/away',
    onEnter: () => arrivals++,
    component: () => <p>Destination</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editorRoute, awayRoute]),
    history: createMemoryHistory({ initialEntries: ['/edit'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    const edited = structuredClone(session.snapshot().draft!);
    edited.configuration.pages.push({ route: 'guide', document: { root: { props: {} }, content: [] } });
    edited.configuration.scope = ['books/fiction'];
    edited.mounts = [
      fixture.initial.options.collections.kind === 'ready'
        ? fixture.initial.options.collections.value.items[0]!.id
        : '',
    ];
    await act(async () => session.edit(edited));
    const retained = session.snapshot().draft;
    await act(async () => {
      const page = host.querySelector<HTMLSelectElement>('#zone-page')!;
      page.value = '1';
      page.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(host.textContent).not.toContain(m.zone_editor_leave());
    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    expect(host.textContent).toContain(m.zone_editor_leave());
    expect(router.state.location.pathname).toBe('/edit');
    await act(async () => button(host, m.zone_editor_stay()).click());
    expect(session.snapshot().draft).toBe(retained);
    expect(arrivals).toBe(0);
    await act(async () => session.save());
    await act(async () => router.navigate({ to: '/away' }));
    expect(host.textContent).toContain('Destination');
    expect(arrivals).toBe(1);
    await act(async () => router.navigate({ to: '/edit' }));
    const discarded = structuredClone(session.snapshot().draft!);
    discarded.configuration.labels.en = 'Discard this edit';
    await act(async () => session.edit(discarded));
    await act(async () => {
      void router.navigate({ to: '/away' });
    });
    expect(host.textContent).toContain(m.zone_editor_leave());
    await act(async () => button(host, m.zone_editor_discard()).click());
    expect(router.state.location.pathname).toBe('/away');
    expect(arrivals).toBe(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Zone configuration validation identifies a readable field and reachable correction while preserving the dirty draft and current owner lifetime', async () => {
  const fixture = zoneEditorFixture();
  let current = true;
  const session = new ZoneEditorSession(fixture.transport, fixture.initial, undefined, {
    isCurrent: () => current,
    observation: { reader: 'owner', admission: 'visit' },
    retire: () => {
      current = false;
    },
  });
  const draft = structuredClone(session.snapshot().draft!);
  draft.configuration.primaryLanguage = 'en';
  draft.configuration.labels.de = '';
  draft.configuration.scope = ['unavailable/filter'];
  draft.configuration.pages.push({
    route: 'subjects/guide',
    document: {
      root: { props: {} },
      content: [{ type: 'UnknownBlock', props: { id: 'bad' } }],
    },
  });
  session.edit(draft);
  await session.save();
  const retained = session.snapshot().draft;
  await mounted(session, async (host) => {
    expect(document.activeElement?.id).toBe('zone-validation');
    expect(withoutDiagnostics(host)).not.toContain('/pages/1/route');
    const technical = [...host.querySelectorAll('details')].find(
      (item) => item.querySelector('summary')?.textContent === m.zone_recovery_details(),
    )!;
    expect(technical.open).toBe(false);
    await act(async () => correction(host, m.zone_recovery_route({ page: 2 })).click());
    expect((host.querySelector('#zone-page') as HTMLSelectElement).value).toBe('1');
    expect(document.activeElement?.id).toBe('zone-route');
    const route = host.querySelector('#zone-route')!;
    expect(route.getAttribute('aria-invalid')).toBe('true');
    const described = route
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toContain(m.zone_editor_route_help());
    expect(described).not.toContain('/pages/1/route');
    await act(async () => correction(host, m.zone_recovery_document({ page: 2 })).click());
    expect(document.activeElement?.id).toBe('zone-compose');
    expect(host.querySelector('#zone-compose')?.getAttribute('aria-expanded')).toBe('false');
    const translation = host.querySelector('#zone-label-de')!.closest('details')!;
    translation.open = false;
    await act(async () => correction(host, m.zone_recovery_name({ language: 'German' })).click());
    expect(translation.open).toBe(true);
    expect(document.activeElement?.id).toBe('zone-label-de');
    await act(async () => correction(host, m.zone_editor_scopes()).click());
    expect(document.activeElement?.id).toBe('zone-scopes');
    expect(session.snapshot().draft).toBe(retained);
    expect(session.dirty()).toBe(true);
    expect(fixture.calls).toHaveLength(0);
    // Retirement between the correction event and the mounted-focus effect fences that effect.
    await act(async () => {
      correction(host, m.zone_recovery_route({ page: 2 })).click();
      current = false;
    });
    expect(document.activeElement?.id).not.toBe('zone-route');
    expect(session.snapshot().draft).toBe(retained);
    expect(fixture.calls).toHaveLength(0);
  });
});

test('Denied conflict unavailable and unknown failures keep their actual consequences and technical details without presenting raw codes as the main explanation', () => {
  const fixture = zoneEditorFixture();
  const draft = new ZoneEditorSession(fixture.transport, fixture.initial).snapshot().draft;
  for (const locale of UI_LOCALES) {
    const options = { locale };
    for (const [failure, context, expected] of [
      [{ kind: 'failure', status: 403, code: 'forbidden' }, 'save', m.zone_editor_denied({}, options)],
      [{ kind: 'failure', status: 412, code: 'precondition_failed' }, 'save', m.zone_editor_conflict({}, options)],
      [
        { kind: 'failure', status: 503, code: 'semantic_not_ready', retryAfter: '17' },
        'preview',
        m.zone_recovery_source({}, options),
      ],
      [
        { kind: 'failure', status: 502, code: 'future_zone_outcome', retryAfter: '17' },
        'save',
        m.zone_recovery_save_unknown({}, options),
      ],
      [
        { kind: 'failure', status: 502, code: 'future_zone_outcome' },
        'publish',
        m.zone_recovery_publish_unknown({}, options),
      ],
      [{ kind: 'failure', status: 503, code: 'dependency_unavailable' }, 'read', m.zone_recovery_read({}, options)],
    ] as const) {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(<EditorFailure failure={failure} context={context} locale={locale} />);
      expect(withoutDiagnostics(host)).toContain(expected);
      expect(withoutDiagnostics(host)).not.toContain(failure.code);
      const details = host.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(details.textContent).toContain(`${failure.status} · ${failure.code}`);
      if ('retryAfter' in failure)
        expect(withoutDiagnostics(host)).toContain(m.zone_editor_retry_after({ seconds: '17' }, options));
      if (context === 'preview') expect(withoutDiagnostics(host)).toContain(m.zone_recovery_preview({}, options));
    }
    const failure: Failure = {
      kind: 'failure',
      status: 400,
      code: 'invalid_request',
      errors: [
        { pointer: '/configuration/labels/en', code: 'invalid_format' },
        { pointer: '/configuration/private~1payload~0value', code: 'unknown_field' },
      ],
    };
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<EditorFailure failure={failure} draft={draft} locale={locale} />);
    expect(withoutDiagnostics(host)).toContain(
      m.zone_recovery_name({ language: new Intl.DisplayNames([locale], { type: 'language' }).of('en')! }, options),
    );
    expect(withoutDiagnostics(host)).not.toContain('private');
    expect(host.querySelector('details')?.textContent).toContain('/configuration/private~1payload~0value');
  }
});

test('API and local pointers reach only established existing targets, preserving exact escaped diagnostics', () => {
  const fixture = zoneEditorFixture();
  const draft = new ZoneEditorSession(fixture.transport, fixture.initial).snapshot().draft!;
  for (const pointer of ['/labels/en', '/configuration/labels/en'])
    expect(fieldGuidance({ pointer, code: 'invalid' }, draft, 'en').target?.id).toBe('zone-label-en');
  expect(fieldGuidance({ pointer: '/primaryLanguage', code: 'invalid' }, draft, 'en').target?.id).toBe(
    'zone-primary-language',
  );
  expect(fieldGuidance({ pointer: '/mounts', code: 'limit' }, draft, 'en').target?.id).toBe('zone-mounts');
  expect(fieldGuidance({ pointer: '/visibility', code: 'invalid_format' }, draft, 'en').target?.id).toBe(
    'zone-visibility',
  );
  draft.configuration.pages[0]!.document.root.props['a/b~c'] = 'Retained draft value';
  expect(
    fieldGuidance(
      { pointer: '/configuration/pages/0/document/root/props/a~1b~0c', code: 'invalid_format' },
      draft,
      'en',
    ).target?.id,
  ).toBe('zone-compose');
  for (const pointer of [
    '/configuration/mounts',
    '/configuration/configuration/labels/en',
    '/labels/unknown',
    '/labels/en~2',
    '/pages/01/route',
    '/pages/16/route',
    '/pages/0/document/secret',
    '/pages/0/document/content/0/type/secret',
    '/scope/16',
    '/mounts/16',
    '#/labels/en',
    '/configuration/labels/en%2Fsecret',
  ])
    expect(fieldGuidance({ pointer, code: 'invalid_format' }, draft, 'en').target).toBeUndefined();
});

test('correction preserves a conflict and cannot focus a removed page or a replaced generation', async () => {
  const fixture = zoneEditorFixture();
  const transport: Transport = {
    ...fixture.transport,
    mutate: async () => ({
      kind: 'failure',
      status: 412,
      code: 'precondition_failed',
      errors: [
        { pointer: '/configuration/pages/1/document', code: 'invalid_format' },
        { pointer: '/configuration/pages/9/route', code: 'invalid_format' },
      ],
    }),
  };
  const session = new ZoneEditorSession(transport, fixture.initial);
  const draft = structuredClone(session.snapshot().draft!);
  draft.configuration.pages.push({ route: 'guide', document: { root: { props: {} }, content: [] } });
  session.edit(draft);
  fixture.externalChange();
  await session.save();
  const conflict = session.snapshot().conflict;
  const retained = session.snapshot().draft;
  await mounted(session, async (host) => {
    expect(host.textContent).toContain(m.zone_recovery_generic());
    expect(host.textContent).not.toContain(m.zone_recovery_correct({ field: m.zone_recovery_route({ page: 10 }) }));
    await act(async () => correction(host, m.zone_recovery_document({ page: 2 })).click());
    expect((host.querySelector('#zone-page') as HTMLSelectElement).value).toBe('1');
    expect(host.querySelector('#zone-compose')?.getAttribute('aria-expanded')).toBe('false');
    expect(session.snapshot().conflict).toBe(conflict);
    expect(session.snapshot().draft).toBe(retained);
    expect(button(host, m.zone_editor_reload()).disabled).toBe(false);
    expect(button(host, m.zone_editor_reapply()).disabled).toBe(false);
    await act(async () => {
      correction(host, m.zone_recovery_document({ page: 2 })).click();
      session.resolve('reload');
    });
    expect(session.snapshot().generation).toBe(1);
    expect(session.snapshot().draft?.configuration.pages).toHaveLength(1);
    expect(document.activeElement?.id).not.toBe('zone-compose');
    expect(host.querySelector('#zone-compose')?.getAttribute('aria-expanded')).toBe('false');
  });
});

test('lifecycle conflict keeps the independent draft against the newly read head', async () => {
  const fixture = zoneEditorFixture();
  const initial = structuredClone(fixture.initial);
  if (initial.resource.kind === 'ready') {
    initial.resource.value.zone.deletedAt = '2026-11-06T00:00:00.000Z';
    initial.resource.value.zone.restoreUntil = '2026-12-06T00:00:00.000Z';
  }
  const transport: Transport = {
    ...fixture.transport,
    lifecycle: async () => ({ kind: 'failure', status: 412, code: 'precondition_failed' }),
  };
  const session = new ZoneEditorSession(transport, initial);
  const draft = structuredClone(session.snapshot().draft!);
  draft.configuration.labels.en = 'Independent draft';
  session.edit(draft);
  const retained = session.snapshot().draft;
  fixture.externalChange();
  await session.changeLifecycle('restore');
  expect(session.snapshot().draft).toBe(retained);
  expect(session.dirty()).toBe(true);
  expect(session.snapshot().conflict?.resource.kind).toBe('ready');
  expect(session.snapshot().saved?.configuration.labels.en).not.toBe('Independent draft');
});

test('removing a page before mounted correction focus never selects another page at its former index', async () => {
  const fixture = zoneEditorFixture();
  const session = new ZoneEditorSession(fixture.transport, fixture.initial);
  const draft = structuredClone(session.snapshot().draft!);
  draft.configuration.pages.push({ route: 'subjects/guide', document: { root: { props: {} }, content: [] } });
  session.edit(draft);
  await session.save();
  await mounted(session, async (host) => {
    await act(async () => {
      correction(host, m.zone_recovery_route({ page: 2 })).click();
      const changed = structuredClone(session.snapshot().draft!);
      changed.configuration.pages.splice(1, 1);
      session.edit(changed);
    });
    expect(document.activeElement?.id).not.toBe('zone-route');
    expect(session.snapshot().draft?.configuration.pages).toHaveLength(1);
    expect(fixture.calls).toHaveLength(0);
  });
});
