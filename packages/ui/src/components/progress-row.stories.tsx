import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { ProgressRow } from './progress-row.tsx';

const meta = {
  title: 'Components/Progress Row',
  component: ProgressRow,
  decorators: [withSurface],
  args: { value: 0, label: '0%' },
} satisfies Meta<typeof ProgressRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Values: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-4">
      <ProgressRow value={0} label="0%" />
      <ProgressRow value={0.42} label="Ep 3/12" />
      <ProgressRow value={1} label="100%" />
      <ProgressRow value={null} label="Unknown" />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('progressbar')).toHaveLength(3);
    await expect(canvas.getByText('Unknown')).toBeVisible();
  },
};
