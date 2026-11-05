import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { creationFixture, open } from './creation-page-fixture';
import { parseRegistrationPage, type RegistrationPage } from '../src/registration-page';
import { Route } from '../src/routes/signup';
import { signInTarget } from '../src/sign-in';

creationFixture();

const requirements = {
  handle: { minLength: 3, maxLength: 64 },
  email: { maxLength: 254 },
  password: { minLength: 10, maxLength: 96 },
  verification: { provider: 'turnstile', required: true },
} as const;

function nativeRegistration() {
  return {
    kind: 'registration',
    viewer: null,
    requirements,
    verification: { configured: true },
    actions: { register: true, continue: false },
  };
}

test('production registration advice bounds BFF completion and cancellation without sharing obsolete advice', async () => {
  // Isolate the installed server-function transport from mounted route tests.
  const script = `
    import { expect, mock } from 'bun:test';
    const native = ${JSON.stringify(nativeRegistration())};
    const unavailable = { kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } };
    let mode = 'ready', body = native, config = { siteKey: 'public-site-key', scriptUrl: 'https://challenge.test/api.js' };
    let configReads = 0, nativeReads = 0, calls = 0, signal, expire;
    let started, completed, late, configWait;
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 5000) { expire = callback; return timeout(() => {}, 60000); }
      return timeout(callback, delay, ...args);
    };
    mock.module('../src/turnstile.ts', () => ({ readTurnstileConfig: async () => {
      configReads++; return mode === 'config' ? configWait.promise : config;
    } }));
    mock.module('../src/security-inventory', () => ({ issuerSecurityRequest: async path => {
      expect(path).toBe('/registration-page'); nativeReads++; return Response.json(body);
    } }));
    mock.module('@tanstack/react-start', () => ({ createServerFn: () => ({ handler: fn => async options => {
      const phase = mode, held = late, finish = completed;
      calls++; signal = options?.signal; started.resolve();
      if (phase === 'waiting') return held.promise;
      const result = await fn();
      finish.resolve();
      if (phase === 'completion') return held.promise;
      if (phase === 'rejected') throw new Error('BFF delivery failed');
      return result;
    } }) }));
    const { readRegistrationPage } = await import('../src/registration-page');
    function prepare(next) {
      mode = next; started = Promise.withResolvers(); completed = Promise.withResolvers();
      late = Promise.withResolvers(); configWait = Promise.withResolvers();
    }
    const caller = new AbortController(); caller.abort();
    expect(await readRegistrationPage(caller.signal)).toEqual(unavailable);
    expect([calls, configReads, nativeReads]).toEqual([0, 0, 0]);
    for (const phase of ['waiting', 'completion', 'config', 'cancelled']) {
      prepare(phase === 'cancelled' ? 'waiting' : phase);
      const before = [calls, configReads, nativeReads];
      const owner = new AbortController();
      const pending = readRegistrationPage(owner.signal);
      await started.promise;
      if (phase === 'completion') await completed.promise;
      if (phase === 'cancelled') owner.abort(); else expire();
      expect(await pending).toEqual(unavailable);
      expect(signal.aborted).toBe(true);
      expect(calls).toBe(before[0] + 1);
      expect(configReads).toBe(before[1] + (['completion', 'config'].includes(phase) ? 1 : 0));
      expect(nativeReads).toBe(before[2] + (phase === 'completion' ? 1 : 0));
      // A new deliberate read uses current native advice while old transport is still pending.
      const obsolete = late, oldConfig = configWait, oldCompletion = completed;
      prepare('ready');
      body = { ...native, kind: 'already-signed-in', viewer: { account_id: 'current-account' },
        verification: { configured: false }, actions: { register: false, continue: true } };
      config = { siteKey: '', scriptUrl: '' };
      const current = await readRegistrationPage();
      expect(current).toEqual(body);
      obsolete.resolve({ ...native, siteKey: 'obsolete', scriptUrl: 'obsolete' }); oldConfig.resolve(config);
      if (phase === 'config') await oldCompletion.promise;
      expect(await pending).toEqual(unavailable);
      expect(current.viewer.account_id).toBe('current-account');
    }
    prepare('rejected'); expect(await readRegistrationPage()).toEqual(unavailable);
    body = native; prepare('ready');
    expect(await readRegistrationPage()).toEqual({ kind: 'unavailable', reason: 'verification', viewer: null,
      requirements: native.requirements, actions: { register: false, continue: false } });
    config = { siteKey: 'public-site-key', scriptUrl: 'https://challenge.test/api.js' };
    const before = [calls, configReads, nativeReads];
    expect(await readRegistrationPage()).toEqual({ ...native, ...config });
    expect([calls, configReads, nativeReads]).toEqual(before.map(value => value + 1));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, output + error).toBe(0);
});

async function mount(page: RegistrationPage, query = '?client_id=showcase&scope=openid&return_to=%2Fwork%2Fseeded') {
  const root = createRootRoute({ component: Outlet });
  const route = Route.update({
    id: '/signup',
    path: '/signup',
    getParentRoute: () => root,
    loader: () => page,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/signup${query}`] }),
  });
  await router.load();
  const view = await open(createElement(RouterProvider, { router }), {});
  return { ...view, router, query };
}

test('the Auth boundary only offers registration from native advice and preserves native password limits', () => {
  expect(
    parseRegistrationPage(nativeRegistration(), {
      siteKey: 'public-site-key',
      scriptUrl: 'https://challenge.test/api.js',
    }),
  ).toEqual({
    kind: 'registration',
    viewer: null,
    requirements,
    verification: { configured: true },
    actions: { register: true, continue: false },
    siteKey: 'public-site-key',
    scriptUrl: 'https://challenge.test/api.js',
  });
  expect(
    parseRegistrationPage(
      { kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } },
      { siteKey: 'public-site-key', scriptUrl: 'https://challenge.test/api.js' },
    ),
  ).toEqual({
    kind: 'unavailable',
    reason: 'dependency',
    actions: { register: false, continue: false },
  });
  expect(parseRegistrationPage(nativeRegistration(), { siteKey: '', scriptUrl: '' })).toEqual({
    kind: 'unavailable',
    reason: 'verification',
    viewer: null,
    requirements,
    actions: { register: false, continue: false },
  });
});

test('an already signed-in viewer gets the safe continuation and account replacement link', async () => {
  const query = '?client_id=showcase&scope=openid&return_to=%2Fwork%2Fseeded';
  const page = await mount(
    {
      kind: 'already-signed-in',
      viewer: { account_id: 'current-account' },
      requirements,
      verification: { configured: false },
      actions: { register: false, continue: true },
    },
    query,
  );
  const continuation = page.host.querySelector<HTMLAnchorElement>('a');

  expect(page.host.querySelector('[role="status"]')?.textContent).toContain('already signed in');
  expect(continuation?.href).toBe(signInTarget(query, window.location.origin));
  expect(page.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)?.textContent).toBe('Sign in');
  expect(page.host.querySelector('input[name="password"]')).toBeNull();
});

test('an unavailable registration read is explained and never renders a submit form', async () => {
  const page = await mount({
    kind: 'unavailable',
    reason: 'dependency',
    actions: { register: false, continue: false },
  });

  expect(page.host.querySelector('[role="alert"]')?.textContent).toContain('Registration is temporarily unavailable');
  expect(page.host.querySelector('button')?.textContent).toContain('Try again');
  expect(page.host.querySelector('input[name="password"]')).toBeNull();
  expect(page.host.querySelector('button[type="submit"]')).toBeNull();
});

test('the registration form renders native field limits and verification advice', async () => {
  const page = await mount({
    kind: 'registration',
    viewer: null,
    requirements,
    verification: { configured: true },
    actions: { register: true, continue: false },
    siteKey: 'public-site-key',
    scriptUrl: 'https://challenge.test/api.js',
  });

  expect(page.host.querySelector<HTMLInputElement>('input[name="email"]')?.maxLength).toBe(254);
  expect(page.host.querySelector<HTMLInputElement>('input[name="handle"]')?.minLength).toBe(3);
  expect(page.host.querySelector<HTMLInputElement>('input[name="handle"]')?.maxLength).toBe(64);
  expect(page.host.querySelector<HTMLInputElement>('input[name="password"]')?.minLength).toBe(10);
  expect(page.host.querySelector<HTMLInputElement>('input[name="password"]')?.maxLength).toBe(96);
  expect(page.host.textContent).toContain('Use 3 to 64 characters: letters a–z, numbers, hyphens or underscores.');
  expect(page.host.textContent).toContain('Use an email address up to 254 characters.');
  expect(page.host.textContent).toContain('Use 10 to 96 characters.');
  expect(page.host.textContent).toContain('Complete the security check before creating your account.');
});
