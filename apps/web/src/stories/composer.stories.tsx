import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory, pagePaths, newThreadReady, replyReady } from './page';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Post Editor', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const reply = () => <PageStory visitor="Signed In" path={pagePaths['thread']} />;
const newThread = () => <PageStory visitor="Signed In" path={pagePaths['board-new']} />;
const emptyReplyPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const send = await view.findByRole('button', { name: m.thread_write_send() });
  await expect(send).toBeDisabled();
};
const textReplyPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const editor = await view.findByRole('textbox', { name: 'Reply' });
  await userEvent.click(editor);
  await userEvent.keyboard('A thoughtful reply with a few lines.');
};
const longThreadPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const editor = (await view.findAllByRole('textbox'))[1]!;
  await userEvent.click(editor);
  await userEvent.keyboard(
    'A long opening post with enough words to demonstrate how the editor grows as the author writes.\n\nIt continues in another paragraph to show the writing surface at a useful height.',
  );
};

export const ReplyEmpty: Story = {
  name: 'Reply / Empty',
  render: reply,
  play: emptyReplyPlay,
};
export const ReplyWithText: Story = {
  name: 'Reply / With text',
  render: reply,
  play: textReplyPlay,
};
export const ReplyWithImage: Story = { name: 'Reply / With image', play: replyReady, render: reply };
export const ReplyRefusal: Story = { name: 'Reply / Refusal', play: replyReady, render: reply };
export const NewThreadEmpty: Story = { name: 'New thread / Empty', play: newThreadReady, render: newThread };
export const NewThreadLong: Story = {
  name: 'New thread / Long',
  render: newThread,
  play: longThreadPlay,
};

// Capture these same six states at the required 390px and 1280px screenshot widths.
export const ReplyEmpty390: Story = { name: 'Reply / Empty / 390', play: emptyReplyPlay, render: reply };
export const ReplyWithText390: Story = { name: 'Reply / With text / 390', play: textReplyPlay, render: reply };
export const ReplyWithImage390: Story = { name: 'Reply / With image / 390', play: replyReady, render: reply };
export const ReplyRefusal390: Story = { name: 'Reply / Refusal / 390', play: replyReady, render: reply };
export const NewThreadEmpty390: Story = { name: 'New thread / Empty / 390', play: newThreadReady, render: newThread };
export const NewThreadLong390: Story = { name: 'New thread / Long / 390', play: longThreadPlay, render: newThread };
