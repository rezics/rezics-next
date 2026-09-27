import { describe, expect, test } from 'bun:test';
import { describeUserAgent } from '../features/account/device.ts';
import { calendarDate, relativeTime } from '../features/account/format.ts';
import { groupScopes } from '../features/consent/scopes.ts';

describe('device names', () => {
  test('come from the session’s User-Agent', () => {
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'))
      .toEqual({ browser: 'Chrome', os: 'macOS', kind: 'computer' });
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'))
      .toEqual({ browser: 'Safari', os: 'iOS', kind: 'phone' });
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'))
      .toEqual({ browser: 'Edge', os: 'Windows', kind: 'computer' });
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'))
      .toEqual({ browser: 'Chrome', os: 'Android', kind: 'phone' });
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'))
      .toEqual({ browser: 'Firefox', os: 'Linux', kind: 'computer' });
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null, kind: 'unknown' });
  });
});

describe('dates', () => {
  test('are localized once on the server', () => {
    const now = new Date('2026-09-27T12:00:00Z');
    expect(relativeTime('2026-09-27T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(relativeTime('2026-09-26T12:00:00Z', now, 'en')).toBe('yesterday');
    expect(relativeTime('2026-09-27T11:59:40Z', now, 'en')).toBe('this minute');
    expect(relativeTime('2026-09-27T09:00:00Z', now, 'zh-CN')).toBe('3小时前');
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
