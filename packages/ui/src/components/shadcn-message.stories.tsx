import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Bubble, BubbleContent } from '@rezics/ui/shadcn/bubble';
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from '@rezics/ui/shadcn/message';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Message',
  component: Message,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Message>;
export default meta;
type Story = StoryObj<typeof meta>;

const Text = ({ children }: { children: React.ReactNode }) => (
  <Bubble variant="muted">
    <BubbleContent>{children}</BubbleContent>
  </Bubble>
);

export const Default: Story = {
  render: () => (
    <div className="max-w-md">
      <Message>
        <MessageAvatar>
          <Avatar>
            <AvatarFallback>MK</AvatarFallback>
          </Avatar>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader>Mika</MessageHeader>
          <Text>Did you finish the second volume?</Text>
          <MessageFooter>10:42</MessageFooter>
        </MessageContent>
      </Message>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Mika')).toBeVisible();
    await expect(canvas.getByText('Did you finish the second volume?')).toBeVisible();
  },
};

export const Conversation: Story = {
  render: () => (
    <MessageGroup className="max-w-md">
      <Message>
        <MessageAvatar>
          <Avatar>
            <AvatarFallback>MK</AvatarFallback>
          </Avatar>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader>Mika</MessageHeader>
          <Text>Did you finish the second volume?</Text>
        </MessageContent>
      </Message>
      <Message align="end">
        <MessageContent>
          <Text>Last night. The ending is not what I expected.</Text>
          <MessageFooter>Read 10:44</MessageFooter>
        </MessageContent>
      </Message>
    </MessageGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const reply = canvas.getByText(/Last night/).closest('[data-slot="message"]');
    await expect(reply).toHaveAttribute('data-align', 'end');
    await expect(canvas.getByText('Read 10:44')).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <MessageGroup className="max-w-xs">
      <Message>
        <MessageAvatar>
          <Avatar>
            <AvatarFallback>陳</AvatarFallback>
          </Avatar>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader>陳小明（《三體》讀書會召集人與版主）</MessageHeader>
          <Text>黑暗森林法則真正可怕的地方，不是宇宙很大，而是沒有任何一個文明能夠確定另一個文明的意圖。</Text>
        </MessageContent>
      </Message>
      <Message align="end">
        <MessageContent>
          <Text>
            https://example.com/a-very-long-link-without-any-break-points/that-keeps-going-and-going-and-going
          </Text>
        </MessageContent>
      </Message>
    </MessageGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/黑暗森林法則/)).toBeVisible();
    await expect(canvas.getByText(/a-very-long-link/)).toBeVisible();
  },
};
