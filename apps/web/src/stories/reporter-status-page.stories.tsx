import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { PageStory } from './page';
import { reporterStatusViewports } from './reporter-status/fixture';

const meta = {
  title: 'Pages/Reporter status',
  parameters: { layout: 'fullscreen', viewport: { options: reporterStatusViewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SubmittedReport: Story = {
  render: () => (
    <PageStory
      visitor="Signed In"
      path="/moderation/reports/01a17a3b-0884-721b-91ef-d7ffd7bb58f3?fixture=report-unavailable"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: m.reporter_status_heading() });
    const page = within(canvas.getByRole('main'));
    await expect(page.getByText(m.moderation_dismissed(), { exact: true })).toBeVisible();
    await expect(page.getByText('Repeated advertising in this discussion.')).toBeVisible();
    await expect(page.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(page.getByRole('link', { name: m.reporter_status_back() })).toHaveAttribute(
      'href',
      localizeHref('/inbox'),
    );
    await expect(page.getAllByRole('link')).toHaveLength(1);
  },
};
