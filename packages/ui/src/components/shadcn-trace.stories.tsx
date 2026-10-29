import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@rezics/ui/shadcn/trace';
import { withSurface } from '../stories/support.tsx';
import { MetaLine } from './meta-line.tsx';

const meta = {
  title: 'shadcn/Trace',
  component: Trace,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Trace>;
export default meta;
type Story = StoryObj<typeof meta>;

// The Rhea duration color (muted foreground at 70%) is 3:1 on the page in the light theme; the plain token clears 4.5:1.
// Rhea dims a pending line to 60% opacity, which is 2.5:1 on the page in the light theme; italic marks it instead.
const pendingColor = 'data-[status=pending]:opacity-100 data-[status=pending]:italic';
const durationColor = 'text-muted-foreground';

export const Default: Story = {
  render: () => (
    <Trace className="max-w-sm">
      <TraceLine>
        <TraceIcon>
          <SearchIcon />
        </TraceIcon>
        <TraceTitle>Searched the catalog</TraceTitle>
        <TraceDescription className={durationColor}>1.2s</TraceDescription>
      </TraceLine>
      <TraceLine status="running">
        <TraceTitle>Reading reviews</TraceTitle>
      </TraceLine>
      <TraceLine status="pending" className={pendingColor}>
        <TraceTitle>Writing a summary</TraceTitle>
      </TraceLine>
      <TraceLine status="error">
        <TraceTitle>Could not reach the source</TraceTitle>
      </TraceLine>
    </Trace>
  ),
  async play({ canvasElement }) {
    const lines = canvasElement.querySelectorAll('[data-slot="trace-line"]');
    await expect(lines).toHaveLength(4);
    await expect(lines[1]).toHaveAttribute('data-status', 'running');
    await expect(within(canvasElement).getByText('Searched the catalog')).toBeInTheDocument();
  },
};

const Expandable = () => (
  <Trace className="max-w-sm">
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceTitle>Thought for 4 seconds</TraceTitle>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>The query matches the Remembrance of Earth's Past trilogy.</TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
);

export const Collapsible: Story = {
  render: () => <Expandable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Thought for 4 seconds' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    await expect(await canvas.findByText(/Remembrance of Earth/)).toBeVisible();
    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  },
};

export const LongCJKTitle: Story = {
  render: () => (
    <Trace className="w-64">
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceTitle>检索《三体》第三部：死神永生与更多的长标题作品名称，用来检查截断</TraceTitle>
          <TraceDescription className={durationColor}>2.4 秒</TraceDescription>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>文明之间的黑暗森林法则，每个文明都是带枪的猎人。</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  ),
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: /检索《三体》/ });
    await expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(256);
    await userEvent.click(trigger);
    await expect(await within(canvasElement).findByText(/黑暗森林法则/)).toBeVisible();
  },
};

export const ExpandedByDefault: Story = {
  render: () => (
    <Trace className="max-w-sm">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceTitle>Sources</TraceTitle>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <MetaLine items={['Open Library', 'Wikipedia']} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Sources' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  },
};
