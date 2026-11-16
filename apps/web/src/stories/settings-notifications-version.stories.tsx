import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { notificationName } from '../settings/notifications';
import { settingsPreferencePage } from '../kernel/fake/settings-notifications';
import { readingAdviceFor } from '../settings/reading-preferences';
import type {
  NotificationChange,
  NotificationPreferences,
  NotificationWriteResult,
  ReadingPreferences,
} from '../settings/preferences';
import { SettingsPageView } from '../settings/settings-page';
import { settingsContent } from '../settings/adapters/presentation';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const meta = {
  title: 'Account/Settings/Settings',
  id: 'pages-account-settings',
  component: SettingsPageView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof SettingsPageView>;
export default meta;
type Story = StoryObj;
type PreferenceIO = NonNullable<ComponentProps<typeof SettingsPageView>['preferenceIO']>;

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Local scheduling only; the page still owns its session guards, editors and shared version. */
function controlledPreferences() {
  let preferences: ReadingPreferences = { spoilerLevel: 0, suitability: 'blur', version: 1 };
  let notifications: NotificationPreferences = {
    reply: true,
    mention: true,
    thread_watch: true,
    board_activity: true,
  };
  let loseNext = true;
  let heldRead: ReturnType<typeof gate> | undefined;
  let heldWrite: ReturnType<typeof gate> | undefined;
  const gates: ReturnType<typeof gate>[] = [];
  const receipts = new Map<string, NotificationWriteResult>();
  const commands: { input: NotificationChange; key: string; body: string; token: string }[] = [];
  const readingCommands: Parameters<PreferenceIO['saveReading']>[0][] = [];
  const current = () => ({
    signedIn: true as const,
    accountId: 'story-viewer',
    securityHref: null,
    preferences: { ...preferences, advice: readingAdviceFor(preferences) },
    notifications: { ...notifications },
    page: settingsPreferencePage(notifications, preferences.version),
  });
  const reads: ReturnType<typeof current>[] = [];
  const io: PreferenceIO = {
    read: async () => {
      const page = current();
      reads.push(page);
      const held = heldRead;
      heldRead = undefined;
      await held?.promise;
      return page;
    },
    saveReading: async (input) => {
      readingCommands.push(input);
      if (input.expectedVersion !== preferences.version) return { ok: false, reason: 'conflict' };
      preferences = {
        spoilerLevel: input.spoilerLevel ?? preferences.spoilerLevel,
        suitability: input.suitability ?? preferences.suitability,
        version: preferences.version + 1,
      };
      return { ok: true, preferences: { ...preferences, advice: readingAdviceFor(preferences) } };
    },
    saveNotifications: async (input, token) => {
      const { idempotencyKey, ...body } = input;
      commands.push({ input, key: idempotencyKey, body: JSON.stringify(body), token });
      const receipt = receipts.get(idempotencyKey);
      if (receipt) return receipt;
      if (input.expectedVersion !== preferences.version)
        return {
          ok: false,
          reason: 'conflict',
          page: settingsPreferencePage(notifications, preferences.version),
        };
      notifications =
        input.notifications === null
          ? { reply: true, mention: true, thread_watch: true, board_activity: true }
          : {
              ...notifications,
              ...Object.fromEntries(
                Object.entries(input.notifications).filter(
                  (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
                ),
              ),
            };
      preferences = { ...preferences, version: preferences.version + 1 };
      const result: NotificationWriteResult = {
        ok: true,
        notifications: { ...notifications },
        version: preferences.version,
        page: settingsPreferencePage(notifications, preferences.version),
      };
      receipts.set(idempotencyKey, result);
      const held = heldWrite;
      heldWrite = undefined;
      await held?.promise;
      if (loseNext) {
        loseNext = false;
        return { ok: false, reason: 'unavailable' };
      }
      return result;
    },
  };
  return {
    io,
    current,
    reads,
    commands,
    readingCommands,
    loseNext: () => {
      loseNext = true;
    },
    concurrent: (patch: NotificationPreferences) => {
      notifications = { ...notifications, ...patch };
      preferences = { ...preferences, version: preferences.version + 1 };
    },
    holdRead: () => {
      heldRead = gate();
      gates.push(heldRead);
      return heldRead.release;
    },
    holdWrite: () => {
      heldWrite = gate();
      gates.push(heldWrite);
      return heldWrite.release;
    },
    release: () => gates.forEach((held) => held.release()),
  };
}

const compositions = new WeakMap<Element, ReturnType<typeof controlledPreferences>>();
function NotificationVersionComposition() {
  const [fixture] = useState(controlledPreferences);
  const [page] = useState(fixture.current);
  useEffect(() => () => fixture.release(), [fixture]);
  return (
    <div
      data-notification-version-story
      ref={(element) => {
        if (element) compositions.set(element, fixture);
      }}
    >
      <AppShell>
        <SettingsPageView page={page} csrfToken={null} preferenceIO={fixture.io} content={settingsContent} />
      </AppShell>
    </div>
  );
}

export const SharedVersionRecovery: Story = {
  name: 'A newer shared Settings version cannot authorize an older Notifications review draft and uncertain commands retain exact retries',
  tags: ['!dev'],
  render: () => (
    <PatternStory visitor="Signed In" path="/settings#notifications">
      <NotificationVersionComposition />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole('region', { name: m.inbox_notification_preferences() });
    const notices = within(region);
    const fixture = compositions.get(canvasElement.querySelector('[data-notification-version-story]')!)!;
    const reply = () => notices.getByRole('switch', { name: m.settings_notification_reply() });
    const mention = () => notices.getByRole('switch', { name: m.settings_notification_mention() });
    const digest = () => notices.getByRole('switch', { name: notificationName('thread_watch') });
    const reload = () => notices.getByRole('button', { name: m.settings_reload() });
    const save = () => notices.getByRole('button', { name: m.settings_notifications_save_draft() });
    const retry = () => notices.getByRole('button', { name: m.settings_notifications_retry_original() });
    const versionFields = async (version: number) => {
      const fields = region.querySelectorAll<HTMLInputElement>('[name="expectedVersion"]');
      await expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) await expect(field.value).toBe(String(version));
    };
    const noCurrentClaim = async () => {
      await expect(notices.queryByText(m.settings_saved())).toBeNull();
      await expect(notices.queryByText(m.settings_notifications_review_title())).toBeNull();
    };
    const advanceReading = async (level: 0 | 1 | 2) => {
      await selectSettingsCategory(canvasElement, m.settings_reading_heading());
      const reading = within(canvas.getByRole('region', { name: m.settings_reading_heading() }));
      const beforeWrite = fixture.readingCommands.length;
      const version = fixture.current().preferences.version;
      await userEvent.click(
        reading.getByRole('radio', {
          name: ([m.settings_spoiler_0_title(), m.settings_spoiler_1_title(), m.settings_spoiler_2_title()] as const)[
            level
          ],
        }),
      );
      if (reading.queryByText(m.settings_conflict_title())) {
        const beforeRead = fixture.reads.length;
        await userEvent.click(reading.getByRole('button', { name: m.settings_reload() }));
        const saveDraft = await reading.findByRole('button', { name: m.settings_reading_save_draft() });
        await expect(fixture.reads).toHaveLength(beforeRead + 1);
        await userEvent.click(saveDraft);
      }
      await reading.findByText(m.settings_saved());
      await expect(
        fixture.readingCommands.slice(beforeWrite).filter((command) => command.expectedVersion === version),
      ).toMatchObject([{ expectedVersion: version, spoilerLevel: level }]);
      await selectSettingsCategory(canvasElement, m.settings_notifications_heading());
    };

    const reaffirm = async (choice: HTMLElement) => {
      await userEvent.click(choice);
      await userEvent.click(choice);
    };

    // Only choices made after dispatch can survive acknowledgement and rebase.
    await waitFor(() => expect(reply()).toHaveAttribute('data-slot', 'switch'));
    await userEvent.click(reply());
    await notices.findByText(m.settings_notifications_uncertain_title());
    const original = fixture.commands[0]!;
    await userEvent.click(mention());
    await reaffirm(reply());
    await reaffirm(digest());
    await userEvent.click(retry());
    await notices.findByText(m.settings_notifications_review_title());
    await expect(fixture.commands[1]!.input).toBe(original.input);
    await expect(fixture.commands[1]).toEqual(original);
    const baseline = fixture.current().preferences.version;
    await versionFields(baseline);

    fixture.concurrent({ reply: true, thread_watch: false });
    await advanceReading(1);
    const writesBefore = fixture.commands.length;
    await userEvent.click(save());
    await notices.findByText(m.settings_conflict_title());
    await expect(fixture.commands).toHaveLength(writesBefore);
    await expect(reply()).not.toBeChecked();
    await expect(mention()).not.toBeChecked();
    await expect(digest()).toBeChecked();
    await versionFields(baseline);

    // A read captured before another actual Reading write cannot establish current values on completion.
    const releaseRead = fixture.holdRead();
    await userEvent.click(reload());
    try {
      await notices.findByText(m.settings_notifications_reading());
      await advanceReading(2);
    } finally {
      releaseRead();
    }
    await notices.findByText(m.settings_notifications_read_failed());
    await noCurrentClaim();
    await expect(fixture.commands).toHaveLength(writesBefore);
    await versionFields(baseline);
    await userEvent.click(reload());
    await notices.findByText(m.settings_notifications_review_title());
    const reviewedVersion = fixture.current().preferences.version;
    await expect(fixture.commands).toHaveLength(writesBefore);
    await versionFields(reviewedVersion);
    const review = notices.getByText(m.settings_notifications_review_title()).closest('[role="alert"]')!;
    await expect(review).toHaveTextContent(`${m.settings_notification_reply()}: ${m.settings_notifications_on()}`);
    await expect(review).toHaveTextContent(`${notificationName('thread_watch')}: ${m.settings_notifications_off()}`);
    await expect(digest()).toBeChecked(); // Local intent is independent of the current-value list.

    // A definite older write receipt clears its command, but must require another current read.
    const releaseWrite = fixture.holdWrite();
    await userEvent.click(save());
    const deliberate = fixture.commands.at(-1)!;
    await expect(deliberate.input).toEqual({
      expectedVersion: reviewedVersion,
      notifications: { reply: false, mention: false, thread_watch: true },
      idempotencyKey: deliberate.key,
    });
    await expect(deliberate.key).not.toBe(original.key);
    const receiptVersion = fixture.current().preferences.version;
    try {
      await notices.findByText(m.settings_saving());
      fixture.concurrent({ thread_watch: false });
      await advanceReading(0);
    } finally {
      releaseWrite();
    }
    await notices.findByText(m.settings_conflict_title());
    await noCurrentClaim();
    await expect(notices.queryByRole('button', { name: m.settings_notifications_retry_original() })).toBeNull();
    await versionFields(receiptVersion);
    const writesAfterReceipt = fixture.commands.length;
    await reaffirm(digest());
    await userEvent.click(reload());
    await notices.findByText(m.settings_notifications_review_title());
    await expect(digest()).toBeChecked();
    await userEvent.click(notices.getByRole('button', { name: m.settings_notifications_use_current() }));
    await expect(fixture.commands).toHaveLength(writesAfterReceipt);
    await expect(digest()).not.toBeChecked();

    // Retry sends the exact uncertain command. A stale read after acknowledgement can only be reloaded.
    fixture.loseNext();
    const uncertainBaseline = fixture.current().preferences.version;
    await userEvent.click(reply());
    await notices.findByText(m.settings_notifications_uncertain_title());
    const uncertain = fixture.commands.at(-1)!;
    const beforeRetry = fixture.commands.length;
    await expect(Object.isFrozen(uncertain.input)).toBe(true);
    await expect(Object.isFrozen(uncertain.input.notifications)).toBe(true);
    await userEvent.click(mention());
    await reaffirm(reply());
    await reaffirm(digest());
    const releaseReplayRead = fixture.holdRead();
    await userEvent.click(retry());
    try {
      await notices.findByText(m.settings_notifications_reading());
      await advanceReading(1);
    } finally {
      releaseReplayRead();
    }
    await notices.findByText(m.settings_notifications_read_failed());
    await expect(notices.queryByText(m.settings_notifications_uncertain_title())).toBeNull();
    await expect(notices.queryByRole('button', { name: m.settings_notifications_retry_original() })).toBeNull();
    await noCurrentClaim();
    await versionFields(uncertainBaseline);
    await expect(fixture.commands).toHaveLength(beforeRetry + 1);
    await expect(fixture.commands.at(-1)!.input).toBe(uncertain.input);
    await expect(fixture.commands.at(-1)).toEqual(uncertain);
    await expect(notices.getByRole('button', { name: m.settings_notifications_restore() })).toBeDisabled();
    await expect(reply()).toBeChecked();
    await expect(mention()).toBeChecked();
    await userEvent.click(reload());
    await notices.findByText(m.settings_notifications_review_title());
    await expect(fixture.commands).toHaveLength(beforeRetry + 1);
    const finalBaseline = fixture.current().preferences.version;
    await versionFields(finalBaseline);
    await userEvent.click(save());
    await notices.findByText(m.settings_saved());
    await expect(fixture.commands.at(-1)!.input).toMatchObject({
      expectedVersion: finalBaseline,
      notifications: { reply: true, mention: true, thread_watch: false },
    });
    await expect(fixture.commands.at(-1)!.key).not.toBe(uncertain.key);
    for (const command of fixture.commands) await expect(command.token).toBe('story-csrf-token');
    await notices.findByText(m.settings_notifications_mandatory());
  },
};
