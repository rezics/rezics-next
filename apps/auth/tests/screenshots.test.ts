import { expect, test } from 'bun:test';
import { captureMatrix, redactCaptureError } from '../scripts/screenshots';

test('capture identities cover every Auth state, locale, theme and viewport without collisions', () => {
  const targets = captureMatrix();
  expect(targets).toHaveLength(320);
  expect(new Set(targets.map((target) => target.imagePath)).size).toBe(320);
  expect([...new Set(targets.map((target) => target.state))]).toEqual([
    'login',
    'login-error',
    'signup',
    'consent',
    'recovery-request',
    'recovery-password',
    'security',
    'account-delete',
    'organization-new',
    'step-up',
  ]);
  expect([...new Set(targets.map((target) => target.locale))]).toEqual([
    'en',
    'zh-Hant',
    'zh-Hans',
    'ja',
    'ko',
    'de',
    'fr',
    'es',
  ]);
  expect([...new Set(targets.map((target) => target.theme))]).toEqual(['light', 'dark']);
  expect([...new Set(targets.map((target) => target.viewport.name))]).toEqual(['desktop1280', 'phone390']);
  expect([...new Set(targets.map(({ viewport }) => `${viewport.name}:${viewport.width}x${viewport.height}`))]).toEqual([
    'desktop1280:1280x900',
    'phone390:390x844',
  ]);
  const imageFor = (state: string, theme: string, viewport: string) =>
    targets.find(
      (target) =>
        target.state === state && target.locale === 'en' && target.theme === theme && target.viewport.name === viewport,
    )?.imagePath;
  expect(imageFor('login', 'light', 'desktop1280')).toBe('login.en.light.png');
  expect(imageFor('login', 'light', 'phone390')).toBe('login.en.phone.png');
  expect(imageFor('security', 'dark', 'phone390')).toBe('security.en.dark.phone.png');
});

test('manifest error messages redact credentials and session material', () => {
  expect(
    redactCaptureError('/recovery?token=screenshot-token auth_session=auth-screenshot-session "password":"private"'),
  ).toBe('/recovery?token=[redacted] auth_session=[redacted] "password":[redacted]');
});
