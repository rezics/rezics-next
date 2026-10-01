import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { EditorialEvent } from '../src/modules/editorial-review/store.ts';
import {
  EDITORIAL_NOTIFICATION_TOPICS,
  editorialNotificationTopic,
} from '../src/modules/notification-producers/editorial.ts';
import {
  SETTINGS_NOTIFICATION_TOPICS,
  optionalNotification,
  REVIEW_NOTIFICATION_TOPICS,
} from '../src/modules/notification/store.ts';
import { notificationRoutes, openApiOperations } from '../src/routes/notifications.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

test('G-866: every G-865 event kind has an explicit notification or internal-progress disposition', () => {
  const migration = readFileSync(
    new URL('../migrations/access/882_editorial_events.sql', import.meta.url),
    'utf8',
  );
  const kinds = [...migration.match(/kind IN \(([^)]+)\)/)![1]!.matchAll(/'([^']+)'/g)].map(
    (match) => match[1],
  );
  expect(Object.keys(EDITORIAL_NOTIFICATION_TOPICS).sort()).toEqual(kinds.sort());
  const expected: Record<EditorialEvent['kind'], string | null> = {
    created: 'review-requested',
    revised: 'proposal-revised',
    reviewed: 'changes-requested',
    applied: 'proposal-decided',
    rejected: 'proposal-decided',
    withdrawn: 'proposal-withdrawn',
    'reversal-proposed': 'review-requested',
    'apply-pending': null,
    'apply-stale': null,
    'apply-cancelled': null,
  };
  for (const kind of Object.keys(expected) as EditorialEvent['kind'][]) {
    expect(editorialNotificationTopic(kind, 'request_changes', null)).toBe(expected[kind]);
  }
  expect(editorialNotificationTopic('applied', null, 'original')).toBe('proposal-reverted');
  expect(editorialNotificationTopic('reviewed', 'approve', null)).toBeNull();
  expect(editorialNotificationTopic('reviewed', 'comment', null)).toBeNull();
  const active = SETTINGS_NOTIFICATION_TOPICS.filter((item) => item.purpose === 'governance').map(
    (item) => item.topic,
  );
  expect(active).toEqual([...REVIEW_NOTIFICATION_TOPICS]);
  for (const topic of active) expect(optionalNotification('governance', topic)).toBe(true);
  expect(optionalNotification('governance', 'submission-decision')).toBe(false);
});

test('G-866: triage and subscriptions are discoverable, scoped, and reject invalid input', async () => {
  const app = notificationRoutes({
    account: {
      verify: async () => {
        throw new Error('must validate first');
      },
    },
  } as unknown as MainWorkDependencies);
  for (const path of [
    '/v1/me/notifications/{item}/triage',
    '/v1/me/proposal-subscriptions/{proposal}',
  ] as const) {
    expect(openApiOperations[path].put.bearer).toBe(true);
  }
  const response = await app.handle(
    new Request('http://main.local/v1/me/notifications?view=archive'),
  );
  expect(response.status).toBe(422);
});
