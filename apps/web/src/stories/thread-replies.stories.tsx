import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady } from './page';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Community/Thread', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedReplyTarget: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths['thread-owned']} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole('textbox', { name: m.thread_reply_label() })).toHaveClass('ProseMirror'),
    );
    const editor = canvas.getByRole('textbox', { name: m.thread_reply_label() });
    await userEvent.click((await canvas.findAllByRole('button', { name: m.thread_reply_to_post() }))[0]!);
    await expect(editor).toHaveFocus();
    await expect(canvas.getByRole('button', { name: m.thread_reply_cancel_target() })).toBeVisible();
  },
};
export const ExistingReplyRelationship: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths['thread-owned']} />,
  play: async (context) => {
    await pageReady(context);
    await expect(
      await within(context.canvasElement).findByRole('link', { name: m.thread_reply_parent() }),
    ).toBeVisible();
  },
};
