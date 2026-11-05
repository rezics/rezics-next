// UNRUN: actual mounted creation family. DOM assertions are not browser geometry or native proof.
// Cost: supplied eight starters / at most eight authored names; zero reads, one POST per
// deliberate submit/retry, no refill, per-row enrichment or whole-population traversal.
import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute as defineRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { pickText, pickZoneName, UI_LOCALES } from '@rezics/composition';
import type { CreateProps } from '../src/features/zones/manage/create';
import type { CommandOutcome, CreateCommand } from '../src/features/zones/manage/model';
import type { OwnerCapture } from '../src/features/zones/editor/owner-lifetime';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/my/zones/new' });
const frames: FrameRequestCallback[] = [];
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  cancelAnimationFrame: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, notifyManager } = await import('@tanstack/react-query');
const { OwnerLifetime } = await import('../src/features/zones/editor/owner-lifetime');
const { sessionQuery } = await import('../src/session/query');
const { CreateZone } = await import('../src/features/zones/manage/create');
const { copyStarter, starterChoices } = await import('../src/features/zones/manage/starters');
const { createOwnedZone } = await import('../src/features/zones/manage/request');
const { fixtureZone, fixtureZoneId, zonesFixture } = await import('../src/features/zones/manage/fixtures');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const settle = async (action: () => void | Promise<void>) =>
  act(async () => {
    await action();
  });
const focusFrame = () =>
  settle(() => {
    for (const callback of frames.splice(0)) callback(0);
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function mount(props: Partial<CreateProps> = {}) {
  const native = zonesFixture();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const navigations: string[] = [];
  const input: CreateProps = {
    locale: 'en',
    session: 'signed-in',
    onCreate: native.create,
    onNavigate: (href) => {
      navigations.push(href);
    },
    ...props,
  };
  await settle(() => root.render(<CreateZone {...input} />));
  return {
    host,
    native,
    navigations,
    render: (next: Partial<CreateProps>) => settle(() => root.render(<CreateZone {...input} {...next} />)),
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
      frames.length = 0;
    },
  };
}
async function mountRouted(props: Partial<CreateProps> = {}) {
  const native = zonesFixture();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const arrivals: string[] = [];
  const navigations: string[] = [];
  const input: CreateProps = {
    locale: 'en',
    session: 'signed-in',
    onCreate: native.create,
    onNavigate: (href) => navigations.push(href),
    ...props,
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const createRoute = defineRoute({
    getParentRoute: () => rootRoute,
    path: '/create',
    component: () => <CreateZone {...input} />,
  });
  const awayRoute = defineRoute({
    getParentRoute: () => rootRoute,
    path: '/away',
    onEnter: () => arrivals.push('/away'),
    component: () => <p>Destination</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute, awayRoute]),
    history: createMemoryHistory({ initialEntries: ['/create'] }),
  });
  await router.load();
  await settle(() => root.render(<RouterProvider router={router} />));
  return {
    host,
    native,
    router,
    arrivals,
    navigations,
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
      frames.length = 0;
    },
  };
}
function byLabel<T extends HTMLInputElement | HTMLSelectElement>(host: HTMLElement, text: string): T {
  const label = [...host.querySelectorAll('label')].find((item) => item.textContent?.trim() === text);
  if (!label) throw new Error(`Missing label: ${text}`);
  const control = [...host.querySelectorAll<T>('input, select')].find((item) => item.id === label.htmlFor);
  if (!control) throw new Error(`Missing own control: ${text}`);
  return control;
}
function starter(host: HTMLElement, locale = 'en') {
  return byLabel<HTMLSelectElement>(host, m.zones_create_starter({}, { locale: locale as never }));
}
function button(host: HTMLElement, text: string) {
  const control = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  if (!control) throw new Error(`Missing button: ${text}`);
  return control;
}
function change(control: HTMLInputElement | HTMLSelectElement, value: string) {
  control.value = value;
  control.dispatchEvent(new window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
const choose = (host: HTMLElement, value = 'book', locale = 'en') => settle(() => change(starter(host, locale), value));
const name = (host: HTMLElement, value: string, locale = 'en') =>
  settle(() => change(byLabel<HTMLInputElement>(host, m.zone_name_primary({}, { locale: locale as never })), value));
const submit = (host: HTMLElement, locale = 'en') =>
  settle(() => button(host, m.zones_create_submit({}, { locale: locale as never })).click());
function association(host: HTMLElement, locale: string) {
  const control = starter(host, locale);
  const label = [...host.querySelectorAll('label')].find((item) => item.htmlFor === control.id)!;
  expect(label.control).toBe(control);
  expect(document.getElementById(label.htmlFor)).toBe(control);
  const help = document.getElementById(control.getAttribute('aria-describedby')!)!;
  expect(host.contains(help)).toBe(true);
  expect(help.textContent).toBe(m.zones_create_starter_help({}, { locale: locale as never }));
  expect(control.tagName).toBe('SELECT');
  expect(control.tabIndex).toBe(0);
  return { label, control, help };
}

// Two separate React roots, not merely two siblings under a single useId root.
test('independent visits associate only their own localized starter label/help and focus their own required selection', async () => {
  const first = await mount();
  const second = await mount({ locale: 'de' });
  try {
    const a = association(first.host, 'en');
    const b = association(second.host, 'de');
    expect(a.control.id).not.toBe(b.control.id);
    expect(a.help.id).not.toBe(b.help.id);
    expect(first.host.querySelector('form')?.noValidate).toBe(true);
    expect(second.host.querySelector('form')?.noValidate).toBe(true);
    expect(first.host.querySelectorAll('input')).toHaveLength(0);
    await submit(second.host, 'de');
    expect(document.activeElement).toBe(b.control);
    expect(b.control.getAttribute('aria-invalid')).toBe('true');
    expect(a.control.getAttribute('aria-invalid')).toBe('false');
    await choose(first.host);
    await name(first.host, 'My own notes');
    await choose(second.host, 'visual-novel', 'de');
    await name(second.host, 'Meine eigenen langen Aufzeichnungen', 'de');
    await choose(first.host, 'game');
    expect(byLabel<HTMLInputElement>(first.host, m.zone_name_primary()).value).toBe('My own notes');
    expect(byLabel<HTMLInputElement>(second.host, m.zone_name_primary({}, { locale: 'de' })).value).toBe(
      'Meine eigenen langen Aufzeichnungen',
    );
    expect(first.native.calls).toHaveLength(0);
    expect(second.native.calls).toHaveLength(0);
    await submit(first.host);
    expect(first.native.calls).toHaveLength(1);
    expect(second.native.calls).toHaveLength(0);
    expect(first.native.calls[0]!.body).toEqual({
      configuration: { ...copyStarter('game'), labels: { en: 'My own notes' }, primaryLanguage: 'en' },
      mounts: [],
      visibility: 'private',
    });
    await submit(second.host, 'de');
    expect(second.native.calls[0]!.body).toEqual({
      configuration: {
        ...copyStarter('visual-novel'),
        labels: { de: 'Meine eigenen langen Aufzeichnungen' },
        primaryLanguage: 'de',
      },
      mounts: [],
      visibility: 'private',
    });
    expect(first.navigations).toEqual([`/en/my/zones/${fixtureZoneId}/edit`]);
    expect(second.navigations).toEqual([`/de/my/zones/${fixtureZoneId}/edit`]);
    for (const [visit, locale] of [
      [first, 'en'],
      [second, 'de'],
    ] as const) {
      const links = [...visit.host.querySelectorAll('a')];
      const configure = links.find((link) => link.textContent === m.zones_owner_configure({}, { locale }))!;
      const open = links.find((link) => link.textContent === m.zones_owner_open({}, { locale }))!;
      expect(configure.getAttribute('href')).toBe(`/${locale}/my/zones/${fixtureZoneId}/edit`);
      expect(open.getAttribute('href')).toBe(`/${locale}/zones/${fixtureZoneId}`);
      configure.focus();
      expect(document.activeElement).toBe(configure);
      open.focus();
      expect(document.activeElement).toBe(open);
      expect(visit.host.textContent).toContain(m.zones_create_reader_help({}, { locale }));
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test('primary language and optional translations preserve authored drafts, reveal invalid translations, and never copy starter names', async () => {
  const visit = await mount();
  try {
    await choose(visit.host);
    const primary = () => byLabel<HTMLInputElement>(visit.host, m.zone_name_primary());
    expect(primary().value).toBe('');
    expect(primary().required).toBe(true);
    expect(visit.host.querySelectorAll('input')).toHaveLength(1);
    for (const invalid of ['', ' ', '<script>', 'x'.repeat(81)]) {
      await name(visit.host, invalid);
      await submit(visit.host);
      await focusFrame();
      expect(primary().getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
      expect(visit.host.querySelector('[role="alert"]')?.textContent).toContain(m.zones_owner_invalid());
      expect(visit.native.calls).toHaveLength(0);
    }
    await name(visit.host, 'English authored name');
    await settle(() => change(byLabel(visit.host, m.zone_name_language()), 'ja'));
    expect(primary().value).toBe('');
    expect(primary().lang).toBe('ja');
    await name(visit.host, '私の本棚');
    await choose(visit.host, 'manga');
    expect(primary().value).toBe('私の本棚');
    const details = visit.host.querySelector('details')!;
    await settle(() => {
      details.open = true;
      change(byLabel(visit.host, m.zone_name_add()), 'de');
    });
    const german = new Intl.DisplayNames(['en'], { type: 'language' }).of('de')!;
    expect(byLabel<HTMLInputElement>(visit.host, german).value).toBe('');
    details.open = false;
    await submit(visit.host);
    expect(details.open).toBe(true);
    expect(byLabel(visit.host, german).getAttribute('aria-invalid')).toBe('true');
    expect(visit.native.calls).toHaveLength(0);
    await settle(() => button(visit.host, m.zone_name_remove({ language: german })).click());
    await settle(() => change(byLabel(visit.host, m.zone_name_language()), 'en'));
    expect(primary().value).toBe('English authored name');
    await settle(() => change(byLabel(visit.host, m.zone_name_language()), 'ja'));
    await submit(visit.host);
    expect(visit.native.calls).toHaveLength(1);
    const labels = { en: 'English authored name', ja: '私の本棚' };
    expect(visit.native.calls[0]!.body).toEqual({
      configuration: { ...copyStarter('manga'), primaryLanguage: 'ja', labels },
      mounts: [],
      visibility: 'private',
    });
    expect(pickZoneName({ primaryLanguage: 'ja', labels }, 'fr')).toEqual({ text: '私の本棚', lang: 'ja' });
    expect(copyStarter('manga')!.labels).not.toEqual(labels);
  } finally {
    await visit.close();
  }
});

test('creation departure keeps the multilingual draft on Stay, leaves once on choice, and ignores an empty reverted starter', async () => {
  const visit = await mountRouted();
  try {
    await choose(visit.host);
    await name(visit.host, 'My shelf');
    const german = new Intl.DisplayNames(['en'], { type: 'language' }).of('de')!;
    await settle(() => change(byLabel(visit.host, m.zone_name_add()), 'de'));
    await settle(() => change(byLabel(visit.host, german), 'Mein Regal'));
    await settle(() => change(byLabel<HTMLSelectElement>(visit.host, m.zone_name_language()), 'de'));
    const unload = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await settle(() => void visit.router.navigate({ to: '/away' }));
    expect(visit.host.textContent).toContain(m.zone_editor_leave());
    await settle(() => button(visit.host, m.zone_editor_stay()).click());
    expect([
      starter(visit.host).value,
      byLabel<HTMLInputElement>(visit.host, m.zone_name_primary()).value,
      byLabel<HTMLInputElement>(visit.host, 'English').value,
      byLabel<HTMLSelectElement>(visit.host, m.zone_name_language()).value,
    ]).toEqual(['book', 'Mein Regal', 'My shelf', 'de']);

    await settle(() => void visit.router.navigate({ to: '/away' }));
    await settle(() => button(visit.host, m.zone_editor_discard()).click());
    expect(visit.arrivals).toHaveLength(1);

    await settle(() => void visit.router.navigate({ to: '/create' }));
    await choose(visit.host);
    await choose(visit.host, '');
    await settle(() => void visit.router.navigate({ to: '/away' }));
    expect(visit.host.textContent).not.toContain(m.zone_editor_leave());
    expect(visit.arrivals).toHaveLength(2);

    await settle(() => void visit.router.navigate({ to: '/create' }));
    await choose(visit.host);
    await name(visit.host, 'Confirmed site');
    await submit(visit.host);
    expect(visit.navigations).toHaveLength(1);
    expect(visit.host.textContent).not.toContain(m.zone_editor_leave());
  } finally {
    await visit.close();
  }
});

test('an unresolved create warns on departure and Stay keeps the sealed command for an exact retry', async () => {
  const first = deferred<CommandOutcome>();
  const second = deferred<CommandOutcome>();
  const commands: CreateCommand[] = [];
  const visit = await mountRouted({
    onCreate: (command) => {
      commands.push(structuredClone(command));
      return commands.length === 1 ? first.promise : second.promise;
    },
  });
  try {
    await choose(visit.host);
    await name(visit.host, 'Pending creation');
    await submit(visit.host);
    await settle(() => void visit.router.navigate({ to: '/away' }));
    expect(visit.host.textContent).toContain(m.zone_editor_leave());
    expect(visit.host.textContent).toContain(m.zones_create_uncertain());
    await settle(() => button(visit.host, m.zone_editor_stay()).click());

    first.resolve({ kind: 'unavailable' });
    await settle(async () => first.promise);
    await settle(() => button(visit.host, m.zones_owner_retry()).click());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);

    await settle(() => void visit.router.navigate({ to: '/away' }));
    expect(visit.host.textContent).toContain(m.zones_create_uncertain());
    await settle(() => button(visit.host, m.zone_editor_discard()).click());
    expect(visit.router.state.location.pathname).toBe('/away');
    expect(visit.arrivals).toHaveLength(1);
    expect(commands).toHaveLength(2);
    second.resolve({ kind: 'saved', zone: fixtureZone });
    await settle(async () => second.promise);
    expect(visit.navigations).toHaveLength(0);
    expect(visit.arrivals).toHaveLength(1);
  } finally {
    await visit.close();
  }
});

const csrfA = 'AAAAAAAAAAAAAAAAAAAAAA';
const csrfB = 'BBBBBBBBBBBBBBBBBBBBBB';
function owned() {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'A', csrfToken: csrfA });
  const owner = new OwnerLifetime(client, '/en/my/zones/new');
  return { client, owner };
}
function sender(native: ReturnType<typeof zonesFixture>) {
  const calls: { command: CreateCommand; capture: OwnerCapture }[] = [];
  const run: CreateProps['onCreate'] = async (command, capture) => {
    if (!capture) throw new Error('Missing original admission');
    calls.push({ command: structuredClone(command), capture });
    const env = {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'site',
      WEBSITE_CLIENT_KEY: '{}',
      SESSIONS: {
        idFromName: (id: string) => id,
        get: () => ({
          credential: async () => ({
            status: 'active',
            accessToken: 'original-access',
            subject: 'A',
            csrfToken: csrfA,
          }),
        }),
      },
    } as never;
    return createOwnedZone(
      native.client,
      new Request('https://site.test/action', {
        method: 'POST',
        headers: {
          cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
          origin: 'https://site.test',
          'X-CSRF-Token': capture.csrfToken ?? '',
        },
      }),
      env,
      command,
      capture.observation,
    );
  };
  return { calls, run };
}

test('uncertain retry freezes the exact original body/key/credential/admission and saved links remain independent', async () => {
  const native = zonesFixture('uncertain');
  const { client, owner } = owned();
  const send = sender(native);
  const visit = await mount({ owner, onCreate: send.run });
  try {
    await choose(visit.host);
    await name(visit.host, 'Original request');
    await submit(visit.host);
    await focusFrame();
    expect(visit.host.textContent).toContain(m.zones_create_uncertain());
    expect(starter(visit.host).disabled).toBe(true);
    expect(visit.host.querySelector('fieldset')?.disabled).toBe(true);
    expect(button(visit.host, m.zones_create_submit()).disabled).toBe(true);
    expect(send.calls).toHaveLength(1);
    expect(native.calls).toHaveLength(1);
    await settle(() => client.setQueryData(['unrelated'], 'healthy'));
    await settle(() => button(visit.host, m.zones_owner_retry()).click());
    expect(send.calls).toHaveLength(2);
    expect(send.calls[1]!.command).toEqual(send.calls[0]!.command);
    expect(send.calls[1]!.capture).toBe(send.calls[0]!.capture);
    expect(send.calls[1]!.capture.csrfToken).toBe(csrfA);
    expect(native.calls[1]).toEqual(native.calls[0]);
    expect(native.calls[1]!.authorization).toBe('Bearer original-access');
    expect(native.calls[1]!.body).toEqual({
      configuration: { ...copyStarter('book'), primaryLanguage: 'en', labels: { en: 'Original request' } },
      mounts: [],
      visibility: 'private',
    });
    expect(visit.navigations).toEqual([`/en/my/zones/${fixtureZoneId}/edit`]);
  } finally {
    await visit.close();
    client.clear();
  }
});

test('conflict review unlocks the retained draft, focuses its own starter and allocates only an explicit new command', async () => {
  const native = zonesFixture('conflict');
  const visit = await mount({ onCreate: native.create });
  try {
    await choose(visit.host);
    await name(visit.host, 'Keep this draft');
    await submit(visit.host);
    expect(visit.host.querySelector('[role="alert"]')?.textContent).toContain(m.zones_owner_conflict());
    expect(starter(visit.host).disabled).toBe(true);
    expect(native.calls).toHaveLength(1);
    await settle(() => button(visit.host, m.zones_create_review()).click());
    expect(document.activeElement).toBe(starter(visit.host));
    expect(starter(visit.host).disabled).toBe(false);
    expect(byLabel<HTMLInputElement>(visit.host, m.zone_name_primary()).value).toBe('Keep this draft');
    expect(visit.host.querySelector('[role="alert"]')).toBeNull();
    expect(native.calls).toHaveLength(1);
    await submit(visit.host);
    expect(native.calls).toHaveLength(2);
    expect(native.calls[1]!.key).not.toBe(native.calls[0]!.key);
    expect(native.calls[1]!.body).toEqual(native.calls[0]!.body);
  } finally {
    await visit.close();
  }
});

for (const session of ['unknown', 'signed-out', 'unavailable'] as const) {
  test(`initial ${session} is distinct from an empty unselected creation form`, async () => {
    const visit = await mount({ session });
    try {
      expect(visit.host.querySelector('form')).toBeNull();
      expect(visit.native.calls).toHaveLength(0);
      expect(visit.host.textContent).toContain(
        session === 'unknown'
          ? m.zones_owner_loading()
          : session === 'signed-out'
            ? m.zones_owner_signed_out()
            : m.zones_owner_unavailable(),
      );
      if (session === 'signed-out')
        expect(visit.host.querySelector('a[href^="/auth/sign-in"]')?.getAttribute('href')).toBe(
          '/auth/sign-in?return_to=%2Fen%2Fmy%2Fzones%2Fnew',
        );
      expect(visit.host.querySelector('[role="alert"]') !== null).toBe(session !== 'unknown');
    } finally {
      await visit.close();
    }
  });
}
for (const scenario of ['denied', 'actor', 'closed', 'missing', 'invalid', 'unavailable'] as const) {
  test(`native ${scenario} keeps its supplied consequence and draft without claiming creation`, async () => {
    const native = zonesFixture(scenario);
    const visit = await mount({ onCreate: native.create });
    try {
      await choose(visit.host);
      await name(visit.host, 'Retained name');
      await submit(visit.host);
      const messages = {
        denied: m.zones_owner_denied,
        actor: m.zones_owner_actor,
        closed: m.zones_owner_closed,
        missing: m.zones_owner_missing,
        invalid: m.zones_owner_invalid,
        unavailable: m.zones_owner_unavailable,
      };
      expect(visit.host.querySelector('[role="alert"]')?.textContent).toContain(messages[scenario]());
      expect(byLabel<HTMLInputElement>(visit.host, m.zone_name_primary()).value).toBe('Retained name');
      expect(visit.host.textContent).not.toContain(m.zones_create_saved());
      expect(visit.navigations).toHaveLength(0);
      expect(native.calls).toHaveLength(1);
      expect(starter(visit.host).disabled).toBe(scenario === 'unavailable');
    } finally {
      await visit.close();
    }
  });
}

test('saving remains busy and a missing CSRF credential cannot submit', async () => {
  const pending = deferred<CommandOutcome>();
  let calls = 0;
  const visit = await mount({
    onCreate: () => {
      calls++;
      return pending.promise;
    },
  });
  try {
    await choose(visit.host);
    await name(visit.host, 'Pending');
    await submit(visit.host);
    expect(calls).toBe(1);
    expect(visit.host.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    expect(button(visit.host, m.zones_owner_working()).disabled).toBe(true);
    pending.resolve({ kind: 'denied' });
    await settle(async () => {
      await pending.promise;
    });
    expect(visit.host.querySelector('form')?.getAttribute('aria-busy')).toBe('false');
  } finally {
    await visit.close();
  }
  const { client, owner } = owned();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'A', csrfToken: null });
  const noCredential = await mount({ owner });
  try {
    await choose(noCredential.host);
    await name(noCredential.host, 'Cannot send');
    expect(button(noCredential.host, m.zones_create_submit()).disabled).toBe(true);
    expect(noCredential.native.calls).toHaveLength(0);
  } finally {
    await noCredential.close();
    client.clear();
  }
});

// Retain the actual pre-retirement React event closure, including the synchronous
// cache-change window before React has rendered the replacement visit.
function retainedSubmit(host: HTMLElement) {
  const form = host.querySelector('form')!;
  const key = Object.keys(form).find((value) => value.startsWith('__reactProps$'))!;
  const callback = Reflect.get(form, key).onSubmit;
  return () => callback({ preventDefault() {} });
}
for (const retirement of ['end', 'aba', 'response-aba'] as const) {
  test(`original create cannot navigate, focus or regain authority after ${retirement}`, async () => {
    const { client, owner } = owned();
    const old = owner.capture()!;
    const pending = deferred<CommandOutcome>();
    let calls = 0;
    const visit = await mount({
      owner,
      onCreate: () => {
        calls++;
        return pending.promise;
      },
    });
    try {
      await choose(visit.host);
      await name(visit.host, 'Retire this private draft');
      const submitAgain = retainedSubmit(visit.host);
      await submit(visit.host);
      await settle(() => {
        if (retirement === 'end') owner.end();
        else if (retirement === 'aba')
          notifyManager.batch(() => {
            const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true })!;
            const original = query.state;
            query.setState({ data: { state: 'signed-in', subject: 'B', csrfToken: csrfB } });
            query.setState(original);
          });
        submitAgain();
      });
      pending.resolve({
        kind: 'saved',
        zone: fixtureZone(),
        ownerObservation:
          retirement === 'response-aba'
            ? { ...old.observation, admission: `0:0:${crypto.randomUUID()}` }
            : old.observation,
      });
      await settle(async () => {
        await pending.promise;
      });
      await focusFrame();
      expect(owner.isCurrent(old)).toBe(false);
      expect(calls).toBe(1);
      expect(visit.navigations).toHaveLength(0);
      expect(visit.host.textContent).not.toContain(m.zones_create_saved());
      expect(visit.host.querySelector<HTMLInputElement>('input')?.value).not.toBe('Retire this private draft');
      if (retirement !== 'aba') {
        // An ended/response-retired owner cannot renew itself from the same session.
        expect(owner.capture()).toBeNull();
        await settle(submitAgain);
        expect(calls).toBe(1);
      } else {
        // A new visit is usable but has neither the old command nor draft.
        expect(starter(visit.host).value).toBe('');
        expect(owner.capture()?.observation.admission).not.toBe(old.observation.admission);
      }
    } finally {
      await visit.close();
      client.clear();
    }
  });
}

test('all supplied locales retain complete starter/help text and actual bounded option language/direction', async () => {
  for (const locale of UI_LOCALES) {
    const visit = await mount({ locale });
    visit.host.dir = 'rtl';
    try {
      const { control, help } = association(visit.host, locale);
      expect(control.options.length).toBe(starterChoices.length + 1);
      for (const choice of starterChoices) {
        const option = [...control.options].find((item) => item.value === choice.id)!;
        const picked = pickText(choice.labels, locale);
        expect(option.textContent).toBe(picked.text);
        expect(option.lang).toBe(picked.lang);
        expect(option.dir).toBe('auto');
      }
      expect(help.textContent).toBe(m.zones_create_starter_help({}, { locale }));
      expect(visit.host.textContent).toContain(m.zones_create_visibility({}, { locale }));
      expect(visit.host.querySelector('a')?.getAttribute('href')).toBe(`/${locale}/my/zones`);
      expect(visit.native.calls).toHaveLength(0);
    } finally {
      await visit.close();
    }
  }
  expect(pickText({ ja: '私の本棚' }, 'fr')).toEqual({ text: '私の本棚', lang: 'ja' });
});

test('supplied name growth at 1/8/32 characters and 1/4/8 languages adds no IO or hidden traversal', async () => {
  // Eight is the actual closed language/starter set, not an invented backend cap.
  for (const [count, length] of [
    [1, 1],
    [4, 8],
    [8, 32],
  ] as const) {
    const visit = await mount();
    try {
      await choose(visit.host);
      await name(visit.host, '名'.repeat(length));
      const details = visit.host.querySelector('details')!;
      details.open = true;
      for (const language of UI_LOCALES.slice(1, count)) {
        await settle(() => change(byLabel(visit.host, m.zone_name_add()), language));
        const label = new Intl.DisplayNames(['en'], { type: 'language' }).of(language)!;
        await settle(() => change(byLabel(visit.host, label), '名'.repeat(length)));
      }
      expect(visit.host.querySelectorAll('input')).toHaveLength(count);
      expect(starter(visit.host).options.length).toBe(9);
      expect(visit.native.calls).toHaveLength(0);
      await choose(visit.host, 'game');
      await submit(visit.host);
      expect(visit.native.calls).toHaveLength(1);
      expect(visit.native.calls[0]!.method).toBe('POST');
      expect(visit.native.calls[0]!.path).toBe('/v1/zones');
      expect(visit.native.calls[0]!.body).toEqual({
        configuration: {
          ...copyStarter('game'),
          primaryLanguage: 'en',
          labels: Object.fromEntries(UI_LOCALES.slice(0, count).map((language) => [language, '名'.repeat(length)])),
        },
        mounts: [],
        visibility: 'private',
      });
    } finally {
      await visit.close();
    }
  }
});

test('a thrown delivery keeps an immutable uncertain command for an explicit retry', async () => {
  const commands: CreateCommand[] = [];
  const visit = await mount({
    onCreate: async (input) => {
      commands.push(structuredClone(input));
      // Transport mutation cannot alter the page's retained original.
      input.labels.en = 'Transport-local mutation';
      if (commands.length === 1) throw new Error('Response lost');
      return { kind: 'saved', zone: fixtureZone() };
    },
  });
  try {
    await choose(visit.host);
    await name(visit.host, 'Retained across throw');
    await submit(visit.host);
    expect(visit.host.textContent).toContain(m.zones_create_uncertain());
    await settle(() => button(visit.host, m.zones_owner_retry()).click());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[1]!.labels).toEqual({ en: 'Retained across throw' });
    expect(visit.navigations).toHaveLength(1);
  } finally {
    await visit.close();
  }
});

test('retired uncertain retry and queued native focus cannot affect another independent visit', async () => {
  const native = zonesFixture('uncertain');
  const { client, owner } = owned();
  const send = sender(native);
  const retired = await mount({ owner, onCreate: send.run });
  const current = await mount();
  try {
    await choose(retired.host);
    await name(retired.host, 'Uncertain private draft');
    await submit(retired.host);
    expect(frames.length).toBeGreaterThan(0);
    const retry = button(retired.host, m.zones_owner_retry());
    const key = Object.keys(retry).find((value) => value.startsWith('__reactProps$'))!;
    const callback = Reflect.get(retry, key).onClick;
    const original = native.calls[0];
    await settle(() => {
      owner.end();
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      callback({
        nativeEvent: event,
        target: retry,
        currentTarget: retry,
        get defaultPrevented() {
          return event.defaultPrevented;
        },
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        isPropagationStopped: () => false,
        isDefaultPrevented: () => event.defaultPrevented,
        persist() {},
      });
    });
    starter(current.host).focus();
    await focusFrame();
    expect(document.activeElement).toBe(starter(current.host));
    expect(native.calls).toEqual([original]);
    expect(send.calls).toHaveLength(1);
    expect(owner.capture()).toBeNull();
    expect(retired.host.querySelector('form')).toBeNull();
    expect(retired.host.textContent).not.toContain(m.zones_create_uncertain());
    expect(current.native.calls).toHaveLength(0);
    await choose(current.host);
    await name(current.host, 'Independent healthy command');
    await submit(current.host);
    expect(current.native.calls).toHaveLength(1);
    expect(retired.navigations).toHaveLength(0);
    expect(current.navigations).toHaveLength(1);
  } finally {
    await retired.close();
    await current.close();
    client.clear();
  }
});
