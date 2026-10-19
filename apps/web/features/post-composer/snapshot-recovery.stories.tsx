import type { StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { parseStoredDocument } from '@rezics/document';
import recoveryMeta from './draft-recovery.stories.tsx';
import { postText } from './messages.ts';
import { messages as editorMessages } from '../document-editor/messages.ts';

const meta = { ...recoveryMeta, title: 'Compose/Snapshot recovery' };
export default meta;
type Story = StoryObj<typeof meta>;
const draftKey = 'rezics:post-draft:https://rezics.com/id/a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a';

/** Supplements the unchanged independent snapshot assertion with keyboard recovery, focus and reopen. */
export const RetryThenRemoveKeepsCurrentDocument: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: postText.body[args.locale] });
    await userEvent.click(editor);
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', '<p><strong>Retained current text.</strong></p><img src="/invalid-image.png" data-representation-id="invalid" />');
    clipboard.setData('text/plain', 'Retained current text.');
    await userEvent.paste(clipboard);
    await expect(await canvas.findByText(postText.draftIncomplete[args.locale])).toBeVisible();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey)!).recoveryBody).toContain('Retained current text.'));

    const retry = canvas.getByRole('button', { name: editorMessages[args.locale].retrySave });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(editor).toHaveFocus();
    await expect(editor).toHaveTextContent('Retained current text.');
    await expect(canvas.queryByText(postText.draftSaved[args.locale])).toBeNull();
    await expect(canvas.getByRole('button', { name: postText.post[args.locale] })).toBeDisabled();
    await expect(JSON.parse(localStorage.getItem(draftKey)!).recoveryBody).toContain('/invalid-image.png');

    await userEvent.click(canvas.getByRole('button', { name: editorMessages[args.locale].removeImages }));
    await expect(await canvas.findByText(postText.draftSaved[args.locale])).toBeVisible();
    await expect(editor).toHaveFocus();
    const stored = JSON.parse(localStorage.getItem(draftKey)!);
    await expect(stored.recoveryBody).toBeUndefined();
    const current = parseStoredDocument(stored.body);
    await expect(current?.doc.content?.some(node => node.content?.some(text => text.text === 'Retained current text.' && text.marks?.some(mark => mark.type === 'bold')))).toBe(true);
    await expect(stored.body).not.toContain('/invalid-image.png');

    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    await expect(await canvas.findByRole('textbox', { name: postText.body[args.locale] })).toHaveTextContent('Retained current text.');
    await expect(await canvas.findByText(postText.draftSaved[args.locale])).toBeVisible();
  },
};
