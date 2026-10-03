import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { NotificationSettings } from './notification-settings.tsx';
import { englishMessages } from './messages.ts';
import ja from './messages/ja.ts';

const meta = {
  title: 'Settings/Notifications',
  component: NotificationSettings,
  args: { t: englishMessages, preview: true },
} satisfies Meta<typeof NotificationSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

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
  },
};
export const Phone: Story = { ...NewWorkChannels, globals: { viewport: { value: 'mobile' } } };
export const Japanese: Story = { args: { t: ja }, globals: { viewport: { value: 'mobile' } } };

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
