import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { NotificationSettings, notificationChannels, settingsNotificationTopics, notificationTopicLabel } from './notification-settings.tsx';
import { englishMessages, type SettingsMessages } from './messages.ts';
import ja from './messages/ja.ts';
import de from './messages/de.ts';

const meta = {
  title: 'Settings/Notifications',
  component: NotificationSettings,
  args: { t: englishMessages, preview: true },
  decorators: [Story => <div className="mx-auto max-w-2xl p-4"><Story /></div>],
} satisfies Meta<typeof NotificationSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectPhoneChannels(canvasElement: HTMLElement, t: SettingsMessages) {
  const canvas = within(canvasElement);
  for (const topic of ['reply', 'review', 'proposal-reverted'] as const) {
    const control = canvas.getByRole('switch', {
      name: `${t[notificationTopicLabel[topic]]} · ${t.notificationEmailDigest}`,
    });
    control.scrollIntoView({ block: 'center' });
    const row = within(control.closest('[data-slot="field"]')!.parentElement!);
    for (const channel of [t.notificationInbox, t.notificationPush, t.notificationEmailDigest]) {
      await expect(row.getByText(channel, { exact: true })).toBeVisible();
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  }
}

async function expectFeedbackInViewport(status: HTMLElement) {
  // toBeVisible also passes for content below the viewport. Read geometry without scrolling
  // so an async result must reveal its complete text and recovery itself.
  await waitFor(async () => {
    const bounds = status.parentElement!.getBoundingClientRect();
    await expect(bounds.top).toBeGreaterThanOrEqual(0);
    await expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    await expect(bounds.left).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  });
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const NewWorkChannels: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const channel of [englishMessages.notificationInbox, englishMessages.notificationPush,
      englishMessages.notificationEmailDigest]) {
      await expect(
        canvas.getByRole('switch', {
          name: `${englishMessages.notificationNewWork} · ${channel}`,
        }),
      ).toBeVisible();
    }
    if (window.innerWidth <= 390) await expectPhoneChannels(canvasElement, englishMessages);
  },
};
export const Phone: Story = { ...NewWorkChannels, globals: { viewport: { value: 'phone' } } };
export const Japanese: Story = { args: { t: ja }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await expectPhoneChannels(canvasElement, ja); } };
export const GermanPhone: Story = { args: { t: de }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await expectPhoneChannels(canvasElement, de); } };

/** The existing preference command saves each channel independently and preserves its CAS revision. */
export const SaveEmailDigest: Story = {
  args: { preview: false },
  async beforeEach() {
    const prior = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        await expect(body).toMatchObject({
          profile: 'notification-preference-v1',
          purpose: 'subscription',
          topic: 'new-work',
          channel: 'email',
          state: 'enabled',
          expectedRevision: '7',
        });
        await expect(body.idempotencyKey).toBeTruthy();
        return Response.json({ state: body.state, revision: '8' });
      }
      return Response.json({
        items: ['inbox', 'push', 'email'].map((channel) => ({
          purpose: 'subscription',
          topic: 'new-work',
          channel,
          state: channel === 'email' ? 'disabled' : 'enabled',
          revision: '7',
        })),
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = prior;
    };
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const digest = await canvas.findByRole('switch', {
      name: `${englishMessages.notificationNewWork} · ${englishMessages.notificationEmailDigest}`,
    });
    await expect(digest).not.toBeChecked();
    await userEvent.click(digest);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Notification choice saved.');
    await expect(digest).toBeChecked();
    await expect(
      canvas.getByRole('switch', {
        name: `${englishMessages.notificationNewWork} · ${englishMessages.notificationPush}`,
      }),
    ).toBeChecked();
  },
};

/** Browser-only responses: all 45 choices, delayed writes, and recovery without account writes. */
function saveScenario(topic: (typeof settingsNotificationTopics)[number], firstStatus: 200 | 503 | 409,
  phone: boolean, recover = false, savingOnly = false, refreshFails = false): Story {
  let release: () => void;
  let releaseRefresh: () => void;
  let commands: Record<string, unknown>[];
  return {
    args: { preview: false },
    globals: { viewport: { value: phone ? 'phone' : 'desktop1440' } },
    async beforeEach() {
      commands = [];
      let revision = '7';
      let failedRead = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
      const prior = globalThis.fetch;
      globalThis.fetch = (async (_url, init) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          commands.push(body);
          if (commands.length === 1) {
            await gate;
            if (firstStatus === 409) revision = '8';
            if (firstStatus !== 200) return new Response(null, { status: firstStatus });
          }
          return Response.json({ state: body.state, revision: '9' });
        }
        if (revision === '8' && refreshFails && !failedRead) {
          failedRead = true;
          return new Response(null, { status: 503 });
        }
        if (revision === '8' && refreshFails) await refreshGate;
        return Response.json({ items: settingsNotificationTopics.flatMap(topic => notificationChannels.map(channel => ({
          purpose: topic.startsWith('proposal') || topic.endsWith('requested') ? 'governance'
            : ['new-work', 'new-release', 'followed-chapter', 'collection-change'].includes(topic) ? 'subscription' : 'social',
          topic, channel, state: channel === 'email' || (revision === '8' && channel === 'push')
            ? 'disabled' : 'enabled', revision,
        }))) });
      }) as typeof fetch;
      return () => { release(); releaseRefresh(); globalThis.fetch = prior; };
    },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      const label = englishMessages[notificationTopicLabel[topic]];
      const name = `${label} · ${englishMessages.notificationEmailDigest}`;
      const control = await canvas.findByRole('switch', { name });
      control.scrollIntoView({ block: 'center' });
      const status = canvasElement.ownerDocument.getElementById(control.getAttribute('aria-describedby')!)!;
      const cell = within(status.parentElement!);
      if (phone) await expect(cell.getByText(englishMessages.notificationEmailDigest)).toBeVisible();
      await userEvent.click(control);
      await expect(status).toHaveTextContent(englishMessages.notificationSaving);
      await expect(status).toBeVisible();
      await expectFeedbackInViewport(status);
      for (const item of canvas.getAllByRole('switch')) await expect(item).toBeDisabled();
      await expect(control).not.toBeChecked();
      if (savingOnly) return;
      release();
      const expected = firstStatus === 200 ? englishMessages.notificationSaved
        : firstStatus === 503 ? englishMessages.notificationFailed
          : refreshFails ? englishMessages.notificationRefreshFailed : englishMessages.notificationConflict;
      await waitFor(() => expect(status).toHaveTextContent(expected));
      await expect(control).toBeEnabled();
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute('role', 'status');
      await expectFeedbackInViewport(status);
      if (firstStatus === 200) await expect(control).toBeChecked();
      else await expect(control).not.toBeChecked();
      if (firstStatus === 409 && !refreshFails) {
        await expect(canvas.getByRole('switch', { name: `${label} · ${englishMessages.notificationPush}` })).not.toBeChecked();
      }
      if (recover) {
        if (refreshFails) {
          cell.getByRole('button', { name: `${englishMessages.reviewLatest} · ${name}` }).focus();
          await userEvent.keyboard('{Enter}');
          await waitFor(() => expect(status).toHaveTextContent(englishMessages.notificationRefreshing));
          releaseRefresh();
          await waitFor(() => expect(status).toHaveTextContent(englishMessages.notificationConflict));
          await expect(cell.getByRole('button', { name: `${englishMessages.notificationEnable} · ${name}` })).toHaveFocus();
          await expectFeedbackInViewport(status);
          await expect(commands).toHaveLength(1);
        }
        await userEvent.click(cell.getByRole('button', { name: `${englishMessages.notificationEnable} · ${name}` }));
        await waitFor(() => expect(status).toHaveTextContent(englishMessages.notificationSaved));
        await expectFeedbackInViewport(status);
        await expect(control).toBeChecked();
        await expect(commands).toHaveLength(2);
        await expect(commands[1]).toMatchObject({ topic, channel: 'email', state: 'enabled',
          expectedRevision: firstStatus === 409 ? '8' : '7' });
        await expect(commands[1]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
        if (firstStatus === 409) {
          await expect(canvas.getByRole('switch', { name: `${label} · ${englishMessages.notificationPush}` })).not.toBeChecked();
        }
      }
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  };
}

export const TopSavingPhone: Story = saveScenario('reply', 200, true, false, true);
export const TopSavedDesktop: Story = saveScenario('reply', 200, false);
export const MiddleFailurePhone: Story = saveScenario('review', 503, true);
export const MiddleFailureDesktop: Story = saveScenario('review', 503, false);
export const LastConflictPhone: Story = saveScenario('proposal-reverted', 409, true);
export const LastConflictDesktop: Story = saveScenario('proposal-reverted', 409, false);
export const RetryFailure: Story = saveScenario('review', 503, true, true);
export const ReviewConflictAndRetry: Story = saveScenario('proposal-reverted', 409, true, true);
export const RefreshFailureAndRetry: Story = saveScenario('proposal-reverted', 409, true, true, false, true);
