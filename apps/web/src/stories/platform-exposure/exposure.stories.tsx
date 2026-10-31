import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PlatformExposurePage } from '../../platform/exposure/page';
import type { Page } from '../../platform/exposure/data';
import { m } from '../../paraglide/messages.js';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';

// Presentation of the real closed adapter contract. No fabricated groups, native permission or receipts.
const unavailable: Page = { status: 'unavailable' };
const meta = {
  title: 'Pages/Platform exposure/Closed native dependency',
  component: PlatformExposurePage,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative closed-state page composition in the existing app shell at /platform/exposure. PatternStory supplies context without running production route guards; these DTOs do not establish native authority or signed-out route access.',
      },
    },
  },
  render: (args) => (
    <PatternStory visitor={args.initial.status === 'signed-out' ? 'Signed Out' : 'Signed In'} path="/platform/exposure">
      <AppShell>
        <PlatformExposurePage {...args} />
      </AppShell>
    </PatternStory>
  ),
  args: {
    initial: unavailable,
    io: {
      read: async () => unavailable,
      change: async () => ({ status: 'not-sent' as const, current: unavailable }),
    },
  },
} satisfies Meta<typeof PlatformExposurePage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function closedPageReady(canvasElement: HTMLElement, refusal: string) {
  const canvas = within(canvasElement);
  const main = await canvas.findByRole('main');
  await expect(canvas.getAllByRole('main')).toHaveLength(1);
  const view = within(main);
  await expect(view.getByRole('heading', { level: 1, name: m.exposure_title() })).toBeVisible();
  await expect(view.getByText(m.exposure_current_unavailable())).toBeVisible();
  await expect(view.getByText(refusal)).toBeVisible();
  await expect(view.queryByRole('button', { name: m.exposure_confirm() })).toBeNull();
}

export const Unavailable: Story = {
  play: async ({ canvasElement }) => {
    await closedPageReady(canvasElement, m.exposure_unavailable());
    const view = within(canvasElement);
    await expect(view.getByText(m.exposure_current_unavailable())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.exposure_confirm() })).toBeNull();
  },
};
export const SignedOut: Story = {
  args: { initial: { status: 'signed-out' } },
  play: async ({ canvasElement }) => {
    await closedPageReady(canvasElement, m.exposure_signed_out());
  },
};
export const Denied: Story = {
  args: { initial: { status: 'denied' } },
  play: async ({ canvasElement }) => {
    await closedPageReady(canvasElement, m.exposure_denied());
  },
};
