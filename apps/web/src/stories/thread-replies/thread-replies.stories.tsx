import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import { checkDocument } from '@rezics/document';
import { DocumentBody } from '../../document-body';
import { ReplyButton, ReplyContext, ReplyParentReader, type ReplyParents } from '../../threads/reply-context';
import { readReplyParent } from '../../threads/reads';
import { useSession } from '../../session/query';
import { ThreadReplyComposer } from '../../threads/reply-context-composer';
import type { ReplyCommand } from '../../threads/reply-context-intent';
import type { CreatedPost, WriteFailure } from '../../threads/actions';
import { m } from '../../paraglide/messages.js';
import recording from '../../kernel/recorded/thread-owned-posts.json';

const parent = recording.posts[0]!;
const parents: ReplyParents = new Map([[parent.id, { id: parent.id, availability: 'available' }]]);
const write = fn<(input: ReplyCommand) => Promise<{ ok: true; value: CreatedPost } | WriteFailure>>();
function Journey() {
  const [target, setTarget] = useState<{ parentId: string | null; focusRequest: number }>({
    parentId: null,
    focusRequest: 0,
  });
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<CreatedPost>();
  const select = (parentId: string | null) =>
    setTarget((current) => ({ parentId, focusRequest: current.focusRequest + 1 }));
  return (
    <div className="mx-auto max-w-3xl space-y-6 text-foreground">
      <div id={`post-${parent.id}`} className="space-y-3">
        {checkDocument(parent.body) ? <DocumentBody document={parent.body} /> : null}
        <ReplyButton disabled={pending} onReply={() => select(parent.id)} />
      </div>
      {sent ? <ReplyContext parentId={sent.parentId} parents={parents} /> : null}
      <ThreadReplyComposer
        {...target}
        parents={parents}
        pending={pending}
        initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000001"
        containerId={parent.threadId}
        onPendingChange={setPending}
        onCancel={() => select(null)}
        onSubmit={write}
        onSuccess={(post) => {
          setSent(post);
          select(null);
        }}
      />
    </div>
  );
}
const meta = {
  title: 'Patterns/Community/Thread replies',
  parameters: { layout: 'padded' },
  render: () => <Journey />,
  beforeEach: () => {
    write.mockReset().mockResolvedValue({ ok: false, reason: 'unavailable' });
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
async function selectAndType({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole('textbox', { name: m.thread_reply_label() })).toHaveClass('ProseMirror'));
  const editor = canvas.getByRole('textbox', { name: m.thread_reply_label() });
  await userEvent.click(canvas.getByRole('button', { name: m.thread_reply_to_post() }));
  await expect(editor).toHaveFocus();
  await userEvent.type(editor, 'Keep my reply draft.');
  return { canvas, editor };
}
export const Rest: Story = {};
export const Selected: Story = {
  play: async (context) => {
    await selectAndType(context);
  },
};
export const Cancelled: Story = {
  play: async (context) => {
    const { canvas, editor } = await selectAndType(context);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_reply_cancel_target() }));
    await expect(editor).toHaveFocus();
    await expect(editor).toHaveTextContent('Keep my reply draft.');
    await expect(canvas.queryByRole('status')).toBeNull();
  },
};
export const Retry: Story = {
  beforeEach: () => {
    write
      .mockReset()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockImplementation(async (input) => ({
        ok: true,
        value: {
          ...parent,
          body: input.body,
          parentId: input.parentId ?? null,
          availability: 'available',
          visibility: 'published',
          id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
        },
      }));
  },
  play: async (context) => {
    const { canvas, editor } = await selectAndType(context);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_write_send() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.thread_write_unavailable());
    await expect(editor).toHaveTextContent('Keep my reply draft.');
    await userEvent.click(canvas.getByRole('button', { name: m.thread_write_retry() }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await expect(write.mock.calls[1]![0]).toEqual(write.mock.calls[0]![0]);
    await waitFor(() => expect(editor).not.toHaveTextContent('Keep my reply draft.'));
    await expect(canvas.getByRole('link', { name: m.thread_reply_parent() })).toHaveAttribute(
      'href',
      `#post-${parent.id}`,
    );
  },
};
export const Refused: Story = {
  beforeEach: () => {
    write.mockReset().mockResolvedValue({ ok: false, reason: 'forbidden' });
  },
  play: async (context) => {
    const { canvas, editor } = await selectAndType(context);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_write_send() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.thread_write_forbidden());
    await expect(editor).toHaveTextContent('Keep my reply draft.');
    await expect(canvas.getByRole('button', { name: m.thread_reply_cancel_target() })).toBeEnabled();
  },
};
export const Pending: Story = {
  beforeEach: () => {
    write.mockReset().mockImplementation(() => new Promise(() => {}));
  },
  play: async (context) => {
    const { canvas } = await selectAndType(context);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_write_send() }));
    await expect(canvas.getByRole('button', { name: m.thread_reply_cancel_target() })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: m.thread_reply_to_post() })).toBeDisabled();
  },
};
function UnloadedParentContext() {
  const { state, subject, csrfToken } = useSession();
  const reader = useMemo(() => {
    if (state !== 'signed-in' && state !== 'signed-out') return undefined;
    return new ReplyParentReader(parent.threadId, (parentId) =>
      readReplyParent({
        data: { threadId: parent.threadId, parentId, credentialMode: state === 'signed-in' ? 'session' : 'anonymous' },
      }),
    );
  }, [state, subject, csrfToken]);
  useEffect(() => {
    reader?.activate();
    return () => reader?.dispose();
  }, [reader]);
  return <ReplyContext parentId={parent.id} parents={new Map()} reader={reader} />;
}
export const UnloadedParent: Story = { render: () => <UnloadedParentContext /> };
export const DeletedParent: Story = {
  render: () => (
    <ReplyContext parentId={parent.id} parents={new Map([[parent.id, { id: parent.id, availability: 'erased' }]])} />
  ),
};
export const WithheldParent: Story = {
  render: () => (
    <ReplyContext parentId={parent.id} parents={new Map([[parent.id, { id: parent.id, availability: 'withheld' }]])} />
  ),
};
