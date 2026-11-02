import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, createRef, StrictMode, type ReactNode } from 'react';
import type { TurnstileHandle } from '../src/turnstile.tsx';

// Use the installed DOM implementation already used by mounted Web regressions. No server or script fetches.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({
  url: 'https://auth.test/signup',
  settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
});
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLFormElement: dom.HTMLFormElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Document: dom.Document,
  DocumentFragment: dom.DocumentFragment,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
  scrollTo: dom.scrollTo.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
// Keep production-created script nodes inert: happy-dom otherwise emits an automatic error
// for disabled file loading. Tests alone dispatch each controlled load/error event.
const appendToHead = document.head.appendChild.bind(document.head);
document.head.appendChild = <T extends Node>(node: T): T => {
  if (node instanceof dom.HTMLScriptElement)
    (node as unknown as HTMLScriptElement).type = 'application/x-controlled-turnstile';
  return appendToHead(node) as T;
};
const { createRoot } = await import('react-dom/client');
const { TurnstileWidget, loadTurnstile } = await import('../src/turnstile.tsx');
const { Route } = await import('../src/routes/signup');
const { Route: LoginRoute } = await import('../src/routes/login');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider, Outlet } =
  await import('@tanstack/react-router');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

afterAll(async () => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

let serial = 0;
const source = () => `https://challenge.test/controlled-${++serial}.js?render=explicit`;
type Api = NonNullable<Window['turnstile']>;
type Options = Parameters<Api['render']>[1];
function provider() {
  const widgets: { id: string; element: HTMLElement; options: Options }[] = [];
  const live = new Set<string>();
  const removed: string[] = [];
  const resets: string[] = [];
  const ready: (() => void)[] = [];
  let deferReady = false;
  let renderToken: string | undefined;
  let throwAt: 'ready' | 'render' | 'reset' | 'remove' | undefined;
  let duringRender: (() => void) | undefined;
  const api: Api = {
    ready(callback) {
      ready.push(callback);
      if (throwAt === 'ready') throw Error('ready refused');
      if (!deferReady) callback();
    },
    render(element, options) {
      const id = `widget-${widgets.length + 1}`;
      widgets.push({ id, element, options });
      if (renderToken) options.callback(renderToken);
      duringRender?.();
      if (throwAt === 'render') throw Error('render refused');
      live.add(id);
      return id;
    },
    reset(id) {
      resets.push(id!);
      if (renderToken) widgets.find((widget) => widget.id === id)?.options.callback(renderToken);
      if (throwAt === 'reset') throw Error('reset refused');
    },
    remove(id) {
      removed.push(id!);
      live.delete(id!);
      if (throwAt === 'remove') throw Error('remove refused');
    },
  };
  return {
    api,
    widgets,
    live,
    removed,
    resets,
    ready,
    defer(value = true) {
      deferReady = value;
    },
    token(value: string | undefined) {
      renderToken = value;
    },
    throws(value: typeof throwAt) {
      throwAt = value;
    },
    during(callback: () => void) {
      duringRender = callback;
    },
  };
}
async function flush(action?: () => void) {
  await act(async () => {
    action?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}
function scripts() {
  return [...document.head.querySelectorAll<HTMLScriptElement>('script')];
}
async function scriptEvent(script: HTMLScriptElement, type: 'load' | 'error', api?: Api) {
  if (api) window.turnstile = api;
  await flush(() => script.dispatchEvent(new dom.Event(type) as unknown as Event));
}
async function mounted() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = false;
  return {
    host,
    async render(node: ReactNode) {
      await act(async () => {
        root.render(node);
      });
    },
    unmountNow() {
      closed = true;
      root.unmount();
      host.remove();
    },
    async close() {
      if (closed) return;
      closed = true;
      await act(async () => root.unmount());
      host.remove();
      await flush();
    },
  };
}
async function withWidget(run: (fixture: Awaited<ReturnType<typeof widget>>) => Promise<void>) {
  const fixture = await widget();
  try {
    await run(fixture);
  } finally {
    await fixture.ui.close();
  }
}
async function widget() {
  delete window.turnstile;
  const ui = await mounted();
  const ref = createRef<TurnstileHandle>();
  const tokens: (string | null)[] = [];
  const states: string[] = [];
  let config = { siteKey: 'configured-site-key', scriptUrl: source(), language: 'en' };
  const render = async (changes: Partial<typeof config> = {}, strict = false) => {
    config = { ...config, ...changes };
    const node = (
      <TurnstileWidget
        {...config}
        ref={ref}
        onToken={(token) => tokens.push(token)}
        onStatus={(state) => states.push(state)}
      />
    );
    await ui.render(strict ? <StrictMode>{node}</StrictMode> : node);
  };
  await render();
  return { ui, ref, tokens, states, render, config };
}

// Only acquisition timers are advanced; React/router scheduling retains real timers.
async function withClock(run: (clock: { fire: () => Promise<void>; count: () => number }) => Promise<void>) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let id = 900_000;
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay !== 15_000) return originalSet(callback, delay, ...args);
    const key = ++id;
    timers.set(key, callback);
    return key;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((key: number) => {
    if (!timers.delete(Number(key))) originalClear(key);
  }) as typeof clearTimeout;
  try {
    await run({
      count: () => timers.size,
      fire: async () =>
        flush(() => {
          const callbacks = [...timers.values()];
          timers.clear();
          for (const callback of callbacks) callback();
        }),
    });
    expect(timers.size, 'all acquisition timers are retired').toBe(0);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

test('failed shared script is evicted, and a late old error cannot evict its explicit retry', async () => {
  const src = source();
  const first = loadTurnstile(src);
  const other = loadTurnstile(src);
  expect(other).toBe(first);
  const script = scripts().find((item) => item.src === src)!;
  expect(scripts().filter((item) => item.src === src)).toHaveLength(1);
  const lateError = script.onerror!;
  const failures = Promise.allSettled([first, other]);
  await scriptEvent(script, 'error');
  expect((await failures).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(script.isConnected).toBe(false);
  expect(script.onload).toBeNull();
  expect(script.onerror).toBeNull();
  const retry = loadTurnstile(src);
  const next = scripts().find((item) => item.src === src)!;
  lateError.call(script, new dom.Event('error') as unknown as Event);
  const healthy = provider();
  await scriptEvent(next, 'load', healthy.api);
  await retry;
  await loadTurnstile(src);
  expect(scripts().filter((item) => item.src === src)).toEqual([next]);
});

test("concurrent StrictMode owners share acquisition without removing another owner's healthy script", async () => {
  const ui = await mounted();
  const src = source();
  const refs = [createRef<TurnstileHandle>(), createRef<TurnstileHandle>()];
  const api = provider();
  try {
    await ui.render(
      <StrictMode>
        {refs.map((ref, index) => (
          <TurnstileWidget key={index} ref={ref} siteKey="key" scriptUrl={src} language="ja" onToken={() => {}} />
        ))}
      </StrictMode>,
    );
    expect(scripts().filter((item) => item.src === src)).toHaveLength(1);
    await scriptEvent(
      scripts().find((item) => item.src === src)!,
      'load',
      api.api,
    );
    expect(api.widgets).toHaveLength(2);
    await ui.render(
      <StrictMode>
        <TurnstileWidget key={0} ref={refs[0]} siteKey="key" scriptUrl={src} language="ja" onToken={() => {}} />
      </StrictMode>,
    );
    expect(api.live.size).toBe(1);
    expect(scripts().filter((item) => item.src === src)).toHaveLength(1);
    expect(api.widgets[0]!.options).toMatchObject({ sitekey: 'key', action: 'signup', language: 'ja', retry: 'never' });
    await ui.close();
    expect(api.live.size).toBe(0);
    expect(scripts().filter((item) => item.src === src)).toHaveLength(0);
  } finally {
    await ui.close();
  }
});

test('never-load, missing API, never-ready, ready/render throws each fail boundedly and permit retry', async () => {
  for (const fault of ['never-load', 'missing-api', 'never-ready', 'ready', 'render'] as const) {
    await withClock(async (clock) =>
      withWidget(async ({ ref, states, tokens }) => {
        const api = provider();
        if (fault === 'never-ready') api.defer();
        if (fault === 'ready' || fault === 'render') api.throws(fault);
        api.token('must-not-publish-on-throw');
        const script = scripts().at(-1)!;
        if (fault === 'never-load') await clock.fire();
        else if (fault === 'missing-api') await scriptEvent(script, 'load');
        else {
          await scriptEvent(script, 'load', api.api);
          if (fault === 'never-ready') await clock.fire();
        }
        expect(states.at(-1), fault).toBe('failed');
        expect(ref.current!.getToken()).toBeNull();
        expect(tokens.filter(Boolean), fault).toEqual([]);
        api.throws(undefined);
        api.defer(false);
        api.token('current');
        await flush(() => ref.current!.retry());
        if (!script.isConnected) await scriptEvent(scripts().at(-1)!, 'load', api.api);
        expect(states.at(-1), fault).toBe('ready');
        expect(ref.current!.getToken(), fault).toBe('current');
        expect(api.live.size).toBe(1);
      }),
    );
  }
});

test('configuration and locale replacement clear authority while pending and fence every old callback', async () => {
  await withWidget(async ({ ref, render, tokens, states }) => {
    const oldApi = provider();
    oldApi.token('old-token');
    await scriptEvent(scripts().at(-1)!, 'load', oldApi.api);
    expect(ref.current!.getToken()).toBe('old-token');
    const old = oldApi.widgets[0]!.options;
    const oldHandle = ref.current!;
    const api = provider();
    api.defer();
    await render({ siteKey: 'replacement', scriptUrl: source(), language: 'fr' });
    expect(ref.current!.getToken()).toBeNull();
    expect(tokens.at(-1)).toBeNull();
    expect(states.at(-1)).toBe('loading');
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    await flush(() => {
      old.callback('late');
      old['expired-callback']();
      old['error-callback']();
      oldHandle.reset();
    });
    expect(states.at(-1)).toBe('loading');
    expect(oldApi.live.size).toBe(0);
    await flush(() => api.ready[0]!());
    const current = api.widgets[0]!.options;
    expect(current).toMatchObject({ sitekey: 'replacement', language: 'fr', action: 'signup' });
    await flush(() => current.callback('new-token'));
    await flush(() => {
      old.callback('late');
      old['expired-callback']();
      old['error-callback']();
    });
    expect(ref.current!.getToken()).toBe('new-token');
    expect(api.live.size).toBe(1);
    await render({ language: 'de' });
    expect(ref.current!.getToken()).toBeNull();
    await flush(() => current.callback('late-locale'));
    expect(ref.current!.getToken()).toBeNull();
  });
});

test('reset/retry overlap, synchronous callbacks and throwing reset/remove keep generation ownership', async () => {
  await withWidget(async ({ ref, tokens, states }) => {
    const api = provider();
    api.token('initial-sync-token');
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    expect(ref.current!.getToken()).toBe('initial-sync-token');
    const old = api.widgets[0]!.options;
    api.throws('reset');
    await flush(() => {
      ref.current!.reset();
      old.callback('late-reset');
    });
    expect(states.at(-1)).toBe('failed');
    expect(ref.current!.getToken()).toBeNull();
    expect(tokens.filter((token) => token === 'late-reset')).toEqual([]);
    api.throws('remove');
    api.token('fresh-sync-token');
    await flush(() => ref.current!.retry());
    expect(ref.current!.getToken()).toBe('fresh-sync-token');
    const current = api.widgets.at(-1)!.options;
    await flush(() => {
      old['error-callback']();
      old['expired-callback']();
    });
    expect(ref.current!.getToken()).toBe('fresh-sync-token');
    await flush(() => current['expired-callback']());
    expect(ref.current!.getToken()).toBeNull();
    await flush(() => current['error-callback']());
    expect(states.at(-1)).toBe('failed');
    expect(api.live.size).toBe(0);
  });
});

test('unmount before load/ready and retirement inside render suppress late work and clean owned DOM', async () => {
  for (const boundary of ['load', 'ready', 'render'] as const) {
    await withClock(async () =>
      withWidget(async ({ ui, tokens, states }) => {
        const api = provider();
        const script = scripts().at(-1)!;
        const lateLoad = script.onload!;
        api.defer(boundary === 'ready');
        if (boundary === 'render')
          api.during(() => {
            // Retire synchronously inside the provider, before render returns an id.
            ui.unmountNow();
          });
        if (boundary !== 'load') await scriptEvent(script, 'load', api.api);
        await ui.close();
        const count = [tokens.length, states.length];
        await flush(() => {
          lateLoad.call(script, new dom.Event('load') as unknown as Event);
          for (const ready of api.ready) ready();
          for (const widget of api.widgets) {
            widget.options.callback('late-unmounted');
            widget.options['expired-callback']();
            widget.options['error-callback']();
          }
        });
        expect([tokens.length, states.length]).toEqual(count);
        expect(api.live.size).toBe(0);
        expect(ui.host.childElementCount).toBe(0);
        if (boundary === 'load') expect(script.isConnected).toBe(false);
        for (const widget of api.widgets) expect(widget.element.isConnected).toBe(false);
      }),
    );
  }
});

async function signup() {
  delete window.turnstile;
  const ui = await mounted();
  const config = { siteKey: 'default-page-key', scriptUrl: source() };
  const rootRoute = createRootRoute({ component: Outlet });
  // Mount the actual file route; only its server configuration read is controlled.
  const route = Route.update({
    id: '/signup',
    path: '/signup',
    getParentRoute: () => rootRoute,
    loader: () => config,
  } as never);
  const query =
    '?client_id=web&state=opaque&resource=one&resource=two&empty=&sig=private&exp=1&prompt=login&max_age=600';
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      route,
      LoginRoute.update({ id: '/login', path: '/login', getParentRoute: () => rootRoute } as never),
    ]),
    history: createMemoryHistory({ initialEntries: [`/signup${query}`] }),
  });
  await router.load();
  await ui.render(createElement(RouterProvider, { router }));
  const input = (name: string) => ui.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const fill = async (name: string, value: string) =>
    flush(() => {
      // Bypass React's value tracker so the event represents a person's edit.
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input(name), value);
      input(name).dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
    });
  const submit = async () =>
    flush(() =>
      ui.host
        .querySelector('form')!
        .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
    );
  const retry = () =>
    [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Retry security check',
    )!;
  const fillAll = async () => {
    await fill('handle', 'Reader_1');
    await fill('email', 'reader@example.test');
    await fill('password', 'private-password');
  };
  return { ui, config, query, router, fill, fillAll, input, submit, retry };
}

test('mounted default signup recovers a failed script by explicit accessible retry and retains its fields', async () => {
  const page = await signup();
  const calls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    calls.push(args);
    throw Error('No request expected');
  }) as typeof fetch;
  try {
    await page.fillAll();
    const oldScript = scripts().at(-1)!;
    await scriptEvent(oldScript, 'error');
    expect(page.ui.host.querySelector('[role="alert"]')!.textContent).toContain('security check');
    expect(page.retry().type).toBe('button');
    expect(page.retry().disabled).toBe(false);
    page.retry().focus();
    expect(document.activeElement).toBe(page.retry());
    await page.submit();
    expect(calls).toHaveLength(0);
    await flush(() => page.retry().click());
    expect(page.ui.host.querySelector('[role="status"]')!.textContent).toContain('Loading');
    expect(scripts().filter((script) => script.src === page.config.scriptUrl)).toHaveLength(1);
    const api = provider();
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    expect(api.widgets[0]!.options).toMatchObject({ sitekey: 'default-page-key', action: 'signup', language: 'en' });
    expect(page.input('handle').value).toBe('Reader_1');
    expect(page.input('email').value).toBe('reader@example.test');
    expect(page.input('password').value).toBe('private-password');
    expect(page.ui.host.querySelector(`a[href="/login${page.query}"]`)).not.toBeNull();
    await page.submit();
    expect(calls).toHaveLength(0);
  } finally {
    await page.ui.close();
  }
});

test('mounted default signup preserves the key and original request token, consumes network failures, and excludes duplicate pending submits', async () => {
  const page = await signup();
  const api = provider();
  const requests: { path: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  let release!: () => void;
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    requests.push({ path, init, body: JSON.parse(String(init.body)) });
    if (requests.length === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw Error('network failed');
    }
    return Response.json({ error: 'handle_unavailable' }, { status: 409 });
  }) as typeof fetch;
  try {
    await page.fillAll();
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    await flush(() => api.widgets[0]!.options.callback('original-token'));
    await page.submit();
    expect(requests).toHaveLength(1);
    await page.submit();
    expect(requests).toHaveLength(1);
    expect(page.ui.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await flush(() => api.widgets[0]!.options.callback('changed-while-pending'));
    expect(requests[0]!.body.turnstile_token).toBe('original-token');
    await flush(release);
    await page.submit();
    expect(requests).toHaveLength(1);
    const current = api.widgets.at(-1)!.options;
    await flush(() => {
      api.widgets[0]!.options.callback('retired-token');
      current.callback('fresh-token');
    });
    await page.submit();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toEqual({ ...requests[0]!.body, turnstile_token: 'fresh-token' });
    expect(requests[0]!.body.key).toMatch(/^[a-f0-9]{32}$/);
    expect(
      requests.every(
        (request) =>
          request.path === '/signup' && request.init.credentials === 'same-origin' && request.init.redirect === 'error',
      ),
    ).toBe(true);
    expect(page.input('handle').getAttribute('aria-describedby')).toBe('signup-handle-error');
    expect(document.activeElement).toBe(page.input('handle'));
    for (const [field, value] of Object.entries({
      handle: 'Reader_1',
      email: 'reader@example.test',
      password: 'private-password',
    }))
      expect(page.input(field).value).toBe(value);
  } finally {
    release?.();
    await page.ui.close();
  }
});

test('mounted default signup refuses invalid passwords before dispatch without consuming verification', async () => {
  const page = await signup();
  const api = provider();
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }) as typeof fetch;
  try {
    await page.fillAll();
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    await flush(() => api.widgets[0]!.options.callback('retained-token'));
    for (const value of ['short7', 'x'.repeat(129)]) {
      await page.fill('password', value);
      await page.submit();
      expect(requests).toBe(0);
      expect(page.input('password').getAttribute('aria-describedby')).toBe('signup-password-error');
      expect(document.activeElement).toBe(page.input('password'));
      expect(api.resets).toHaveLength(0);
      expect(api.live.size).toBe(1);
    }
    await page.fill('password', 'valid-password');
    await page.submit();
    expect(requests).toBe(1);
    expect(api.resets).toHaveLength(1);
  } finally {
    await page.ui.close();
  }
});

test('repeated explicit failure/retry/retirement keeps one script, one widget and no retained loading work', async () => {
  await withClock(async (clock) =>
    withWidget(async ({ ref, states }) => {
      const api = provider();
      const script = scripts().at(-1)!;
      await scriptEvent(script, 'load', api.api);
      for (let index = 0; index < 100; index++) {
        const old = api.widgets.at(-1)!.options;
        await flush(() => old['error-callback']());
        expect(ref.current!.getToken()).toBeNull();
        expect(api.live.size).toBe(0);
        await flush(() => ref.current!.retry());
        const current = api.widgets.at(-1)!.options;
        await flush(() => {
          current.callback(`token-${index}`);
          old.callback('stale');
          old['expired-callback']();
          old['error-callback']();
        });
        expect(ref.current!.getToken()).toBe(`token-${index}`);
        expect(states.at(-1)).toBe('ready');
        expect(api.live.size).toBe(1);
        expect(scripts().filter((item) => item.src === script.src)).toEqual([script]);
        expect(script.onload).toBeNull();
        expect(script.onerror).toBeNull();
        expect(clock.count()).toBe(0);
      }
    }),
  );
});

test('mounted default signup exposes bounded loading and API failure recovery through its real retry control', async () => {
  for (const fault of ['never-load', 'missing-api', 'never-ready', 'ready', 'render'] as const) {
    await withClock(async (clock) => {
      const page = await signup();
      const api = provider();
      let requests = 0;
      globalThis.fetch = (async () => {
        requests++;
        throw Error('No challenge token');
      }) as typeof fetch;
      try {
        await page.fillAll();
        expect(page.ui.host.querySelector('[role="status"]')!.textContent).toContain('Loading');
        const script = scripts().at(-1)!;
        if (fault === 'never-load') await clock.fire();
        else if (fault === 'missing-api') await scriptEvent(script, 'load');
        else {
          if (fault === 'never-ready') api.defer();
          else api.throws(fault);
          await scriptEvent(script, 'load', api.api);
          if (fault === 'never-ready') await clock.fire();
        }
        expect(page.retry().disabled, fault).toBe(false);
        expect(page.ui.host.querySelector('[role="alert"]')!.textContent).toContain('could not load');
        await page.submit();
        expect(requests).toBe(0);
        api.throws(undefined);
        api.defer(false);
        await flush(() => page.retry().click());
        if (!script.isConnected) await scriptEvent(scripts().at(-1)!, 'load', api.api);
        expect(page.retry()).toBeUndefined();
        expect(api.live.size).toBe(1);
        expect(page.input('handle').value).toBe('Reader_1');
        expect(page.input('email').value).toBe('reader@example.test');
        expect(page.input('password').value).toBe('private-password');
      } finally {
        await page.ui.close();
      }
    });
  }
});

test('default signup success still sends the original signup and signin protocol and resumes the OIDC query', async () => {
  const page = await signup();
  const api = provider();
  const requests: { path: string; init: RequestInit; body: unknown }[] = [];
  const navigations: string[] = [];
  const assign = window.location.assign;
  window.location.assign = (target) => {
    navigations.push(String(target));
  };
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    requests.push({ path, init, body: JSON.parse(String(init.body)) });
    return path === '/signup'
      ? Response.json({ accountId: 'account-id' }, { status: 201 })
      : Response.json({ success: true });
  }) as typeof fetch;
  try {
    await page.fillAll();
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    await flush(() => api.widgets[0]!.options.callback('exact-submitted-token'));
    await page.submit();
    expect(requests.map((request) => request.path)).toEqual(['/signup', '/signin']);
    expect(requests[0]!.body).toEqual({
      key: expect.stringMatching(/^[a-f0-9]{32}$/),
      handle: 'Reader_1',
      email: 'reader@example.test',
      password: 'private-password',
      turnstile_token: 'exact-submitted-token',
    });
    expect(requests[1]!.body).toEqual({
      email: 'reader@example.test',
      password: 'private-password',
      client_id: 'login',
      scope: [],
    });
    expect(
      requests.every(
        (request) =>
          request.init.method === 'POST' &&
          request.init.credentials === 'same-origin' &&
          request.init.redirect === 'error',
      ),
    ).toBe(true);
    expect(api.resets).toHaveLength(0);
    expect(navigations).toHaveLength(1);
    const unload = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload as unknown as Event);
    expect(unload.defaultPrevented).toBe(false);
    const target = new URL(navigations[0]!);
    expect(target.origin).toBe('https://auth.test');
    expect(target.pathname).toBe('/authorize');
    expect([...target.searchParams]).toEqual([
      ['client_id', 'web'],
      ['state', 'opaque'],
      ['resource', 'one'],
      ['resource', 'two'],
      ['empty', ''],
      ['max_age', '600'],
    ]);
  } finally {
    window.location.assign = assign;
    await page.ui.close();
  }
});

test('default signup keeps handle privacy, rate limits, outages and recovery links while refreshing each failed request', async () => {
  const page = await signup();
  const api = provider();
  let status = 409;
  let code = 'registration_denied';
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_path: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json(
      { error: code, message: 'An account with this email already exists' },
      { status, headers: { 'Retry-After': '37' } },
    );
  }) as typeof fetch;
  try {
    await page.fillAll();
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    for (const [nextStatus, nextCode] of [
      [409, 'handle_unavailable'],
      [409, 'registration_denied'],
      [429, 'rate_limited'],
      [503, 'unavailable'],
    ] as const) {
      status = nextStatus;
      code = nextCode;
      await flush(() => api.widgets.at(-1)!.options.callback(`token-${bodies.length}`));
      await page.submit();
      expect(page.ui.host.textContent).not.toContain('An account with this email already exists');
      expect(page.input('email').getAttribute('aria-describedby')).toBeNull();
      if (code === 'handle_unavailable') {
        expect(document.activeElement).toBe(page.input('handle'));
        expect(page.ui.host.querySelector('#signup-handle-error')!.textContent).toContain('taken or reserved');
      } else {
        const alert = page.ui.host.querySelector('[role="alert"]')!;
        expect(alert.textContent).not.toContain('reader@example.test');
        if (status === 409) {
          expect(alert.querySelector(`a[href="/login${page.query}"]`)).not.toBeNull();
          expect(alert.querySelector(`a[href="/recovery${page.query}"]`)).not.toBeNull();
        }
        if (status === 429) expect(alert.textContent).toContain('37');
        if (status === 503) expect(alert.textContent).toMatch(/try again|later/i);
      }
      const count = bodies.length;
      await page.submit();
      expect(bodies).toHaveLength(count);
    }
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.map((body) => body.key)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.turnstile_token)).size).toBe(4);
    expect(api.resets).toHaveLength(4);
  } finally {
    await page.ui.close();
  }
});

test('late ready and reset work cannot replace a successor, and source changes retire unused scripts', async () => {
  await withWidget(async ({ ref, render, states }) => {
    const oldApi = provider();
    oldApi.defer();
    const oldScript = scripts().at(-1)!;
    await scriptEvent(oldScript, 'load', oldApi.api);
    const oldHandle = ref.current!;
    await render({ scriptUrl: source() });
    const api = provider();
    api.token('successor-token');
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    await flush(() => {
      oldApi.ready[0]!();
      oldHandle.reset();
      oldHandle.retry();
    });
    expect(oldApi.widgets).toHaveLength(0);
    expect(oldApi.resets).toHaveLength(0);
    expect(ref.current!.getToken()).toBe('successor-token');
    expect(states.at(-1)).toBe('ready');
    expect(oldScript.isConnected).toBe(false);
    // A retry inside render retires the generation before its id is returned.
    let once = false;
    api.during(() => {
      if (!once) {
        once = true;
        ref.current!.retry();
      }
    });
    await flush(() => ref.current!.reset());
    expect(api.live.size).toBe(1);
    expect(ref.current!.getToken()).toBe('successor-token');
  });
});

test('leaving default signup during a pending request prevents late page state and challenge resets', async () => {
  const page = await signup();
  const api = provider();
  let release!: () => void;
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({ error: 'handle_unavailable' }, { status: 409 });
  }) as typeof fetch;
  try {
    await page.fillAll();
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    await flush(() => api.widgets[0]!.options.callback('pending-token'));
    await page.submit();
    await page.ui.close();
    await flush(release);
    expect(api.resets).toHaveLength(0);
    expect(api.live.size).toBe(0);
    expect(page.ui.host.childElementCount).toBe(0);
  } finally {
    release?.();
    await page.ui.close();
  }
});

test('ready throwing after synchronous render and success cannot publish provisional authority', async () => {
  await withWidget(async ({ ref, tokens, states }) => {
    const api = provider();
    api.token('provisional');
    api.api.ready = (callback) => {
      callback();
      throw Error('ready failed after callback');
    };
    await scriptEvent(scripts().at(-1)!, 'load', api.api);
    expect(states.at(-1)).toBe('failed');
    expect(tokens.filter(Boolean)).toEqual([]);
    expect(ref.current!.getToken()).toBeNull();
    expect(api.live.size).toBe(0);
  });
});

test('repeated script failures and retries retain no failed scripts, listeners or timers', async () => {
  await withClock(async (clock) =>
    withWidget(async ({ ref, states, config }) => {
      const retired: HTMLScriptElement[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        const script = scripts().find((item) => item.src === config.scriptUrl)!;
        expect(script).toBeDefined();
        expect(scripts().filter((item) => item.src === config.scriptUrl)).toHaveLength(1);
        const late = script.onerror!;
        await scriptEvent(script, 'error');
        retired.push(script);
        expect(states.at(-1)).toBe('failed');
        expect(ref.current!.getToken()).toBeNull();
        expect(scripts().filter((item) => item.src === config.scriptUrl)).toHaveLength(0);
        expect(clock.count()).toBe(0);
        expect(retired.every((item) => !item.isConnected && !item.onload && !item.onerror)).toBe(true);
        await flush(() => ref.current!.retry());
        await flush(() => late.call(script, new dom.Event('error') as unknown as Event));
        expect(states.at(-1)).toBe('loading');
        expect(clock.count()).toBe(1);
      }
      const api = provider();
      api.token('final-current');
      await scriptEvent(scripts().at(-1)!, 'load', api.api);
      expect(ref.current!.getToken()).toBe('final-current');
      expect(api.live.size).toBe(1);
      expect(clock.count()).toBe(0);
    }),
  );
});

test('created accounts keep sign-in failure feedback and finish through login without repeating creation', async () => {
  for (const status of [401, 429, 503]) {
    const page = await signup();
    const api = provider();
    const paths: string[] = [];
    globalThis.fetch = (async (path: string) => {
      paths.push(path);
      if (path === '/signup') return Response.json({ accountId: 'account-id' }, { status: 201 });
      return Response.json(
        { error: status === 401 ? 'authentication_denied' : status === 429 ? 'rate_limited' : 'unavailable' },
        { status, headers: { 'Retry-After': '37' } },
      );
    }) as typeof fetch;
    try {
      await page.fillAll();
      await scriptEvent(scripts().at(-1)!, 'load', api.api);
      await flush(() => api.widgets[0]!.options.callback('signup-token'));
      await page.submit();
      expect(paths).toEqual(['/signup', '/signin']);
      const unload = new dom.Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload as unknown as Event);
      expect(unload.defaultPrevented).toBe(false);
      const alert = page.ui.host.querySelector('[role="alert"]')!;
      expect(alert).not.toBeNull();
      expect(document.activeElement).toBe(alert);
      if (status === 401) expect(alert.textContent).toMatch(/email or password/i);
      if (status === 429) expect(alert.textContent).toContain('37');
      if (status === 503) expect(alert.textContent).toMatch(/try again|later/i);
      expect(api.resets).toHaveLength(0);
      expect(page.ui.host.querySelector('[role="status"]')!.textContent).toContain('Your account was created');
      expect(page.ui.host.querySelector('form')).toBeNull();
      expect(page.ui.host.querySelector('input')).toBeNull();
      const login = page.ui.host.querySelector<HTMLAnchorElement>('a[href^="/login"]')!;
      expect(login.getAttribute('href')).toBe(`/login${page.query}`);
      expect(page.ui.host.querySelector('a[href^="/recovery"]')!.getAttribute('href')).toBe(`/recovery${page.query}`);
      await flush(() => page.router.history.push(login.getAttribute('href')!));
      await page.router.load();
      const assign = window.location.assign;
      const targets: string[] = [];
      window.location.assign = (target) => {
        targets.push(String(target));
      };
      try {
        globalThis.fetch = (async (path: string) => {
          paths.push(path);
          return Response.json({ success: true });
        }) as typeof fetch;
        await page.fill('email', 'reader@example.test');
        await page.fill('password', 'private-password');
        await page.submit();
        expect(paths).toEqual(['/signup', '/signin', '/signin']);
        expect(targets).toEqual([
          'https://auth.test/authorize?client_id=web&state=opaque&resource=one&resource=two&empty=&max_age=600',
        ]);
      } finally {
        window.location.assign = assign;
      }
    } finally {
      await page.ui.close();
    }
  }
});

for (const stage of ['creation', 'sign-in'])
  for (const boundary of ['unmount', 'replace', 'cached return'])
    for (const status of [200, 503])
      test(`${stage} ${status} cannot continue after ${boundary}`, async () => {
        const page = await signup();
        const api = provider();
        const paths: string[] = [];
        const targets: string[] = [];
        const assign = window.location.assign;
        window.location.assign = (target) => {
          targets.push(String(target));
        };
        let release!: (response: Response) => void;
        globalThis.fetch = (async (path: string) => {
          paths.push(path);
          if (stage === 'sign-in' && path === '/signup')
            return Response.json({ accountId: 'account-id' }, { status: 201 });
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }) as typeof fetch;
        try {
          await page.fillAll();
          await scriptEvent(scripts().at(-1)!, 'load', api.api);
          await flush(() => api.widgets[0]!.options.callback('signup-token'));
          await page.submit();
          if (stage === 'sign-in') {
            expect(page.ui.host.querySelector('[role="status"]')!.textContent).toContain('Your account was created');
            expect(page.ui.host.querySelector('form')).toBeNull();
          }
          if (boundary === 'unmount') await page.ui.close();
          else if (boundary === 'replace') {
            await flush(() => page.router.history.replace('/signup?state=new'));
            if (stage === 'creation')
              await flush(() =>
                document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')!.click(),
              );
          } else
            await flush(() => {
              window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
              window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event);
            });
          await flush(() =>
            release(
              Response.json(status === 200 ? { accountId: 'account-id' } : { error: 'unavailable' }, {
                status: stage === 'creation' && status === 200 ? 201 : status,
              }),
            ),
          );
          expect(paths).toEqual(stage === 'creation' ? ['/signup'] : ['/signup', '/signin']);
          expect(targets).toEqual([]);
          expect(page.ui.host.querySelector('[role="alert"]')).toBeNull();
          if (boundary !== 'unmount') {
            for (const name of ['handle', 'email', 'password']) expect(page.input(name).value).toBe('');
            expect(page.ui.host.querySelector('[role="status"]')?.textContent ?? '').not.toContain('created');
          }
        } finally {
          window.location.assign = assign;
          await page.ui.close();
        }
      });
