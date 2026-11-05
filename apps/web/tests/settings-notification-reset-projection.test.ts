import { expect, mock, test } from 'bun:test';
import { settingsPreferencePage } from '../src/kernel/fake/settings-notifications';
import { NotificationEditor } from '../src/settings/notification-recovery';
import type { NotificationWriteResult } from '../src/settings/preferences';

mock.module('cloudflare:workers', () => ({ env: {} }));

const optional = { reply: true, mention: true, thread_watch: true, board_activity: true };

test('restore defaults that meets a newer page previews the catalogue defaults, not the values it replaces', async () => {
  const known = settingsPreferencePage({ ...optional, reply: false }, 7);
  const newer = settingsPreferencePage({ ...optional, mention: false }, 8);
  const editor = new NotificationEditor(known, {
    read: () => Promise.reject(new Error('no read expected')),
    save: async (): Promise<NotificationWriteResult> => ({ ok: false, reason: 'conflict', page: newer }),
  });
  await editor.restore(7);
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    intent: null,
    draft: optional,
    known: { version: 8, notifications: { ...optional, mention: false } },
  });
});
