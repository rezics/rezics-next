import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  NotificationProducer,
  NotificationProducerWorker,
} from '../src/modules/notification-producers/producer.ts';
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

test('G917: missing responders and safety timeouts leave Access, editorial and relay notifications running', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const message of [
      'Safety responder Account subjects must already exist in Access',
      'statement timeout',
    ]) {
      const calls: string[] = [];
      const failure = new Error(message);
      const query = async (sql: string) => ({
        rows: sql.includes('recovery_fence') ? [{ open: true }] : [],
      });
      const access = {
        query,
        connect: async () => {
          calls.push('access');
          return { query, release: () => {} };
        },
      } as unknown as Pool;
      class Producer extends NotificationProducer {
        override async runEditorialOnce() {
          calls.push('editorial');
          return 7;
        }
        override async runRelayOnce() {
          calls.push('relay');
          return 1;
        }
      }
      const producer = new Producer(
        access,
        null,
        {} as Pool,
        {} as never,
        {} as never,
        null,
        null,
        {
          runOnce: async () => {
            calls.push('safety');
            throw failure;
          },
        },
      );
      expect(await producer.runAccessOnce()).toBe(7);
      expect(calls).toEqual(['access', 'editorial', 'safety']);
      calls.length = 0;
      const worker = new NotificationProducerWorker(producer);
      worker.start();
      await worker.stop();
      expect(calls).toEqual(['access', 'editorial', 'safety', 'relay']);
      expect(logged).toHaveBeenLastCalledWith('Safety alerts:', failure);
    }
  } finally {
    logged.mockRestore();
  }
});
