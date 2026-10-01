import { expect, test } from 'bun:test';
import { safetyResponders, SAFETY_ALERT_COST } from '../src/modules/safety-alerts/store.ts';
import { safetyAlertMessage } from '../../account/src/notification-safety.ts';
import type { AccountLocale } from '../../account/src/email.ts';

test('G917: safety roster is explicit, distinct and refuses launch placeholders', () => {
  const issuer = 'https://account.example.test/api/auth';
  expect(safetyResponders(issuer)).toBeNull();
  expect(safetyResponders(issuer, 'owner', 'backup')).toEqual({
    issuer,
    primary: 'owner',
    backup: 'backup',
  });
  for (const [primary, backup] of [
    ['owner', undefined],
    [undefined, 'backup'],
    ['owner', 'owner'],
    ['owner', 'TBD'],
    ['owner', '<Account subject>'],
    ['owner', ''],
    ['owner', ' backup'],
  ]) {
    expect(() => safetyResponders(issuer, primary, backup)).toThrow();
  }
  expect(SAFETY_ALERT_COST.acknowledgementMs).toBeLessThan(SAFETY_ALERT_COST.leadMs);
});

test('G917: every Account locale has actionable evidence-free deadline and absence copy', () => {
  const deadline = '2026-10-01T00:00:00.000Z';
  for (const locale of [
    'en',
    'zh-Hans',
    'zh-Hant',
    'ja',
    'ko',
    'de',
    'fr',
    'es',
  ] as AccountLocale[]) {
    const messages = ['approaching', 'unacknowledged', 'overdue'].map((reason) =>
      safetyAlertMessage(locale, deadline, reason as 'approaching' | 'unacknowledged' | 'overdue'),
    );
    expect(new Set(messages).size).toBe(3);
    for (const message of messages) {
      expect(message).toContain(deadline);
      expect(message).not.toContain('credential');
      expect(message).not.toContain('evidence');
    }
  }
});
