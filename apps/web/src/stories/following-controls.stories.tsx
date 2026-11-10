import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { FollowControl } from '../library/follow-control';
import type { FollowWriteInput, FollowWriteResult } from '../library/follow-records';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Community/Follow control',
  id: 'patterns-following-follow-control',
  component: FollowControl,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <PatternStory>
        <Story />
      </PatternStory>
    ),
  ],
  args: {
    targetId: '01a17a3b-70ea-712a-9ff7-81fc6a9381b6',
    initial: { state: 'ready', following: false },
    canFollow: true,
    canRemove: true,
    ready: true,
    write: async (input: FollowWriteInput): Promise<FollowWriteResult> => ({ ok: true, following: input.following }),
  },
} satisfies Meta<typeof FollowControl>;
export default meta;
type Story = StoryObj<typeof meta>;
const retryWrite = fn<(input: FollowWriteInput) => Promise<FollowWriteResult>>();

export const FollowAndRemove: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow() }));
    await expect(canvas.getByText(m.library_following(), { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByText(m.library_follow_removed())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_follow() })).toBeEnabled();
  },
};

export const DeleteOnly: Story = {
  args: { initial: { state: 'forbidden' }, canFollow: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: m.library_follow() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByText(m.library_follow_removed())).toBeVisible();
  },
};

export const UnavailableTarget: Story = {
  args: { initial: { state: 'ready', following: true }, canFollow: false },
  render: (args) => (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p>{m.library_subject_unavailable()}</p>
      <FollowControl {...args} menuTitle={m.library_follow_more_actions({ title: m.library_subject_unavailable() })} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', {
        name: m.library_follow_more_actions({ title: m.library_subject_unavailable() }),
      }),
    );
    const body = within(canvasElement.ownerDocument.body);
    const remove =
      body.queryByRole('menuitem', { name: m.library_follow_unfollow() }) ??
      body.getByRole('button', { name: m.library_follow_unfollow() });
    await userEvent.click(remove);
    await expect(canvas.getByText(m.library_follow_removed())).toBeVisible();
  },
};

export const Loading: Story = {
  args: { initial: { state: 'pending' }, canFollow: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_follow_loading())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_follow_unfollow() })).toBeEnabled();
  },
};

export const Pending: Story = {
  args: { initial: { state: 'ready', following: true }, write: () => new Promise<FollowWriteResult>(() => {}) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByText(m.library_follow_pending())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_follow_unfollow() })).toBeDisabled();
  },
};

export const AmbiguousRetry: Story = {
  args: {
    initial: { state: 'ready', following: true },
    write: retryWrite,
  },
  beforeEach: () => {
    retryWrite
      .mockReset()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValue({ ok: true, following: false });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.error_message());
    await expect(canvas.getByText(m.library_following(), { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByText(m.library_follow_removed())).toBeVisible();
    const calls = retryWrite.mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
  },
};

export const Conflict: Story = {
  args: { initial: { state: 'ready', following: true }, write: async () => ({ ok: false, reason: 'conflict' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_follow_conflict());
    await expect(canvas.getByRole('button', { name: m.library_follow_unfollow() })).toBeDisabled();
  },
};

export const Revoked: Story = {
  args: { initial: { state: 'ready', following: true }, write: async () => ({ ok: false, reason: 'forbidden' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_unfollow() }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.library_follow_forbidden());
    await expect(canvas.getByText(m.library_following(), { exact: true })).toBeVisible();
  },
};
