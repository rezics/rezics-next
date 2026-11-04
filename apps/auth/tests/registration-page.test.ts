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
  const page = await mount({
    kind: 'already-signed-in',
    viewer: { account_id: 'current-account' },
    requirements,
    verification: { configured: false },
    actions: { register: false, continue: true },
  }, query);
  const continuation = page.host.querySelector<HTMLAnchorElement>('a');

  expect(page.host.querySelector('[role="status"]')?.textContent).toContain('already signed in');
  expect(continuation?.href).toBe(signInTarget(query, window.location.origin));
  expect(page.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)?.textContent).toBe('Sign in');
  expect(page.host.querySelector('input[name="password"]')).toBeNull();
});

test('an unavailable registration read is explained and never renders a submit form', async () => {
  const page = await mount({ kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } });

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
