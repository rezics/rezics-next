import type { StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { parseStoredDocument } from '@rezics/document';
import recoveryMeta from './draft-recovery.stories.tsx';
import { postText } from './messages.ts';
import { messages as editorMessages } from '../document-editor/messages.ts';
import { mediaMessages } from '../document-editor/media-messages.ts';

const meta = { ...recoveryMeta, title: 'Compose/Snapshot recovery' };
export default meta;
type Story = StoryObj<typeof meta>;
const draftKey = 'rezics:post-draft:https://rezics.com/id/a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a';

async function exportRecovery(canvasElement: HTMLElement, label: string, raw: string) {
  const create = spyOn(URL, 'createObjectURL');
  const download = spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    await userEvent.click(within(canvasElement).getByRole('button', { name: label }));
    await expect(download).toHaveBeenCalled();
    await expect(await (create.mock.calls.at(-1)![0] as Blob).text()).toBe(raw);
    await expect(JSON.parse(localStorage.getItem(draftKey)!).recoveryBody).toBe(raw);
  } finally { create.mockRestore(); download.mockRestore(); }
}

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

const arrangedRecovery: Story = {
  parameters: { recovery: 'snapshot' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), locale = args.locale, t = editorMessages[locale];
    const editor = await canvas.findByRole('textbox', { name: postText.body[locale] });
    const image = () => editor.querySelector('[data-block-id="22222222-2222-4222-8222-222222222222"]');
    await expect(await canvas.findByText(postText.draftIncomplete[locale])).toBeVisible();
    await expect(editor).toHaveTextContent('Retained current text.');
    await expect(image()).toBeVisible();
    await expect(editor.querySelectorAll('figure')).toHaveLength(2);
    const before = JSON.parse(localStorage.getItem(draftKey)!);
    await expect(before.body).not.toContain('Retained current text.');
    await expect(before.recoveryBody).toContain('Retained current text.');

    const retry = canvas.getByRole('button', { name: t.retrySave });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(editor).toHaveFocus();
    await expect(editor).toHaveTextContent('Retained current text.');
    await expect(image()).toBeVisible();
    await expect(canvas.queryByText(postText.draftSaved[locale])).toBeNull();
    await expect(canvas.getByRole('button', { name: postText.post[locale] })).toBeDisabled();
    const raw = JSON.parse(localStorage.getItem(draftKey)!).recoveryBody;
    await expect(raw).toContain('/invalid-image.png');

    await exportRecovery(canvasElement, t.exportDocument, raw);

    // A page return must hydrate raw recovery, including the invalid and stable images.
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    const reopened = await canvas.findByRole('textbox', { name: postText.body[locale] });
    await expect(reopened).toHaveTextContent('Retained current text.');
    await expect(reopened.querySelectorAll('figure')).toHaveLength(2);
    await expect(await canvas.findByText(postText.draftIncomplete[locale])).toBeVisible();
    const remove = canvas.getByRole('button', { name: t.removeImages });
    remove.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(postText.draftSaved[locale])).toBeVisible();
    await expect(reopened).toHaveFocus();
    await expect(reopened).toHaveTextContent('Retained current text.');
    await expect(reopened.querySelectorAll('figure')).toHaveLength(1);
    await expect(await canvas.findByText(mediaMessages[locale].unavailable)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: t.removeImages })).toBeNull();
    const stored = JSON.parse(localStorage.getItem(draftKey)!);
    await expect(stored.recoveryBody).toBeUndefined();
    await expect(stored.imageDraft).toEqual(before.imageDraft);
    await expect(stored.body).not.toContain('/invalid-image.png');
    const complete = parseStoredDocument(stored.body)!;
    await expect(complete.doc.content?.find(node => node.type === 'image')?.attrs).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222', representationId: '11111111-1111-4111-8111-111111111111',
      mediaUseId: '33333333-3333-4333-8333-333333333333',
    });
    await expect(complete.doc.content?.some(node => node.content?.some(text => text.text === 'Retained current text.' && text.marks?.some(mark => mark.type === 'bold')))).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen draft' }));
    const savedEditor = await canvas.findByRole('textbox', { name: postText.body[locale] });
    await expect(savedEditor).toHaveTextContent('Retained current text.');
    await expect(savedEditor.querySelectorAll('figure')).toHaveLength(1);
    await expect(await canvas.findByText(postText.draftSaved[locale])).toBeVisible();
    // Leave a useful settled phone state with a visible caret for screenshot review.
    await userEvent.click(savedEditor);
  },
};

export const SnapshotRecoveryPhone: Story = { ...arrangedRecovery, globals: { viewport: { value: 'phone' } } };
export const SnapshotRecoveryPhoneChinese: Story = { ...arrangedRecovery, args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' } } };

export const IncompleteDocumentExportPhoneChinese: Story = {
  parameters: { recovery: 'snapshot' }, args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), locale = args.locale, t = editorMessages[locale];
    await expect(await canvas.findByText(postText.draftIncomplete[locale])).toBeVisible();
    const raw = JSON.parse(localStorage.getItem(draftKey)!).recoveryBody;
    await expect(raw).toContain('Retained current text.');
    await expect(raw).toContain('/invalid-image.png');
    await exportRecovery(canvasElement, t.exportDocument, raw);
    await expect(canvas.queryByText(postText.draftSaved[locale])).toBeNull();
    await expect(canvas.getByRole('button', { name: postText.post[locale] })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: t.retrySave })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: t.removeImages })).toBeEnabled();
  },
};
