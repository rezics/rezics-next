import { describe, expect, test } from 'bun:test';
import { presentActivity, securityCheckup } from '../features/account/activity.ts';
import { calendarDate, relativeTime } from '../features/account/format.ts';
import { manualKey } from '../features/account/two-step.tsx';
import { activityPage, connectedAppViews, deviceViews, firstPartyPermissionGroups } from '../features/account/views.ts';
import type { SecurityEvent, SignInMethods } from '../features/api/account-data.ts';
import { groupScopes } from '../features/consent/scopes.ts';

const now = new Date('2026-09-27T12:00:00Z');
const at = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
let serial = 0;
const event = (action: string, secondsAgo: number, extra: Partial<SecurityEvent> = {}): SecurityEvent => ({
  id: `e${++serial}`, action, occurredAt: at(secondsAgo), method: null, browser: null, platform: null, network: null,
  clientId: null, ...extra });

describe('security activity', () => {
  test('folds the sessions an action ended into that action', () => {
    const { entries } = presentActivity([
      event('session_revoked', 60), event('session_revoked', 61), event('password_changed', 62),
      event('sign_out', 3_600), event('session_revoked', 3_600),
      event('session_revoked', 7_200), event('session_revoked', 7_203),
      event('app_revoked', 9_000, { clientId: 'reader' }), event('consent_revoked', 9_000, { clientId: 'reader' }),
    ], now, false);
    expect(entries.map(entry => [entry.kind, entry.count])).toEqual([['password-changed', 1], ['signed-out', 1],
      ['device-signed-out', 2], ['app-removed', 1]]);
  });

  test('runs of failed sign-ins become one entry; unknown actions stay out', () => {
    const { entries } = presentActivity([event('sign_in_failed', 10), event('sign_in_failed', 70),
      event('sign_in_failed', 130), event('future_action', 140),
      event('sign_in', 200, { method: 'verify-authentication', browser: 'Chrome', platform: 'macOS' })], now, false);
    expect(entries).toMatchObject([{ kind: 'sign-in-failed', count: 3 },
      { kind: 'signed-in', method: 'passkey', browser: 'Chrome', platform: 'macOS' }]);
  });

  test('shows 90 days and says when older pages may remain', () => {
    const recent = [event('sign_in', 60), event('sign_in', 86_400 * 89)];
    expect(presentActivity(recent, now, true).complete).toBe(false);
    expect(presentActivity(recent, now, false).complete).toBe(true);
    const crossing = presentActivity([...recent, event('sign_in', 86_400 * 91)], now, true);
    expect(crossing.entries).toHaveLength(2);
    expect(crossing.complete).toBe(true);
    expect(activityPage({ items: recent, nextCursor: 'next', failedLast24Hours: { count: 0, capped: false } }, now, 'en'))
      .toMatchObject({ older: 'next', entries: [{ when: '1 minute ago' }, { when: '3 months ago' }] });
  });
});

describe('security checkup', () => {
  const methods = (change: Partial<SignInMethods> = {}): SignInMethods => ({ password: true, passwordChangedAt: null,
    passkeys: [], totp: null, ...change });
  const passkey = { id: 'p', name: null, provider: null, createdAt: at(0), lastUsedAt: null, backedUp: true };

  test('lists only what needs doing, most urgent first', () => {
    expect(securityCheckup({ emailVerified: false, methods: methods(), failedLast24Hours: 5 }))
      .toEqual(['verify-email', 'failed-sign-ins', 'add-second-step']);
    expect(securityCheckup({ emailVerified: true, methods: methods({ passkeys: [passkey] }), failedLast24Hours: 2 }))
      .toEqual([]);
    expect(securityCheckup({ emailVerified: true, methods: methods({ totp: { name: 'Phone', verified: true } }),
      failedLast24Hours: null })).toEqual([]);
    // An unfinished authenticator setup protects nothing yet; unknown methods raise nothing.
    expect(securityCheckup({ emailVerified: true, methods: methods({ totp: { name: 'Phone', verified: false } }),
      failedLast24Hours: 0 })).toEqual(['add-second-step']);
    expect(securityCheckup({ emailVerified: true, methods: null, failedLast24Hours: null })).toEqual([]);
  });
});

describe('view models', () => {
  test('group repeated sign-ins by client and user agent, keeping every revoke target', () => {
    const device = (id: string, lastActive: number, groupKey: string, thisDevice = false) => ({
      id, createdAt: at(86_400), lastActiveAt: at(lastActive), browser: 'Firefox', platform: 'Linux',
      network: null, clientName: 'REZICS', groupKey, thisDevice });
    expect(deviceViews([device('old', 7_200, 'web-firefox'), device('me', 10_800, 'web-firefox', true),
      device('new', 60, 'other-firefox')], now, 'en').map(view =>
      [view.count, view.thisDevice, view.ids, view.lastActive])).toEqual([
      [2, true, ['old'], '2 hours ago'], [1, false, ['new'], '1 minute ago']]);
  });

  test('describe an app’s permissions in the page’s language', () => {
    const scope = (scope: string, en: string, zh: string) => ({ scope, description: {
      en, 'zh-Hans': zh, 'zh-Hant': zh, ja: en, ko: en, de: en, fr: en, es: en } });
    const [app] = connectedAppViews([{ clientId: 'r', name: 'Reader', uri: null, icon: null, trusted: false,
      withdrawn: false, grantedAt: '2026-09-01T00:00:00Z', lastUsedAt: at(3_600),
      scopes: [scope('openid', 'Identify your REZICS account', '识别你的 REZICS 账号'),
        scope('work:read', 'Read works', '读取作品')] }], now, 'zh-Hans');
    expect(app).toMatchObject({ permissions: ['识别你的 REZICS 账号', '读取作品'], lastUsed: '1小时前' });
    expect(firstPartyPermissionGroups(['openid', 'work:read', 'work:create', 'follow:write', 'access:manage']))
      .toEqual(['account', 'read', 'create', 'participate', 'manage']);
  });

  test('an authenticator key is grouped for typing', () => {
    expect(manualKey('otpauth://totp/REZICS:ada?secret=JBSWY3DPEHPK3PXPABCD&issuer=REZICS'))
      .toBe('JBSW Y3DP EHPK 3PXP ABCD');
  });
});

describe('dates', () => {
  test('are localized once on the server', () => {
    expect(relativeTime('2026-09-27T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(relativeTime('2026-09-26T12:00:00Z', now, 'en')).toBe('yesterday');
    expect(relativeTime('2026-09-27T11:59:40Z', now, 'en')).toBe('this minute');
    expect(relativeTime('2026-09-27T09:00:00Z', now, 'zh-Hans')).toBe('3小时前');
    expect(calendarDate('2026-09-27T23:30:00Z', 'en')).toBe('Sep 27, 2026');
  });
});

describe('consent scopes', () => {
  test('are grouped by what they allow, unknown ones kept verbatim', () => {
    expect(groupScopes(['offline_access', 'work:read', 'openid', 'realm:adopt', 'email', 'openid'])).toEqual([
      { group: 'identity', lines: [{ scope: 'openid', message: 'scopeOpenid' }, { scope: 'email', message: 'scopeEmail' }] },
      { group: 'works', lines: [{ scope: 'work:read', message: 'scopeWorkRead' }] },
      { group: 'other', lines: [{ scope: 'realm:adopt', message: undefined }] },
      { group: 'offline', lines: [{ scope: 'offline_access', message: 'scopeOfflineAccess' }] },
    ]);
  });
});
