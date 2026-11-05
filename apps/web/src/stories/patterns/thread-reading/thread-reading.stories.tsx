import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
import { ThreadReadingPreview } from './thread-reading-preview';
import thread from '../../../kernel/recorded/thread.json';
import owned from '../../../kernel/recorded/thread-owned.json';
import subject from '../../../kernel/recorded/subject.json';
import historyThread from '../../../kernel/recorded/thread-history-thread.json';
import historyRealm from '../../../kernel/recorded/thread-history-realm.json';
import historyAccounts from '../../../kernel/recorded/thread-history-accounts.json';

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

async function mountedReplyEditor(canvas: ReturnType<typeof within>) {
  // The accessible fallback is replaced when Tiptap mounts. Requery instead of retaining that detached node.
  return waitFor(async () => {
    const editor = canvas.getByRole('textbox', { name: m.thread_reply_label() });
    await expect(editor).toHaveClass('ProseMirror');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toBeVisible();
    return editor;
  });
}

async function populatedReading({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: thread.thread.title });
  const postsHeading = await canvas.findByRole('heading', { level: 2, name: m.thread_posts_heading() });
  await expect(postsHeading).toHaveAttribute('data-content-item-slot', 'title');
  await expect(canvasElement.querySelectorAll('[data-slot="content-item-frame"]').length).toBeGreaterThan(0);
  await canvas.findAllByText(m.thread_post_edited());
  await expect(canvas.getAllByText(m.thread_post_edited())).toHaveLength(1);
  const labels = subject.subject.labels as Record<string, string>;
  await canvas.findByRole('link', { name: labels[getLocale()] ?? labels.en! });
  await canvas.findByRole('heading', { level: 2, name: 'Flight notes' });
  const note = await canvas.findByText('Watch the baobabs');
  const asteroid = await canvas.findByRole('link', { name: 'The asteroid' });
  const items = await canvas.findAllByRole('listitem');
  await expect(items.some((item) => item.contains(note))).toBe(true);
  await expect(items.some((item) => item.contains(asteroid))).toBe(true);
  await userEvent.click(await canvas.findByRole('button', { name: m.thread_reveal_spoiler() }));
  await expect(canvas.getByText('The rose was unique')).toBeVisible();
  return canvas;
}

export const Populated: Story = {
  play: async (context) => {
    const canvas = await populatedReading(context);
    await mountedReplyEditor(canvas);
  },
};
export const LongDocument: Story = {
  args: { state: 'long-document', visitor: 'Signed Out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('The final canonical paragraph remains visible in the complete discussion document.');
    const frames = canvasElement.querySelectorAll('[data-slot="content-item-frame"]');
    await expect(frames.length).toBeGreaterThan(0);
    const document = canvasElement.querySelector('[data-slot="document-body"]');
    await expect(document).not.toBeNull();
    await expect(document?.className).not.toContain('line-clamp');
  },
};
export const SignedOut: Story = {
  args: { visitor: 'Signed Out' },
  play: async (context) => {
    const canvas = await populatedReading(context);
    await expect(await canvas.findByRole('link', { name: m.threads_sign_in_to_reply() })).toBeVisible();
    await expect(canvas.queryByRole('textbox', { name: m.thread_reply_label() })).toBeNull();
  },
};
export const Community: Story = { args: { state: 'community' } };
export const ExistingReplyRelationship: Story = {
  args: { state: 'existing-reply', visitor: 'Signed Out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const parent = await canvas.findByRole('link', { name: m.thread_reply_parent() });
    await expect(parent).toBeVisible();
    await expect(parent).toHaveAttribute('href', `#post-${owned.thread.firstPost.id}`);
    await expect(canvasElement.querySelector(`#post-${owned.thread.firstPost.id}`)).toBeVisible();
  },
};
const selectedReply = 'The relationship matters as much as the journey.';

async function selectParent({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const editor = await mountedReplyEditor(canvas);
  const parent = canvasElement.querySelector<HTMLElement>(`#post-${thread.thread.firstPost.id}`);
  if (!parent) throw new Error('The recorded opening post must be loaded before selecting a reply.');
  await userEvent.click(await within(parent).findByRole('button', { name: m.thread_reply_to_post() }));
  await waitFor(() => expect(editor).toHaveFocus());
  const composer = canvas.getByRole('region', { name: m.thread_reply_label() });
  await within(composer).findByRole('button', { name: m.thread_reply_cancel_target() });
  await userEvent.keyboard(selectedReply);
  // Blur flushes the native snapshot before target cancellation or another query render.
  await userEvent.tab();
  await waitFor(() => expect(within(composer).getByRole('button', { name: m.thread_write_send() })).toBeEnabled());
  await expect(await mountedReplyEditor(canvas)).toBe(editor);
  await expect(editor).toHaveTextContent(selectedReply);
  await expect(within(composer).getByRole('button', { name: m.thread_reply_cancel_target() })).toBeVisible();
  await expect(within(composer).getByRole('link', { name: m.thread_reply_parent() })).toHaveAttribute(
    'href',
    `#post-${thread.thread.firstPost.id}`,
  );
  await expect(canvas.getAllByRole('textbox', { name: m.thread_reply_label() })).toHaveLength(1);
  return { canvas, editor, composer };
}
export const SelectedParent: Story = {
  play: async (context) => {
    await selectParent(context);
  },
};
export const CancelledParent: Story = {
  play: async (context) => {
    const { canvas, editor, composer } = await selectParent(context);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_reply_cancel_target() }));
    await waitFor(() => expect(editor).toHaveFocus());
    await expect(await mountedReplyEditor(canvas)).toBe(editor);
    await expect(editor).toHaveTextContent(selectedReply);
    await expect(canvas.queryByRole('button', { name: m.thread_reply_cancel_target() })).toBeNull();
    await expect(within(composer).queryByRole('link', { name: m.thread_reply_parent() })).toBeNull();
    await expect(canvas.getAllByRole('textbox', { name: m.thread_reply_label() })).toHaveLength(1);
  },
};
export const DeletedPost: Story = { args: { state: 'deleted' } };
export const DeletedOrganization: Story = {
  args: { state: 'deleted-organization', visitor: 'Signed Out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: owned.thread.title });
    await canvas.findByRole('heading', { level: 2, name: 'Watering plan' });
    const bylines = await canvas.findAllByText(m.thread_author_deleted_organization());
    for (const byline of bylines) await expect(byline).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.thread_author_deleted_organization() })).toBeNull();
  },
};
export const WithheldPost: Story = { args: { state: 'withheld' } };
export const OwnEdit: Story = {
  args: { state: 'own' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: m.thread_reply_label() });
    const menus = await canvas.findAllByRole('button', { name: m.thread_content_more_actions() });
    await userEvent.click(menus[0]!);
    await userEvent.click(await screen.findByText(m.thread_content_edit(), { exact: true }));
    await expect(await canvas.findByRole('button', { name: m.thread_edit_save() })).toBeVisible();
  },
};
export const History: Story = {
  args: { state: 'history' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: historyThread.thread.title });
    await canvas.findByRole('link', { name: historyRealm.realm.title });
    await userEvent.click((await canvas.findAllByRole('button', { name: m.thread_history_show() }))[0]!);
    const history = await canvas.findByRole('region', { name: m.thread_history_heading() });
    await expect(history).toBeVisible();
    await expect(await canvas.findByText(m.thread_history_version({ number: '1' }))).toBeVisible();
    const list = history.querySelector(':scope > ol');
    if (!list) throw new Error('The captured history has no revision list.');
    const versions = Array.from(list.children) as HTMLElement[];
    await expect(versions).toHaveLength(2);
    const firstDocument = versions[0]!.querySelector('[data-slot="document-body"]');
    const firstProvenance = within(versions[0]!).getByRole('complementary', {
      name: m.thread_provenance_heading(),
    });
    if (
      !firstDocument ||
      !(firstDocument.compareDocumentPosition(firstProvenance) & Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      throw new Error('The recorded document must appear before its revision details.');
    }
    await expect(firstProvenance).toBeVisible();
    await within(versions[0]!).findByText('LicenseRef-rezics-terms', { exact: true });
    await within(versions[0]!).findByRole('heading', { name: m.thread_history_version({ number: '1' }) });
    await within(versions[0]!).findByText('The first words stay visible.');
    await within(versions[0]!).findByRole('link', { name: 'An example link' });
    await within(versions[0]!).findByRole('list');
    await within(versions[0]!).findByText('const saved = true;');
    await expect(versions[0]!).not.toHaveTextContent('The current version adds this sentence.');
    await within(versions[1]!).findByRole('heading', { name: m.thread_history_version({ number: '2' }) });
    await within(versions[1]!).findByText('The current version adds this sentence.');
    const author = historyAccounts.accounts[0];
    if (!author?.handle) throw new Error('The captured history has no current author handle.');
    await within(versions[0]!).findByText(`@${author.handle}`, { exact: true });
    await within(versions[1]!).findByText(`@${author.handle}`, { exact: true });
    await expect(history).toHaveTextContent('LicenseRef-rezics-terms');
  },
};
export const HistoryRetry: Story = {
  args: { visitor: 'Signed Out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: m.thread_history_show() }))[0]!);
    const history = within(await canvas.findByRole('region', { name: m.thread_history_heading() }));
    // This thread has no recorded history endpoint; an explicit retry must remain honestly unavailable.
    await history.findByText(m.thread_history_unavailable());
    await userEvent.click(await history.findByRole('button', { name: m.exact_revision_retry() }));
    await waitFor(() => expect(history.getByRole('button', { name: m.exact_revision_retry() })).toBeEnabled());
    await expect(history.getByText(m.thread_history_unavailable())).toBeVisible();
    await expect(history.queryByRole('list', { name: m.thread_history_heading() })).toBeNull();
  },
};
export const Report: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByRole('button', { name: m.report_more() }))[0]!);
    await userEvent.click(await screen.findByText(m.report_action(), { exact: true }));
    await expect(await screen.findByRole('dialog', { name: m.report_title() })).toBeVisible();
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const CurrentDenial: Story = { args: { state: 'denied' } };

export const RestorablePost: Story = {
  args: { state: 'restorable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: m.thread_post_restore() })).toBeVisible();
    await expect(canvasElement.querySelector('time[datetime="2026-11-23T03:04:05.000Z"]')).toBeVisible();
  },
};
