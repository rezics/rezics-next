import type { Meta, StoryObj } from '@storybook/react-vite';
import { InfoIcon } from 'lucide-react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@rezics/ui/shadcn/tooltip';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 240 } } },
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

// Base UI gives the popup no role, so the stories find it by its text.
const shown = async (text: string | RegExp) => settled(await screen.findByText(text));
const hidden = (text: string | RegExp) =>
  waitFor(() => expect(screen.queryByText(text)).not.toBeInTheDocument(), { timeout: 3000 });

export const Default: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" />}>Follow</TooltipTrigger>
        <TooltipContent>Get notified about new chapters</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Follow' });
    await userEvent.hover(trigger);
    await shown('Get notified about new chapters');
    await userEvent.unhover(trigger);
    await hidden('Get notified about new chapters');
  },
};

export const Keyboard: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" size="icon" aria-label="About ratings" />}>
          <InfoIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">Ratings are averaged from all readers.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'About ratings' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await shown('Ratings are averaged from all readers.');
    await userEvent.keyboard('{Escape}');
    await hidden('Ratings are averaged from all readers.');
  },
};

export const LongCJKText: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" />}>作品详情</TooltipTrigger>
        <TooltipContent>
          《三体》第三部：死神永生。文明之间的黑暗森林法则与更多的长说明文字，用来检查气泡在最大宽度处换行。
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  async play({ canvasElement }) {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: '作品详情' }));
    const tooltip = await shown(/死神永生/);
    await waitFor(() => expect(tooltip.getBoundingClientRect().width).toBeLessThanOrEqual(320));
  },
};
