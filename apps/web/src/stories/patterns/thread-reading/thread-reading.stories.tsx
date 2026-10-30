import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { ThreadReadingPreview } from './thread-reading-preview';

const meta = {
  title: 'Patterns/Community/Thread reading',
  component: ThreadReadingPreview,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof ThreadReadingPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Community: Story = { args: { state: 'community' } };
async function selectParent({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const editor = await canvas.findByRole('textbox', { name: m.thread_reply_label() });
  await waitFor(() => expect(editor).toHaveClass('ProseMirror'));
  await userEvent.click((await canvas.findAllByRole('button', { name: m.thread_reply_to_post() }))[0]!);
  await expect(editor).toHaveFocus();
  await userEvent.type(editor, 'The relationship matters as much as the journey.');
  await expect(canvas.getByRole('button', { name: m.thread_reply_cancel_target() })).toBeVisible();
  return { canvas, editor };
}
export const SelectedParent: Story = {
  play: async (context) => {
    await selectParent(context);
  },
};
export const CancelledParent: Story = {
  play: async (context) => {
    const { canvas, editor } = await selectParent(context);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_reply_cancel_target() }));
    await expect(editor).toHaveFocus();
    await expect(editor).toHaveTextContent('The relationship matters as much as the journey.');
    await expect(canvas.queryByRole('button', { name: m.thread_reply_cancel_target() })).toBeNull();
    await expect(canvas.getAllByRole('textbox', { name: m.thread_reply_label() })).toHaveLength(1);
  },
};
export const DeletedPost: Story = { args: { state: 'deleted' } };
export const WithheldPost: Story = { args: { state: 'withheld' } };
export const OwnEdit: Story = {
  args: { state: 'own' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: m.thread_reply_label() });
    const menus = await canvas.findAllByRole('button', { name: m.thread_content_more_actions() });
    await userEvent.click(menus[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: m.thread_content_edit() }));
    await expect(await canvas.findByRole('button', { name: m.thread_edit_save() })).toBeVisible();
  },
};
export const History: Story = {
  args: { state: 'history' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: m.thread_history_show() }))[0]!);
    await expect(await canvas.findByRole('region', { name: m.thread_history_heading() })).toBeVisible();
    await expect(await canvas.findByText(m.thread_history_version({ number: '1' }))).toBeVisible();
  },
};
export const Report: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: m.report_more() }))[0]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: m.report_action() }));
    await expect(await screen.findByRole('dialog', { name: m.report_title() })).toBeVisible();
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const CurrentDenial: Story = { args: { state: 'denied' } };
