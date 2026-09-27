import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsibleTrigger,
} from './collapsible.tsx';

const meta = {
  title: 'Rezics UI/Collapsible',
  component: Collapsible,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: { onOpenChange: fn() },
} satisfies Meta<typeof Collapsible>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Spoiler: Story = {
  render: (args) => (
    <Collapsible className="flex max-w-xl flex-col gap-2" {...args}>
      <p className="text-sm">
        The countdown only Wang Miao can see is the book’s best scene, and the reason why is worth
        the wait.
      </p>
      <CollapsibleTrigger asChild>
        <Button className="w-fit" size="sm" variant="secondary">
          Show spoiler (chapter 12)
          <CollapsibleIndicator />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="rounded-2xl bg-muted p-3 text-sm">
        The sophons are behind it: the Trisolarans can reach into any lab on Earth.
      </CollapsibleContent>
    </Collapsible>
  ),
  async play({ args, canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /Show spoiler/ });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByText(/sophons/)).not.toBeInTheDocument();
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(await canvas.findByText(/sophons/)).toBeInTheDocument();
    await expect(args.onOpenChange).toHaveBeenCalledWith({ open: true });
  },
};

export const ToggleWithKeyboard: Story = {
  render: Spoiler.render,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: /Show spoiler/ });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard(' ');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  },
};

const review =
  'A slow first third that pays off enormously. Liu Cixin spends the opening on the Cultural Revolution and on Ye Wenjie’s years at Red Coast base, and it is easy to wonder where the science fiction went. Stay with it: the game levels, the countdown and the reply from Trisolaris all reframe those chapters. Ken Liu’s translation keeps the dry, almost documentary tone, and his footnotes on historical terms are worth reading. The physics is hand-waved in places, especially the sophon unfolding, but the ideas land. Four and a half stars, rounded up for the ending.';

export const ReadMore: Story = {
  args: { collapsedHeight: '4.5rem' },
  render: (args) => (
    <Collapsible className="flex max-w-xl flex-col gap-2" {...args}>
      <CollapsibleContent className="text-sm leading-6">{review}</CollapsibleContent>
      <CollapsibleTrigger asChild>
        <Button className="w-fit" size="sm" variant="link">
          Read the full review
        </Button>
      </CollapsibleTrigger>
    </Collapsible>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // A partial collapse keeps the preview mounted and readable.
    await expect(canvas.getByText(/A slow first third/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Read the full review' }));
    await expect(canvas.getByRole('button', { name: 'Read the full review' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <Collapsible className="flex max-w-xl flex-col gap-2" {...args}>
      <CollapsibleTrigger asChild>
        <Button className="w-fit" size="sm" variant="secondary">
          12 replies hidden by moderators
          <CollapsibleIndicator />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="text-sm">Removed replies.</CollapsibleContent>
    </Collapsible>
  ),
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: /12 replies/ });
    await expect(trigger).toHaveAttribute('data-disabled');
    await userEvent.click(trigger, { pointerEventsCheck: 0 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  },
};

export const Chinese: Story = {
  args: { defaultOpen: true },
  render: (args) => (
    <Collapsible className="flex max-w-xl flex-col gap-2" {...args}>
      <CollapsibleTrigger asChild>
        <Button className="w-fit" size="sm" variant="secondary">
          《三体》版本详情
          <CollapsibleIndicator />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="text-sm">
        重庆出版社 2008 年版 · ISBN 978-7-5366-9293-0 · 共 302 页 · 首次连载于《科幻世界》2006 年。
      </CollapsibleContent>
    </Collapsible>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/重庆出版社/)).toBeVisible();
  },
};

export const Dark: Story = {
  ...Spoiler,
  globals: { theme: 'dark' },
};
