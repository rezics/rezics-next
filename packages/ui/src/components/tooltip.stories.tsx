import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArrowBigDownIcon, ArrowBigUpIcon, BookmarkIcon, Share2Icon } from 'lucide-react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { dismissed, settled, withTheme } from '../stories/support.tsx';
import { Button } from './button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.tsx';

const meta = {
  title: 'Rezics UI/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 240 },
    },
  },
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

const IconAction = (props: {
  label: string;
  icon: React.ReactNode;
  tooltip?: React.ComponentProps<typeof Tooltip>;
  disabled?: boolean;
}) => (
  <Tooltip {...props.tooltip}>
    <TooltipTrigger asChild>
      <Button aria-label={props.label} disabled={props.disabled} size="icon-sm" variant="secondary">
        {props.icon}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{props.label}</TooltipContent>
  </Tooltip>
);

const PostBar = (props: { tooltip?: React.ComponentProps<typeof Tooltip> }) => (
  <div className="flex items-center gap-2 pt-16">
    <div className="flex items-center gap-1 rounded-full bg-secondary px-1">
      <IconAction
        icon={<ArrowBigUpIcon className="fill-brand text-brand" />}
        label="Upvoted"
        tooltip={props.tooltip}
      />
      <span className="font-medium text-sm tabular-nums">1.2k</span>
      <IconAction icon={<ArrowBigDownIcon />} label="Downvote" tooltip={props.tooltip} />
    </div>
    <IconAction icon={<Share2Icon />} label="Share" tooltip={props.tooltip} />
    <IconAction icon={<BookmarkIcon />} label="Save post" tooltip={props.tooltip} />
  </div>
);

export const Default: Story = {
  render: (args) => <PostBar tooltip={args} />,
  async play({ canvasElement }) {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: 'Save post' }));
    await expect(await settled(await screen.findByRole('tooltip'))).toHaveTextContent('Save post');
  },
};

export const OpenOnFocus: Story = {
  render: (args) => <PostBar tooltip={args} />,
  async play({ canvasElement }) {
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('button', { name: 'Upvoted' })).toHaveFocus();
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Upvoted');
    await userEvent.keyboard('{Escape}');
    await dismissed('tooltip');
  },
};

export const CloseOnLeave: Story = {
  render: (args) => <PostBar tooltip={args} />,
  async play({ canvasElement }) {
    const share = within(canvasElement).getByRole('button', { name: 'Share' });
    await userEvent.hover(share);
    await screen.findByRole('tooltip');
    await userEvent.unhover(share);
    await dismissed('tooltip');
  },
};

export const Placements: Story = {
  render: (args) => (
    <div className="grid w-fit grid-cols-2 gap-x-40 gap-y-20 px-28 pt-16">
      {(['top', 'right', 'bottom', 'left'] as const).map((placement) => (
        <Tooltip {...args} key={placement} open positioning={{ placement }}>
          <TooltipTrigger asChild>
            <Button variant="outline">{placement}</Button>
          </TooltipTrigger>
          <TooltipContent>Placed {placement}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  ),
  async play() {
    await expect(await screen.findAllByRole('tooltip')).toHaveLength(4);
  },
};

export const LongLabel: Story = {
  render: (args) => (
    <div className="pt-24">
      <Tooltip {...args}>
        <TooltipTrigger asChild>
          <Button variant="outline">Source statistic</Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          Tor Books reports 4.1 from 212,000 ratings. REZICS shows it apart from Realm ratings
          because its Context is unknown.
        </TooltipContent>
      </Tooltip>
    </div>
  ),
  async play({ canvasElement }) {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: 'Source statistic' }));
    await expect(await settled(await screen.findByRole('tooltip'))).toBeVisible();
  },
};

export const Chinese: Story = {
  render: (args) => (
    <div className="pt-16">
      <Tooltip {...args}>
        <TooltipTrigger asChild>
          <Button aria-label="收藏帖子" size="icon-sm" variant="secondary">
            <BookmarkIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>收藏帖子：《三体》读书会第 3 周</TooltipContent>
      </Tooltip>
    </div>
  ),
  async play({ canvasElement }) {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: '收藏帖子' }));
    await expect(await settled(await screen.findByRole('tooltip'))).toHaveTextContent('《三体》');
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
