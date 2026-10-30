import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PlatformExposurePage } from '../../platform/exposure/page';
import type { Page } from '../../platform/exposure/data';
import { m } from '../../paraglide/messages.js';

// Presentation of the real closed adapter contract. No fabricated groups, native permission or receipts.
const unavailable: Page = { status: 'unavailable' };
const meta = {
  title: 'Pages/Platform exposure/Closed native dependency',
  component: PlatformExposurePage,
  parameters: { layout: 'padded' },
  args: { initial: unavailable, io: {
    read: async () => unavailable,
    change: async () => ({ status: 'not-sent' as const, current: unavailable }),
  } },
} satisfies Meta<typeof PlatformExposurePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unavailable: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.exposure_current_unavailable())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.exposure_confirm() })).toBeNull();
  },
};
export const SignedOut: Story = { args: { initial: { status: 'signed-out' } } };
export const Denied: Story = { args: { initial: { status: 'denied' } } };
