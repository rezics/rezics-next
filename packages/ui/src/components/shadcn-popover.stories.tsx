import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@rezics/ui/shadcn/popover';
import { waitForFocus } from '../test/focus.ts';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Popover',
  component: Popover,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 320 } } },
} satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj<typeof meta>;

const gone = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>Reading progress</PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Reading progress</PopoverTitle>
          <PopoverDescription>You are on chapter 12 of 30.</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  ),
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Reading progress' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    const popover = await settled(await screen.findByRole('dialog', { name: 'Reading progress' }));
    await expect(popover).toHaveAccessibleDescription('You are on chapter 12 of 30.');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    await gone();
    await waitForFocus(trigger);
  },
};

export const LongCJKText: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>作品简介</PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>《三体》第三部：死神永生与更多的长标题作品</PopoverTitle>
          <PopoverDescription>
            文明之间的黑暗森林法则：宇宙就是一座黑暗森林，每个文明都是带枪的猎人，像幽灵般潜行于林间。
          </PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '作品简介' }));
    const popover = await settled(await screen.findByRole('dialog', { name: /死神永生/ }));
    await expect(popover).toHaveAccessibleDescription(/黑暗森林/);
  },
};

export const Dismiss: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger render={<Button />}>Open</PopoverTrigger>
      <PopoverContent side="top">
        <PopoverTitle>Quick note</PopoverTitle>
      </PopoverContent>
    </Popover>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Open' }));
    await settled(await screen.findByRole('dialog', { name: 'Quick note' }));
    await userEvent.click(document.body);
    await gone();
  },
};
