import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { UploadLimited, UploadStatus } from './upload-status.tsx';

const meta = {
  title: 'Safety/Upload status',
  component: UploadStatus,
  args: { clearance: 'screening', locale: 'en' },
} satisfies Meta<typeof UploadStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The check is running; only the uploader can see the image. */
export const Checking: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Checking');
  },
};

export const Visible: Story = {
  args: { clearance: 'cleared' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Visible');
  },
};

/** Held for staff: no reason and no score, and nothing to do. */
export const UnderReview: Story = {
  args: { clearance: 'held' },
  async play({ canvasElement }) {
    const status = within(canvasElement).getByRole('status');
    await expect(status).toHaveTextContent('Under review');
    await expect(status).toHaveTextContent('You do not need to do anything.');
  },
};

export const NotAccepted: Story = {
  args: { clearance: 'rejected' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Not accepted');
  },
};

export const JapaneseUnderReview: Story = {
  args: { clearance: 'held', locale: 'ja' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('審査中');
  },
};

/** A spent upload budget says when to retry, from Retry-After. */
export const UploadBudgetSpent: Story = {
  render: () => <UploadLimited retryAfter={5400} locale="en" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('2 hours');
  },
};
