import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { ThreadReadingPreview } from './patterns/thread-reading/thread-reading-preview';
import * as Reading from './patterns/thread-reading/thread-reading.stories';

const meta = {
  ...Reading.default,
  title: 'Community/Thread reading Page',
  id: 'pages-community-thread-reading',
  component: ThreadReadingPreview,
  args: { shell: true },
} satisfies Meta<typeof ThreadReadingPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {
  ...Reading.Populated,
  play: async (context) => Reading.Populated.play!(context),
};
export const LongDocument: Story = {
  ...Reading.LongDocument,
  play: async (context) => Reading.LongDocument.play!(context),
};
export const SignedOut: Story = {
  ...Reading.SignedOut,
  play: async (context) => Reading.SignedOut.play!(context),
};
export const Community: Story = { ...Reading.Community };
export const ExistingReplyRelationship: Story = {
  ...Reading.ExistingReplyRelationship,
  play: async (context) => Reading.ExistingReplyRelationship.play!(context),
};
export const SelectedParent: Story = {
  ...Reading.SelectedParent,
  play: async (context) => Reading.SelectedParent.play!(context),
};
export const CancelledParent: Story = {
  ...Reading.CancelledParent,
  play: async (context) => Reading.CancelledParent.play!(context),
};
export const DeletedPost: Story = {
  ...Reading.DeletedPost,
  play: async (context) => {
    const canvas = within(context.canvasElement);
    const tombstone = await canvas.findByText(m.thread_post_deleted());
    const item = tombstone.closest('li');
    await expect(item).not.toBeNull();
    await expect(item?.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
export const DeletedOrganization: Story = {
  ...Reading.DeletedOrganization,
  play: async (context) => Reading.DeletedOrganization.play!(context),
};
export const WithheldPost: Story = {
  ...Reading.WithheldPost,
  play: async (context) => {
    const canvas = within(context.canvasElement);
    const tombstone = await canvas.findByText(m.thread_post_withheld());
    const item = tombstone.closest('li');
    await expect(item).not.toBeNull();
    await expect(item?.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
export const OwnEdit: Story = {
  ...Reading.OwnEdit,
  play: async (context) => Reading.OwnEdit.play!(context),
};
export const EditDiscardProtection: Story = {
  args: { state: 'own' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: m.thread_reply_label() });
    const menus = await canvas.findAllByRole('button', { name: m.thread_content_more_actions() });
    await userEvent.click(menus[0]!);
    await userEvent.click(await screen.findByText(m.thread_content_edit(), { exact: true }));
    const editor = await canvas.findByRole('textbox', { name: m.thread_reply_body_label() });
    await userEvent.click(editor);
    await userEvent.keyboard(' An edit that has not been saved.');
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_edit_cancel() }));
    let dialog = await screen.findByRole('alertdialog', { name: m.thread_authoring_discard_title() });
    await expect(dialog).toHaveTextContent(m.thread_authoring_discard_unsaved());
    await userEvent.click(within(dialog).getByRole('button', { name: m.thread_authoring_stay() }));
    await expect(editor).toHaveTextContent('An edit that has not been saved.');
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_edit_cancel() }));
    dialog = await screen.findByRole('alertdialog', { name: m.thread_authoring_discard_title() });
    await userEvent.click(within(dialog).getByRole('button', { name: m.thread_authoring_discard() }));
    await expect(canvas.queryByRole('textbox', { name: m.thread_reply_body_label() })).toBeNull();
  },
};
export const History: Story = {
  ...Reading.History,
  play: async (context) => Reading.History.play!(context),
};
export const HistoryRetry: Story = {
  ...Reading.HistoryRetry,
  play: async (context) => Reading.HistoryRetry.play!(context),
};
export const Report: Story = {
  ...Reading.Report,
  play: async (context) => Reading.Report.play!(context),
};
export const Loading: Story = { ...Reading.Loading };
export const Unavailable: Story = { ...Reading.Unavailable };
export const CurrentDenial: Story = { ...Reading.CurrentDenial };

export const RestorablePost: Story = {
  ...Reading.RestorablePost,
  play: async (context) => Reading.RestorablePost.play!(context),
};
