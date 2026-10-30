import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReporterStatusView } from '../moderation/reporter-status-view';
import { reporterStatusViewports, submittedReport } from './reporter-status/fixture';

const meta = {
  title: 'Pages/Reporter status',
  parameters: { layout: 'fullscreen', viewport: { options: reporterStatusViewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SubmittedReport: Story = {
  render: () => (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <ReporterStatusView report={{ ...submittedReport, targetAvailability: 'unavailable' }} />
    </main>
  ),
};
