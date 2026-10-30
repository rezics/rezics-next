import type { Meta, StoryObj } from '@storybook/react-vite';
import { withSurface } from '../stories/support.tsx';
import { RelativeTime } from './relative-time.tsx';
const meta = {
  title: 'Components/Relative Time',
  component: RelativeTime,
  decorators: [withSurface],
  args: { locale: 'en-US', now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC', value: '2026-10-26T12:00:00Z' },
} satisfies Meta<typeof RelativeTime>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dates: Story = {
  render: (args) => (
    <div className="flex gap-4 text-sm">
      <RelativeTime {...args} value="2026-10-27T01:00:00Z" />
      <RelativeTime {...args} />
      <RelativeTime {...args} value="2026-10-22T12:00:00Z" />
      <RelativeTime {...args} value="2026-10-01T12:00:00Z" />
    </div>
  ),
};
