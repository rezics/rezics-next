import { expect, test } from 'bun:test';
import { accountLocales } from '../src/account-settings.ts';
import { formatDigest } from '../src/email-copy/index.ts';
import { renderAccountEmail, type AccountLocale, type EmailPurpose } from '../src/email.ts';
import { deviceLabel } from '../src/security-activity.ts';

const purposes = ['verify', 'reset', 'change-email', 'notice', 'digest'] as const satisfies readonly EmailPurpose[];
const url = 'https://accounts.test/continue';

test('every account email is written in the locale it claims', () => {
  for (const locale of accountLocales) {
    for (const purpose of purposes) {
      const notice = purpose === 'digest' || purpose === 'notice' ? 'Hello <there>' : undefined;
      const rendered = renderAccountEmail(purpose, locale, url, notice);
      expect(rendered.html).toContain(`lang="${locale}"`);
      expect(rendered.subject.trim().length).toBeGreaterThan(0);
      if (purpose !== 'digest') expect(rendered.text).toContain(url);
      expect(rendered.html).not.toContain('<there>');
      if (notice) expect(rendered.html).toContain('&lt;there&gt;');
    }
    const line = formatDigest(locale, [{ topic: 'realm-invitation', count: 1 }, { topic: 'reply', count: 3 }], true);
    expect(line).not.toContain('{n}');
    expect(line.split('\n').length).toBe(3);
    if (locale === 'en') expect(line).toContain('Realm');
    if (locale.startsWith('zh')) expect(line).not.toContain('Realm');
  }
});

test('English and Simplified copy keep the sentences people already receive', () => {
  expect(renderAccountEmail('verify', 'en', url)).toMatchObject({ subject: 'Verify your email address' });
  expect(renderAccountEmail('reset', 'zh-Hans', url).subject).toBe('重置密码');
  expect(formatDigest('zh-Hans', [{ topic: 'mention', count: 2 }], false)).toBe('2 次提及');
  expect(formatDigest('en', [{ topic: 'reply', count: 1 }], false)).toBe('1 reply');
  expect(formatDigest('en', [{ topic: 'reply', count: 2 }], false)).toBe('2 replies');
  expect(formatDigest('de', [{ topic: 'reply', count: 1 }], false)).toBe('1 Antwort');
  expect(formatDigest('fr', [{ topic: 'notification', count: 2 }], true)).toContain('notifications');
});

test('an unnamed browser is a code the client can translate', () => {
  expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36').label)
    .toBe('Chrome · Linux');
  expect(deviceLabel('SomeAgent/1.0')).toEqual({ browser: 'unknown', platform: null, label: 'unknown' });
  expect(deviceLabel('SomeAgent/1.0 (Linux)')).toEqual({ browser: 'unknown', platform: 'Linux', label: 'Linux' });
  const locales = accountLocales;
  expect(locales).toContain('ja' satisfies AccountLocale);
});
