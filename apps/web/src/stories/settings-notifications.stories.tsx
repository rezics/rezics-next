import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import recording from '../kernel/recorded/settings-preferences.json';
import { m } from '../paraglide/messages.js';
import { NotificationsCard } from '../settings/notifications';
import type { NotificationEditorIO } from '../settings/notification-recovery';

const meta = {
  title: 'Patterns/Account/Notice preferences',
  component: NotificationsCard,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof NotificationsCard>;
export default meta;
type Story = StoryObj;

function Example({
  scenario = 'saved',
}: {
  scenario?: 'saved' | 'lost' | 'stale' | 'unavailable' | 'refused' | 'delayed';
}) {
  const [version, setVersion] = useState(recording.version);
  const [io] = useState<NotificationEditorIO>(() => {
    let current = { notifications: { ...recording.notifications }, version: recording.version };
    let receipt = current;
    let originalKey: string | undefined;
    return {
      save: async (input) => {
        if (scenario === 'delayed' && !originalKey) {
          originalKey = input.idempotencyKey;
          return {
            ok: false,
            reason: 'invalid',
            failure: { status: 400, code: 'invalid_request', retryAfter: '30' },
          };
        }
        if (scenario === 'refused')
          return { ok: false, reason: 'forbidden', failure: { status: 403, code: 'forbidden' } };
        if (scenario === 'stale' && !originalKey) {
          originalKey = input.idempotencyKey;
          current = { notifications: { reply: true, mention: false }, version: input.expectedVersion + 1 };
          return { ok: false, reason: 'conflict', failure: { status: 409, code: 'conflict' } };
        }
        if (originalKey === input.idempotencyKey) return { ok: true, ...receipt };
        originalKey = input.idempotencyKey;
        current = {
          notifications:
            input.notifications === null
              ? { ...recording.notifications }
              : {
                  ...current.notifications,
                  ...Object.fromEntries(
                    Object.entries(input.notifications).filter(
                      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
                    ),
                  ),
                },
          version: input.expectedVersion + 1,
        };
        receipt = current;
        if ((scenario === 'lost' || scenario === 'unavailable') && input.expectedVersion === recording.version)
          return { ok: false, reason: 'unavailable', failure: { status: null } };
        return { ok: true, ...current };
      },
      read: async () =>
        scenario === 'unavailable'
          ? {
              signedIn: true,
              state: 'unavailable',
              failure: { status: 503, code: 'dependency_unavailable' },
              securityHref: null,
            }
          : {
              signedIn: true,
              preferences: { spoilerLevel: 1, suitability: 'blur', version: current.version },
              notifications: current.notifications,
              securityHref: null,
            },
      confirmed: setVersion,
    };
  });
  return (
    <div className="mx-auto max-w-2xl">
      <NotificationsCard
        initial={recording.notifications}
        version={version}
        csrfToken="story-token"
        action="/en/settings"
        onVersionChange={setVersion}
        io={io}
      />
    </div>
  );
}
async function toggle(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('switch', { name: m.settings_notification_reply() }));
  return view;
}
export const OptionalNotices: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
    await view.findByText(m.settings_notifications_mandatory());
    await view.findByText(m.settings_notifications_text());
    const replies = view.getByRole('switch', { name: m.settings_notification_reply() });
    await expect(replies).toHaveAttribute('data-slot', 'switch');
    replies.focus();
    await userEvent.keyboard('[Space]');
    await view.findByText(m.settings_saved());
    await expect(replies).not.toBeChecked();
    await userEvent.keyboard('[Enter]');
    await view.findByText(m.settings_saved());
    await expect(replies).toBeChecked();
  },
};
export const SavedAndRestored: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = await toggle(canvasElement);
    await view.findByText(m.settings_saved());
    await expect(view.getByRole('switch', { name: m.settings_notification_reply() })).not.toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_restore() }));
    await expect(view.getByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
  },
};
export const OriginalSaveRecoveredWithDraft: Story = {
  render: () => <Example scenario="lost" />,
  play: async ({ canvasElement }) => {
    const view = await toggle(canvasElement);
    await view.findByText(m.settings_notifications_uncertain_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await userEvent.click(view.getByRole('switch', { name: m.settings_notification_mention() }));
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_retry_original() }));
    await view.findByText(m.settings_notifications_review_title());
    await expect(view.getByRole('switch', { name: m.settings_notification_mention() })).not.toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_save_draft() }));
    await view.findByText(m.settings_saved());
  },
};
export const StaleChoicesReviewed: Story = {
  render: () => <Example scenario="stale" />,
  play: async ({ canvasElement }) => {
    const view = await toggle(canvasElement);
    await view.findByText(m.settings_conflict_title());
    await userEvent.click(view.getByRole('button', { name: m.settings_reload() }));
    await view.findByText(m.settings_notifications_review_title());
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_use_current() }));
    await expect(view.getByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_notification_mention() })).not.toBeChecked();
  },
};
export const RecoveryReadUnavailable: Story = {
  render: () => <Example scenario="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = await toggle(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_notifications_retry_original() }));
    await view.findByText(m.settings_notifications_uncertain_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await expect(view.getByRole('button', { name: m.settings_notifications_restore() })).toBeDisabled();
  },
};
export const Refused: Story = {
  render: () => <Example scenario="refused" />,
  play: async ({ canvasElement }) => {
    const view = await toggle(canvasElement);
    await view.findByText(m.settings_failed_title());
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await expect(view.getByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
  },
};
export const NativeRetryDelay: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example scenario="delayed" />,
  play: async ({ canvasElement }) => {
    const view = await toggle(canvasElement);
    await view.findByText(m.settings_retry_wait());
    await view.findByText(m.settings_failed_title());
    await expect(view.getByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
    for (const control of view.getAllByRole('switch')) await expect(control).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_notifications_restore() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_reload() })).toBeDisabled();
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await view.findByText(m.settings_notifications_mandatory());
  },
};
