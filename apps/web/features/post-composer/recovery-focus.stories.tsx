import type { StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recoveryMeta from './draft-recovery.stories.tsx';
import { postText } from './messages.ts';

const meta = { ...recoveryMeta, title: 'Compose/Recovery focus' };
export default meta;
type Story = StoryObj<typeof meta>;
const draftKey = 'rezics:post-draft:https://rezics.com/id/a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a';

/** Reuses the original preflight fixture; the independent recovery assertions stay unchanged. */
export const KeyboardCancelKeepsDraftAndFocus: Story = {
  async play({ canvasElement, args, parameters }) {
    const canvas = within(canvasElement), locale = args.locale;
    const activate = async (button: HTMLElement) => {
      if (parameters.recoveryInput === 'touch') {
        // A synthetic touch sequence; native touch-device proof belongs to the prove phase.
        await userEvent.pointer({ target: button, keys: '[TouchA]' });
      } else {
        button.focus();
        await expect(button).toHaveFocus();
        await userEvent.keyboard('{Enter}');
      }
    };
    const post = await canvas.findByRole('button', { name: postText.post[locale] });
    await waitFor(() => expect(post).toBeEnabled());
    await activate(post);
    await expect(await canvas.findByText(postText.unwritten[locale])).toBeVisible();
    const before = JSON.parse(localStorage.getItem(draftKey)!);
    await expect(before.progress.writeState).toBe('none');
    const title = canvas.getByRole('textbox', { name: postText.titleLabel[locale] });
    await expect(title).not.toHaveAttribute('readonly');
    await expect(canvas.getByRole('textbox', { name: postText.body[locale] })).toHaveAttribute('contenteditable', 'true');
    await expect(canvas.getByRole('checkbox', { name: postText.spoiler[locale] })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: new RegExp(postText.postLanguage[locale]) })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: postText.communityChange[locale] })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: postText.workChange[locale] })).toBeEnabled();

    await activate(canvas.getByRole('button', { name: postText.cancelAttempt[locale] }));
    await expect(title).toHaveFocus();
    await expect(canvas.queryByRole('button', { name: postText.cancelAttempt[locale] })).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey)!)).toEqual({ ...before, progress: null }));
    const requests = (window.fetch as typeof fetch & { mock: { calls: [RequestInfo | URL, RequestInit?][] } }).mock.calls;
    await expect(requests.some(([input]) => /member-reply-drafts|realm-repl(?:ies|y-placements)/.test(input instanceof Request ? input.url : String(input)))).toBe(false);

    // Prove usable focus after the action disappears, before a click can conceal lost focus.
    await userEvent.keyboard('{End} revised');
    await expect(title).toHaveValue('A complete draft revised');
  },
};

export const TouchCancelKeepsDraftAndFocus: Story = {
  ...KeyboardCancelKeepsDraftAndFocus,
  parameters: { recoveryInput: 'touch' },
  globals: { viewport: { value: 'phone' } },
};

export const DeviceSaveRetryKeepsDraftAndFocus: Story = {
  parameters: { recovery: 'storage' },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement), locale = args.locale;
    await expect(await canvas.findByText(postText.draftSaveFailed[locale])).toBeVisible();
    // Restore the same fixture's device storage; no server write is involved in this retry.
    (Storage.prototype.setItem as typeof Storage.prototype.setItem & { mockRestore(): void }).mockRestore();
    const retry = canvas.getByRole('button', { name: postText.retrySave[locale] });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(postText.draftSaved[locale])).toBeVisible();
    await expect(canvas.queryByRole('button', { name: postText.retrySave[locale] })).toBeNull();
    const title = canvas.getByRole('textbox', { name: postText.titleLabel[locale] });
    await expect(title).toHaveFocus();
    await expect(canvas.getByRole('textbox', { name: postText.body[locale] })).toHaveTextContent('Keep the text through failures.');
    await expect(JSON.parse(localStorage.getItem(draftKey)!)).toMatchObject({ title: 'A complete draft', progress: null });
    await userEvent.keyboard('{End} revised');
    await expect(title).toHaveValue('A complete draft revised');
  },
};
