import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { uiLocales } from '../i18n/define.ts';
import { messages } from '../features/shell/notifications/messages.ts';
import { messages as settingsMessages } from '../features/settings/messages.ts';
import {
  notificationChannels,
  notificationTopicLabel,
  settingsNotificationTopics,
} from '../features/settings/notification-settings.tsx';
import { SETTINGS_NOTIFICATION_TOPICS } from '../../../services/main/src/modules/notification/store.ts';

test('G-966 all eight locales name new-Work notices and all three existing channels', () => {
  const english = materializeData(messages.en, { locale: 'en' }).newWorkIn({
    topic: 'Fantasy',
    title: '雨夜书店',
  });
  for (const locale of uiLocales) {
    const text = materializeData(messages[locale], { locale }).newWorkIn({
      topic: 'Fantasy',
      title: '雨夜书店',
    });
    expect(text).toContain('Fantasy');
    expect(text).toContain('雨夜书店');
    expect(text).not.toContain('{{');
    if (locale !== 'en') expect(text).not.toBe(english);
    const settings = materializeData(settingsMessages[locale], { locale });
    for (const key of [
      'notificationNewWork',
      'notificationPush',
      'notificationEmailDigest',
    ] as const)
      expect(settings[key].length).toBeGreaterThan(0);
  }
  expect(
    materializeData(messages.en, { locale: 'en' }).newWorkIn({ topic: 'Fantasy', title: 'Book' }),
  ).toBe('New in Fantasy: Book');
});

test('G-966 the new-Work setting uses the active producer topic and existing channel identities', () => {
  expect([...settingsNotificationTopics]).toEqual(
    SETTINGS_NOTIFICATION_TOPICS.map((item) => item.topic),
  );
  expect(notificationTopicLabel['new-work']).toBe('notificationNewWork');
  expect(notificationChannels).toEqual(['inbox', 'push', 'email']);
  expect(SETTINGS_NOTIFICATION_TOPICS.find((item) => item.topic === 'new-work')).toEqual({
    purpose: 'subscription',
    topic: 'new-work',
  });
});
