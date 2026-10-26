import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@rezics/ui/shadcn/message-scroller';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Message scroller',
  component: MessageScroller,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof MessageScroller>;
export default meta;
type Story = StoryObj<typeof meta>;

const lines = Array.from({ length: 30 }, (_, index) => ({
  id: `message-${index + 1}`,
  text:
    index % 3 === 0 ? `第 ${index + 1} 則訊息：這一章的轉折比上一章更讓人意外。` : `Message ${index + 1} of the thread`,
}));

const Thread = ({
  items = lines,
  defaultScrollPosition,
}: {
  items?: typeof lines;
  defaultScrollPosition?: 'start' | 'end';
}) => (
  <MessageScrollerProvider defaultScrollPosition={defaultScrollPosition}>
    <MessageScroller className="relative max-w-sm rounded-2xl border">
      <MessageScrollerViewport aria-label="Discussion thread" className="h-72 overflow-y-auto p-4 pb-14">
        <MessageScrollerContent aria-label="Messages in the discussion thread" className="gap-3">
          {items.map((line) => (
            <MessageScrollerItem key={line.id} messageId={line.id} className="rounded-xl bg-muted px-3 py-2 text-sm">
              {line.text}
            </MessageScrollerItem>
          ))}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton direction="end" className="absolute right-3 bottom-3" />
    </MessageScroller>
  </MessageScrollerProvider>
);

export const StartsAtTheEnd: Story = {
  render: () => <Thread />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const viewport = canvas.getByRole('region', { name: 'Discussion thread' });
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    await expect(canvas.getByText('Message 30 of the thread')).toBeVisible();
  },
};

export const JumpToEnd: Story = {
  render: () => <Thread defaultScrollPosition="start" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const viewport = canvas.getByRole('region', { name: 'Discussion thread' });
    await expect(viewport.scrollTop).toBe(0);
    const button = canvas.getByRole('button', { name: 'Scroll to end' });
    await waitFor(() => expect(button).not.toHaveAttribute('inert'));
    await userEvent.click(button);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    await expect(await canvas.findByText('Message 30 of the thread')).toBeVisible();
  },
};

export const ShortThread: Story = {
  render: () => <Thread items={lines.slice(0, 2)} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const viewport = canvas.getByRole('region', { name: 'Discussion thread' });
    await waitFor(() => expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight));
    // With nothing to scroll to, the button stays out of the tab order and cannot be pressed.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Scroll to end' })).toHaveAttribute('inert'));
    await expect(canvas.getByText('Message 2 of the thread')).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <Thread
      defaultScrollPosition="start"
      items={[
        {
          id: 'a',
          text: '一口氣讀完前三部之後，我最想討論的是羅輯與葉文潔之間那段幾乎沒有對白、卻決定了整個故事走向的場景。',
        },
        {
          id: 'b',
          text: 'https://example.com/a-very-long-link-without-any-break-points/that-keeps-going-and-going-and-going-forever',
        },
        ...lines.slice(0, 12),
      ]}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/羅輯與葉文潔/)).toBeVisible();
    await expect(canvas.getByText(/a-very-long-link/)).toBeInTheDocument();
  },
};
