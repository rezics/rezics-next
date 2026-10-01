import { describe, expect, test } from 'bun:test';
import { SETTINGS_NOTIFICATION_TOPICS } from '../../../services/main/src/modules/notification/store.ts';
import { notificationTopicLabel, settingsNotificationTopics, topicsShown }
  from '../features/settings/settings-sections.tsx';
import { notificationsHref, parseSelection } from '../features/shell/notifications/window.ts';

describe('G-868 settings topics', () => {
  const api = SETTINGS_NOTIFICATION_TOPICS.map(item => item.topic);

  test('the page’s labels are exactly the topics the preferences API returns', () => {
    expect([...settingsNotificationTopics]).toEqual(api);
    expect(Object.keys(notificationTopicLabel)).toEqual([...settingsNotificationTopics]);
  });

  test('a response that omits a topic omits it, and one the API does not return is not in the label map', () => {
    const items = api.flatMap(topic => [{ topic }, { topic }]);
    expect(topicsShown(items)).toEqual(api);
    expect(topicsShown(items.filter(item => item.topic !== 'mention'))).toEqual(api.filter(topic => topic !== 'mention'));
    expect(topicsShown(items)).not.toContain('realm-invitation');
    expect(settingsNotificationTopics).not.toContain('realm-invitation');
    // The list follows the response, so a topic Main adds still appears until a label is required.
    expect(topicsShown([...items, { topic: 'realm-invitation' }])).toEqual([...api, 'realm-invitation']);
  });
});

test('G-868: the inbox keeps its view and reason in the URL', () => {
  expect(parseSelection({})).toEqual({ view: 'inbox', reason: null });
  expect(parseSelection({ view: 'saved', reason: 'author' })).toEqual({ view: 'saved', reason: 'author' });
  expect(parseSelection({ view: 'nope', reason: 'mention' })).toEqual({ view: 'inbox', reason: null });
  expect(notificationsHref({ view: 'inbox', reason: null })).toBe('/notifications');
  expect(notificationsHref({ view: 'done', reason: 'steward' })).toBe('/notifications?view=done&reason=steward');
  for (const reason of ['steward', 'author', 'reviewer', 'manual'] as const) {
    const href = notificationsHref({ view: 'saved', reason });
    expect(parseSelection(Object.fromEntries(new URL(href, 'https://rezics.test').searchParams)))
      .toEqual({ view: 'saved', reason });
  }
});
