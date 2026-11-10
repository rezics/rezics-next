import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../kernel/recorded/settings-preferences.json';
import { notificationRecoveryTransport, settingsPreferencePage } from '../kernel/fake/settings-notifications';
import { m } from '../paraglide/messages.js';
import { NotificationsCard } from '../settings/notifications';
import type { NotificationEditorIO } from '../settings/notification-recovery';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const meta = {
  title: 'Account/Notice preferences',
  id: 'patterns-account-notice-preferences',
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
          current = {
            notifications: { ...recording.notifications, reply: true, mention: false },
            version: input.expectedVersion + 1,
          };
          return {
            ok: false,
            reason: 'conflict',
            page: settingsPreferencePage(current.notifications, current.version),
            failure: { status: 409, code: 'conflict' },
          };
        }
        if (originalKey === input.idempotencyKey)
          return { ok: true, ...receipt, page: settingsPreferencePage(receipt.notifications, receipt.version) };
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
        return { ok: true, ...current, page: settingsPreferencePage(current.notifications, current.version) };
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
              page: settingsPreferencePage(current.notifications, current.version),
              securityHref: null,
            },
      confirmed: setVersion,
    };
  });
  return (
    <div className="mx-auto max-w-2xl">
      <NotificationsCard
        initial={settingsPreferencePage(recording.notifications, recording.version)}
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
  globals: {},
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('switch', { name: m.settings_notification_reply() })).toBeChecked();
    await view.findByText(m.settings_notifications_mandatory());
    await view.findByText(m.settings_notifications_policy_heading());
    await view.findByText(m.settings_notification_moderation_decision());
    await view.findByRole('link', { name: m.settings_notifications_watches_destination() });
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
  globals: {},
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
  globals: {},
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

const recoveryFixtures = new WeakMap<Element, ReturnType<typeof notificationRecoveryTransport>>();

function DefaultNotificationRecoveryPage() {
  const [fixture, setFixture] = useState<ReturnType<typeof notificationRecoveryTransport> | null>(null);
  useEffect(() => {
    const fallback = globalThis.fetch;
    const transport = notificationRecoveryTransport(fallback);
    globalThis.fetch = transport.fetcher;
    setFixture(transport);
    return () => {
      transport.releaseRead();
      if (globalThis.fetch === transport.fetcher) globalThis.fetch = fallback;
    };
  }, []);
  return (
    <div
      ref={(element) => {
        if (element && fixture) recoveryFixtures.set(element, fixture);
      }}
    >
      {fixture ? <PageStory visitor="Signed In" path="/settings" /> : null}
    </div>
  );
}

export const DefaultReadRecovery: Story = {
  name: 'Default Notifications distinguishes current-setting reads from writes and preserves the draft and original intent through a failed read and explicit recovery',
  tags: ['!dev'],
  parameters: { layout: 'fullscreen' },
  render: () => <DefaultNotificationRecoveryPage />,
  play: async (context) => {
    await pageReady(context);
    const { canvasElement } = context;
    await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    const region = within(canvasElement).getByRole('region', { name: m.settings_notifications_heading() });
    const view = within(region);
    const fixture = recoveryFixtures.get(canvasElement.firstElementChild!)!;
    const reply = view.getByRole('switch', { name: m.settings_notification_reply() });
    const mention = view.getByRole('switch', { name: m.settings_notification_mention() });
    const reload = () => view.getByRole('button', { name: m.settings_reload() });
    const expectNoSave = async () => {
      await expect(view.queryByText(m.settings_saved())).toBeNull();
      await expect(view.queryByText(m.settings_failed_title())).toBeNull();
      await expect(view.queryByText('Private notification read diagnostic')).toBeNull();
    };
    await expect(fixture.reads).toHaveLength(1);
    await expect(reply).toBeChecked();
    await expect(mention).toBeChecked();
    fixture.failNextRead(503, 'dependency_unavailable', '2');
    fixture.pauseNextRead();
    await userEvent.click(reload());
    try {
      const status = await view.findByRole('status');
      await expect(status).toHaveTextContent(m.settings_notifications_reading());
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(view.queryByText(m.settings_saving())).toBeNull();
      await expect(reload()).toBeDisabled();
      await expect(fixture.reads).toHaveLength(2);
      await expect(fixture.commands).toHaveLength(0);
    } finally {
      fixture.releaseRead();
    }
    const failure = (await view.findByText(m.settings_notifications_read_failed())).closest('[role="alert"]')!;
    await expect(failure).toHaveTextContent(m.settings_notifications_read_unavailable());
    await expect(failure).toHaveAttribute('data-response-status', '503');
    await expect(failure).toHaveAttribute('data-response-code', 'dependency_unavailable');
    await expect(failure).toHaveAttribute('data-retry-after', '2');
    await view.findByText(m.settings_notifications_retained());
    await expect(reply).toBeChecked();
    await expect(mention).toBeChecked();
    await expect(reload()).toBeDisabled();
    await userEvent.click(reload());
    // Edits made while current values are unknown remain local, including during Retry-After.
    await userEvent.click(reply);
    await expect(reply).not.toBeChecked();
    await expect(view.getByRole('button', { name: m.settings_notifications_restore() })).toBeDisabled();
    await expect(fixture.commands).toHaveLength(0);
    await expectNoSave();
    await waitFor(() => expect(reload()).toBeEnabled(), { timeout: 5000 });
    await expect(fixture.reads).toHaveLength(2);
    await expect(fixture.commands).toHaveLength(0);

    for (const [code, explanation] of [
      ['forbidden', m.settings_notifications_read_denied()],
      ['platform_closed', m.settings_notifications_read_closed()],
    ] as const) {
      const before = fixture.reads.length;
      fixture.failNextRead(403, code);
      await userEvent.click(reload());
      await view.findByText(explanation);
      const alert = view.getByRole('alert');
      await expect(alert).toHaveAttribute('data-response-status', '403');
      await expect(alert).toHaveAttribute('data-response-code', code);
      await expect(fixture.reads).toHaveLength(before + 1);
      await expect(fixture.commands).toHaveLength(0);
      await expect(reply).not.toBeChecked();
      await expect(mention).toBeChecked();
      await expectNoSave();
    }
    fixture.concurrent({ reply: true, mention: false });
    const beforeRecovery = fixture.reads.length;
    await userEvent.click(reload());
    await view.findByText(m.settings_notifications_review_title());
    await expect(fixture.reads).toHaveLength(beforeRecovery + 1);
    await expect(fixture.commands).toHaveLength(0);
    await expect(reply).not.toBeChecked();
    await expect(mention).toBeChecked();
    await expect(view.queryByText(m.settings_notifications_retained())).toBeNull();
    await expectNoSave();
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_use_current() }));
    await expect(reply).toBeChecked();
    await expect(mention).not.toBeChecked();
    for (const input of region.querySelectorAll<HTMLInputElement>('[name="expectedVersion"]'))
      await expect(input.value).toBe('2');

    // A real automatic save loses its response; a later draft must never replace its original identity.
    await userEvent.click(reply);
    await view.findByText(m.settings_notifications_uncertain_title());
    await expect(fixture.commands).toHaveLength(1);
    const original = { ...fixture.commands[0]! };
    await expect(original).toMatchObject({ method: 'PATCH', path: '/v1/accounts/story-viewer/preferences' });
    await expect(JSON.parse(original.body)).toEqual({ expectedVersion: 2, notifications: { reply: false } });
    await expect(JSON.parse(original.key!)).toMatch(/^[0-9a-f-]{36}$/);
    await userEvent.click(mention);
    await expect(fixture.commands).toHaveLength(1);
    const beforeReplayRead = fixture.reads.length;
    fixture.failNextRead(503, 'dependency_unavailable', '2');
    fixture.pauseNextRead();
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_retry_original() }));
    try {
      await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(m.settings_notifications_reading()));
      await expect(view.queryByText(m.settings_saving())).toBeNull();
      await expect(fixture.commands[1]).toEqual(original);
      await expect(fixture.reads).toHaveLength(beforeReplayRead + 1);
    } finally {
      fixture.releaseRead();
    }
    await view.findByText(m.settings_notifications_read_failed());
    await view.findByText(m.settings_notifications_uncertain_title());
    await expect(reply).not.toBeChecked();
    await expect(mention).toBeChecked();
    await expect(view.queryByRole('button', { name: m.settings_reload() })).toBeNull();
    await expect(view.getByRole('button', { name: m.settings_notifications_restore() })).toBeDisabled();
    const retry = view.getByRole('button', { name: m.settings_notifications_retry_original() });
    await expect(retry).toBeDisabled();
    await userEvent.click(retry);
    await expect(fixture.commands).toHaveLength(2);
    await expectNoSave();
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 5000 });
    await expect(fixture.commands).toHaveLength(2);
    await expect(fixture.reads).toHaveLength(beforeReplayRead + 1);
    fixture.concurrent({ reply: true, mention: false });
    await userEvent.click(retry);
    await view.findByText(m.settings_notifications_review_title());
    await expect(fixture.commands).toHaveLength(3);
    await expect(fixture.commands[2]).toEqual(original);
    await expect(fixture.reads).toHaveLength(beforeReplayRead + 2);
    await expect(reply).not.toBeChecked();
    await expect(mention).toBeChecked();
    await expectNoSave();
    for (const input of region.querySelectorAll<HTMLInputElement>('[name="expectedVersion"]'))
      await expect(input.value).toBe('4');
    await userEvent.click(view.getByRole('button', { name: m.settings_notifications_save_draft() }));
    await view.findByText(m.settings_saved());
    await expect(fixture.commands).toHaveLength(4);
    await expect(JSON.parse(fixture.commands[3]!.body)).toEqual({
      expectedVersion: 4,
      notifications: { reply: false, mention: true },
    });
    await expect(fixture.commands[3]!.key).not.toBe(original.key);
    const beforeRefresh = fixture.reads.length;
    await userEvent.click(reload());
    await waitFor(() => expect(reload()).toBeEnabled());
    await expect(fixture.reads).toHaveLength(beforeRefresh + 1);
    await expect(fixture.commands).toHaveLength(4);
    await expectNoSave();
    for (const read of fixture.reads) {
      await expect(read.path).toBe('/v1/accounts/story-viewer/preferences');
      await expect(read.authorization).toBe('Bearer recorded-story-token');
      await expect(read.key).toBeNull();
    }
    for (const command of fixture.commands) {
      await expect(command.authorization).toBe('Bearer recorded-story-token');
      await expect(command.contentType).toContain('application/merge-patch+json');
    }
  },
};
