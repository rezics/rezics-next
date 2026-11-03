import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { fromPlainText } from '@rezics/document';
import { ThreadReading, type ThreadReadingPage } from '../threads/thread-reading';
import { ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { m } from '../paraglide/messages.js';
import recording from '../kernel/recorded/thread.json';
import accounts from '../kernel/recorded/accounts.json';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const first = recording.thread.firstPost;
const author = accounts.accounts[0]!;
const rows = Array.from({ length: 12 }, (_, index) => ({
  ...first,
  id: index === 0 ? first.id : id(300 + index),
  threadId: recording.thread.id,
  parentId: index === 0 || index === 2 ? null : index === 1 ? first.id : id(299 + index),
  availability: 'available' as const,
  authorId: author.id,
  mediaIds: [],
  body: fromPlainText(
    `Prepared supplied post ${index + 1}. ` +
      'A careful reader follows one disclosed parent at a time and keeps the native page order. '.repeat(3),
    'blocks',
  ),
}));
const page: ThreadReadingPage = {
  thread: { ...recording.thread, firstPost: rows[0]! },
  posts: { posts: rows, next: 'prepared-opaque-page-cursor' },
  authors: { [author.id]: { ...author, kind: 'actor', state: 'active', displayName: 'A reader with a deliberately long name '.repeat(3) } },
  subjects: [], provenanceSubjects: [], mentions: {},
  verification: { sitekey: '', scriptUrl: '' }, now: first.createdAt,
};
const boundaries: ThreadReadingPage = {
  ...page,
  posts: { ...page.posts, posts: [
    ...rows,
    { ...rows[1]!, id: id(400), parentId: id(401) },
    { ...rows[1]!, id: id(401), parentId: id(400) },
    { ...rows[1]!, id: id(402), parentId: id(402) },
    { ...rows[1]!, id: id(403), parentId: id(999) },
    { ...rows[1]!, id: id(404), parentId: null, availability: 'withheld', body: null, sha256: null, removed: true },
    { ...rows[1]!, id: id(405), parentId: id(404) },
  ] },
};

/** Prepared page projection: no fixture implies native hierarchy or additional read authority. */
function Journey({ boundaryStates = false }: { boundaryStates?: boolean }) {
  const supplied = boundaryStates ? boundaries : page;
  return <div className="min-h-screen bg-background p-3 text-foreground sm:p-6">
    <p className="mx-auto mb-4 max-w-3xl rounded-lg border p-3 text-sm">Prepared reply-branch fixture — supplied rows only</p>
    <ThreadReading page={supplied} Post={ThreadReadingPost} session="signed-in"
      personal={{ viewerId: author.id, idempotencyKey: id(800), reactions: {}, reviewVotes: {} }}
      returnTo="/" signedOut={null}
      renderHeader={() => <h1 className="text-2xl font-semibold">Prepared bounded conversation</h1>}
      onMutation={async () => {}} onPageRefresh={async () => supplied} />
  </div>;
}
const meta = {
  title: 'Pages/Community/Bounded conversation branches', component: Journey,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
    } },
    docs: { description: { component: 'Prepared interactions compose the real ThreadReading, passed Post and reply composer. Long bylines and wrapping controls are intentional. These stories make no native or rendered acceptance claim. Existing Thread reading / ExistingReplyRelationship and SelectedParent remain companion scenarios.' } },
  },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;

async function journey({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const origin = canvasElement.querySelector<HTMLElement>(`#post-${rows[4]!.id}`)!;
  const parent = canvasElement.querySelector<HTMLElement>(`#post-${rows[3]!.id}`)!;
  const unrelated = canvasElement.querySelector<HTMLElement>('[data-conversation-row="1"]')!;
  const editor = await waitFor(() => {
    const element = canvas.getByRole('textbox', { name: m.thread_reply_label() });
    expect(element).toHaveClass('ProseMirror');
    return element;
  });
  await userEvent.click(editor);
  await userEvent.type(editor, 'Unsent writing stays mounted while following this page.');
  await userEvent.click(within(origin).getByRole('button', { name: m.thread_reply_to_post() }));
  await expect(editor).toHaveTextContent('Unsent writing stays mounted');
  const parentLink = within(origin).getByRole('link', { name: m.thread_reply_parent() });
  await userEvent.click(parentLink);
  await expect(parent).toHaveFocus();
  const wrapper = parent.closest<HTMLElement>('[data-conversation-row]')!;
  const collapse = within(wrapper).getByRole('button', { name: m.thread_branch_collapse({ count: 8 }) });
  collapse.focus();
  await userEvent.keyboard('{ArrowLeft}');
  await expect(origin).not.toBeVisible();
  await expect(unrelated).toBeVisible();
  await expect(editor).toHaveTextContent('Unsent writing stays mounted');
  const controlled = collapse.getAttribute('aria-controls')!.split(' ');
  await expect(controlled).toHaveLength(8);
  const back = canvas.getByRole('button', { name: m.thread_branch_return({ position: 5 }) });
  back.focus();
  await userEvent.keyboard('{Enter}');
  await expect(parentLink).toHaveFocus();
  await expect(origin).toBeVisible();
  await expect(editor).toHaveTextContent('Unsent writing stays mounted');
  await userEvent.click(collapse);
  collapse.focus();
  await userEvent.keyboard('{ArrowRight}');
  await expect(origin).toBeVisible();
  const box = collapse.getBoundingClientRect();
  await expect(box.width).toBeGreaterThanOrEqual(44);
  await expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(canvasElement.querySelectorAll('[data-conversation-row]')).toHaveLength(12);
}
export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: journey };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: journey };
export const DesktopLight: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' }, play: journey };
export const DesktopDark: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'dark' }, play: journey };
export const BoundedAndUnavailable: Story = {
  args: { boundaryStates: true }, globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('link', { name: m.thread_branch_continue() }).length).toBeGreaterThan(0);
    const missing = canvasElement.querySelector<HTMLElement>(`#post-${id(403)}`)!;
    await expect(within(missing).getByRole('link', { name: m.thread_branch_parent_destination() })).toHaveAttribute('href', expect.stringContaining(`post=${id(999)}`));
    const withheld = canvasElement.querySelector<HTMLElement>(`#post-${id(405)}`)!;
    await expect(within(withheld).getByRole('link', { name: m.thread_reply_parent_unavailable() })).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-relationship-stop="cycle"]')).toHaveLength(3);
  },
};
