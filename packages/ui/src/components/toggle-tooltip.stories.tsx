import type { Meta, StoryObj } from '@storybook/react-vite';
import { InfoIcon } from 'lucide-react';
import React from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { Button } from './button.tsx';
import { ToggleTooltip, ToggleTooltipContent, ToggleTooltipTrigger } from './toggle-tooltip.tsx';

const meta = {
  title: 'Rezics UI/Toggle Tooltip',
  component: ToggleTooltip,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 260 },
    },
  },
} satisfies Meta<typeof ToggleTooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

const ContextHint = (props: React.ComponentProps<typeof ToggleTooltip>) => (
  <div className="flex items-center gap-1 pt-20 text-sm">
    <span>Rating Context: Hard SF readers</span>
    <ToggleTooltip {...props}>
      <ToggleTooltipTrigger asChild>
        <Button aria-label="What is a rating Context?" size="icon-xs" variant="ghost">
          <InfoIcon />
        </Button>
      </ToggleTooltipTrigger>
      <ToggleTooltipContent className="max-w-64">
        Only members of the Hard SF Realm who marked an edition as read count toward this rating.
      </ToggleTooltipContent>
    </ToggleTooltip>
  </div>
);

const trigger = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole('button', { name: 'What is a rating Context?' });

export const Default: Story = {
  render: (args) => <ContextHint {...args} />,
  async play({ canvasElement }) {
    await userEvent.click(trigger(canvasElement));
    await expect(await settled(await screen.findByRole('dialog'))).toHaveTextContent(
      /Hard SF Realm/,
    );
    await expect(trigger(canvasElement)).toHaveAttribute('aria-expanded', 'true');
  },
};

export const ToggleClosed: Story = {
  render: (args) => <ContextHint {...args} />,
  async play({ canvasElement }) {
    await userEvent.click(trigger(canvasElement));
    await settled(await screen.findByRole('dialog'));
    await userEvent.click(trigger(canvasElement));
    await dismissed('dialog');
  },
};

export const CloseWithEscape: Story = {
  render: (args) => <ContextHint {...args} />,
  async play({ canvasElement }) {
    await userEvent.click(trigger(canvasElement));
    await settled(await screen.findByRole('dialog'));
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
  },
};

const ControlledHint = () => {
  const [open, setOpen] = React.useState(true);

  return (
    <div className="flex flex-col items-start gap-3">
      <ContextHint onOpenChange={(details) => setOpen(details.open)} open={open} />
      <Button onClick={() => setOpen(false)} size="sm" variant="outline">
        Dismiss hint
      </Button>
    </div>
  );
};

/** `open` is honoured, so a page can show the hint once, for example on a first visit. */
export const Controlled: Story = {
  render: () => <ControlledHint />,
  async play({ canvasElement }) {
    await expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Dismiss hint' }));
    await dismissed('dialog');
  },
};

export const Chinese: Story = {
  render: (args) => (
    <div className="flex items-center gap-1 pt-20 text-sm">
      <span>《三体》已合并</span>
      <ToggleTooltip {...args}>
        <ToggleTooltipTrigger asChild>
          <Button aria-label="为什么合并？" size="icon-xs" variant="ghost">
            <InfoIcon />
          </Button>
        </ToggleTooltipTrigger>
        <ToggleTooltipContent className="max-w-64">
          重复条目「Three Body Problem」已并入本作品，评分与书架记录一并迁移。
        </ToggleTooltipContent>
      </ToggleTooltip>
    </div>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '为什么合并？' }));
    await expect(await settled(await screen.findByRole('dialog'))).toHaveTextContent('评分');
  },
};

export const Dark: Story = {
  ...Default,
  globals: { theme: 'dark' },
};
