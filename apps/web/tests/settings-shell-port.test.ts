import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSettingsShellPort, SettingsShellProvider } from '../src/settings';
import { DisplayPreferences } from '../src/settings/display-preferences';
import {
  isPlatformClosedError,
  isPlatformClosedProblem,
  isSessionUnavailableError,
  PlatformClosedError,
  personalRead,
  readQueryKey,
  SESSION_QUERY_KEY,
} from '../src/settings/ports/vocabulary';
import { authManagementPageHref } from '../src/settings/auth-management';
import { authManagementPageHref as sessionAuthManagementPageHref } from '../src/session/auth-page-routes';
import { sessionQuery, useSession } from '../src/session';

test('Settings observes the installed session query without minting another cache', () => {
  const port = createSettingsShellPort();
  expect(port.sessionQueryKey).toEqual(SESSION_QUERY_KEY);
  expect(SESSION_QUERY_KEY).toEqual(['session']);
  expect(port.sessionQueryKey).toEqual(sessionQuery.queryKey);
  expect(port.useSession).toBe(useSession);
  expect(port.personalRead).toEqual(personalRead);
  expect(readQueryKey(['notifications', 'inbox'], 'session')).toEqual(['notifications', 'inbox', 'session']);
});

test('Settings classifies platform-closed and session-unavailable locally', () => {
  expect(isPlatformClosedProblem(403, { code: 'platform_closed' })).toBe(true);
  expect(isPlatformClosedProblem(403, { code: 'forbidden' })).toBe(false);
  expect(isPlatformClosedError(new PlatformClosedError(403, { code: 'platform_closed' }))).toBe(true);
  expect(isSessionUnavailableError({ code: 'session_unavailable' })).toBe(true);
  expect(isSessionUnavailableError({ code: 'other' })).toBe(false);
});

test('Settings display consumes the AppearanceControls bound at composition', () => {
  function Marker() {
    return createElement('span', { 'data-appearance': 'bound' });
  }
  const html = renderToStaticMarkup(
    createElement(
      SettingsShellProvider,
      { port: createSettingsShellPort({ AppearanceControls: Marker }) },
      createElement(DisplayPreferences),
    ),
  );
  expect(html).toContain('data-appearance="bound"');
  expect(html).toContain('id="settings-display-heading"');
});

test('Auth management hrefs stay on Settings and the session re-export', () => {
  expect(sessionAuthManagementPageHref).toBe(authManagementPageHref);
  const env = {
    AUTH_ISSUER: 'https://auth.example.test',
    AUTH_MANAGEMENT_PAGE_ROUTES: JSON.stringify(['/account/rename']),
  };
  expect(authManagementPageHref(env, '/account/rename')).toBe('https://auth.example.test/account/rename');
});
