import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { Marker, MarkerContent, MarkerIcon } from '@rezics/ui/shadcn/marker';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Marker',
  component: Marker,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <div className="max-w-md">
      <Marker {...args}>
        <MarkerIcon>
          <CalendarIcon />
        </MarkerIcon>
        <MarkerContent>Today</MarkerContent>
      </Marker>
    </div>
  ),
} satisfies Meta<typeof Marker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Today')).toBeVisible();
  },
};

export const Separator: Story = {
  args: { variant: 'separator' },
  async play({ canvasElement }) {
    const text = within(canvasElement).getByText('Today');
    await expect(text.closest('[data-slot="marker"]')).not.toBeNull();
  },
};

export const Border: Story = {
  args: { variant: 'border' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Today')).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  args: { variant: 'separator' },
  render: (args) => (
    <div className="grid max-w-xs gap-4">
      {/* A separator keeps its text on one line, so long text uses the default variant. */}
      <Marker>
        <MarkerContent>Unread replies since you last visited this Work&apos;s discussion thread</MarkerContent>
      </Marker>
      <Marker {...args}>
        <MarkerIcon>
          <CalendarIcon />
        </MarkerIcon>
        <MarkerContent>2026年10月27日　星期二</MarkerContent>
      </Marker>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Unread replies since/)).toBeVisible();
    await expect(canvas.getByText(/2026年10月27日/)).toBeVisible();
  },
};

export const AsAnotherElement: Story = {
  render: () => (
    <div className="max-w-md">
      <Marker variant="separator" render={<h3 />}>
        <MarkerContent>Chapter two</MarkerContent>
      </Marker>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Chapter two' })).toBeVisible();
  },
};
