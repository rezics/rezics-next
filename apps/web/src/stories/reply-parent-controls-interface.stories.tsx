import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { fromPlainText } from '@rezics/document';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { Byline } from '../threads/byline';
import { ReplyButton, ReplyContext, ReplyParentReader, type ReplyParents } from '../threads/reply-context';
import { ThreadReplyComposer } from '../threads/reply-context-composer';
import type { ReplyCommand } from '../threads/reply-context-intent';
import type { ReplyParentResult } from '../threads/reply-parent-read';
import type { CreatedPost, WriteFailure } from '../threads/actions';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import recording from '../kernel/recorded/thread-owned-posts.json';
import accounts from '../kernel/recorded/accounts.json';

// Prepared component observations, authored UNRUN. These mocks establish no native admission.
const post = recording.posts[0]!;
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const remoteIds = [id(910), id(911)] as const;
const author = {
  ...accounts.accounts[0]!,
  kind: 'actor' as const,
  state: 'active' as const,
  displayName: 'A reader with a very long name in a conversation about distant planets and patient journeys',
  handle: 'a_long_unbroken_parent_handle_'.repeat(5),
};
const admittedText = 'The complete admitted teaser keeps its final words. '.repeat(4);
const licence = `LicenseRef-${'a-long-admitted-licence-'.repeat(6)}`;
const read = fn<(parentId: string) => Promise<ReplyParentResult>>();
const write = fn<(input: ReplyCommand) => Promise<{ ok: true; value: CreatedPost } | WriteFailure>>();
const parents: ReplyParents = new Map([[post.id, { id: post.id, availability: 'available' }]]);
const privateAuthor = { ...author, id: id(922), displayName: 'Private parent identity must never appear' };
const hidden: ReplyParents = new Map(
  (['erased', 'withheld'] as const).map((availability, index) => [
    id(920 + index),
    {
      id: id(920 + index),
      availability,
      body: fromPlainText('Private parent body must never appear', 'blocks'),
      authorId: privateAuthor.id,
    },
  ]),
);

function Controls() {
  const [reader] = useState(() => new ReplyParentReader(post.threadId, read));
  useEffect(() => reader.connect(), [reader]);
  const [target, setTarget] = useState({ parentId: null as string | null, focusRequest: 0 });
  const [pending, setPending] = useState(false);
  const [currentParents, setCurrentParents] = useState(parents);
  const select = (parentId: string | null) =>
    setTarget((current) => ({ parentId, focusRequest: current.focusRequest + 1 }));
  return (
    <div className="mx-auto max-w-3xl space-y-6 text-foreground">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {[remoteIds[0], remoteIds[1], remoteIds[0]].map((parentId, index) => (
          <div
            key={index}
            data-parent-example={index}
            className="min-w-0 rounded-xl border p-3"
            style={index === 2 ? { maxWidth: '8rem' } : undefined}
          >
            <ReplyContext parentId={parentId} parents={new Map()} reader={reader} />
          </div>
        ))}
        {[...hidden.keys()].map((parentId) => (
          <div key={parentId} data-private-parent>
            <ReplyContext parentId={parentId} parents={hidden} authors={{ [privateAuthor.id]: privateAuthor }} />
          </div>
        ))}
      </div>
      <ol>
        <li id={`post-${post.id}`}>
          <ContentItemFrame className="min-w-0 space-y-3 p-3">
            <Byline author={author} createdAt={post.createdAt} now={post.createdAt} />
            <DocumentBody document={fromPlainText('The parent document stays a complete document.', 'blocks')} />
            <ReplyButton disabled={pending} onReply={() => select(post.id)} />
          </ContentItemFrame>
        </li>
      </ol>
      <Button type="button" variant="outline" onClick={() => setCurrentParents(new Map(parents))}>
        Refresh context
      </Button>
      <section aria-label={m.thread_reply_label()} className="min-w-0">
        <ThreadReplyComposer
          {...target}
          parents={currentParents}
          pending={pending}
          initialKey={id(930)}
          containerId={post.threadId}
          credentialMode="session"
          onPendingChange={setPending}
          onCancel={() => select(null)}
          onSubmit={write}
          onSuccess={() => select(null)}
        />
      </section>
    </div>
  );
}

const meta = {
  title: 'Patterns/Community/Reply parent controls interface',
  component: Controls,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'UNRUN prepared component journey; native, browser, accessibility and physical acceptance remain owed. The narrow duplicate forces control labels to wrap; author and licence labels are deliberately long. Review at 320/390/1280px, enlarged text, all locale and theme globals. Context refresh here replaces supplied parents; the companion regression exercises an actual personal query refetch through ThreadReading.',
      },
    },
  },
  beforeEach: () => {
    let secondAttempts = 0;
    read.mockReset().mockImplementation(async (parentId) => {
      if (parentId === remoteIds[1] && secondAttempts++ === 0) return { state: 'unavailable' };
      return {
        state: 'available',
        id: parentId,
        threadId: post.threadId,
        revisionId: id(940),
        author,
        excerpt: admittedText,
        licence,
      };
    });
    write.mockReset().mockResolvedValue({ ok: false, reason: 'unavailable' });
  },
} satisfies Meta<typeof Controls>;
export default meta;
type Story = StoryObj<typeof meta>;

function targetSize(control: HTMLElement) {
  const box = control.getBoundingClientRect();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(getComputedStyle(control).whiteSpace).toBe('normal');
}

export const CompleteControls: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const examples = [...canvasElement.querySelectorAll<HTMLElement>('[data-parent-example]')];
    const toggles = examples.map((element) =>
      within(element).getByRole('button', { name: m.thread_reply_parent_view() }),
    );
    const ids = toggles.map((toggle) => toggle.getAttribute('aria-controls'));
    await expect(new Set(ids).size).toBe(3);
    ids.forEach((regionId) => remoteIds.forEach((parentId) => expect(regionId).not.toContain(parentId)));
    await expect(read).not.toHaveBeenCalled();
    toggles.forEach(targetSize);
    await expect(toggles[2]!.getBoundingClientRect().height).toBeGreaterThan(44);
    toggles[0]!.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(examples[0]).toHaveTextContent(admittedText.trim()));
    await expect(toggles[2]).toHaveAttribute('aria-expanded', 'true');
    await expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
    await expect(examples[0]!.querySelector('section')?.id).toBe(ids[0]);
    await expect(examples[2]!.querySelector('section')?.id).toBe(ids[2]);
    await userEvent.click(toggles[1]!);
    const retry = await within(examples[1]!).findByRole('button', { name: m.exact_revision_retry() });
    targetSize(retry);
    await expect(examples[1]!.querySelector('a')).toBeNull();
    await expect(read).toHaveBeenCalledTimes(2);
    retry.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(examples[1]).toHaveTextContent(admittedText.trim()));
    await expect(read).toHaveBeenCalledTimes(3);
    for (let index = 0; index < examples.length; index++) {
      const example = within(examples[index]!);
      await expect(examples[index]!.scrollWidth).toBeLessThanOrEqual(examples[index]!.clientWidth);
      await expect(example.getByText(author.displayName)).toBeVisible();
      await expect(example.getByText(`${m.thread_history_licence()}: ${licence}`)).toBeVisible();
      await expect(example.getByRole('link', { name: m.exact_revision_heading() })).toHaveAttribute(
        'href',
        exactRevisionHref({ postId: index === 1 ? remoteIds[1] : remoteIds[0], revisionId: id(940) }, getLocale()),
      );
    }
    await userEvent.click(toggles[0]!);
    await expect(toggles[2]).toHaveAttribute('aria-expanded', 'false');
    await expect(toggles[1]).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggles[0]!);
    await expect(read).toHaveBeenCalledTimes(3);
    await expect(canvasElement.innerHTML).not.toContain('Private parent body must never appear');
    await expect(canvasElement.innerHTML).not.toContain(privateAuthor.displayName);
    for (const hiddenParent of canvasElement.querySelectorAll('[data-private-parent]')) {
      await expect(hiddenParent.querySelectorAll('a')).toHaveLength(1);
      await expect(hiddenParent.querySelector('a')).toHaveAttribute('href', expect.stringMatching(/^#post-/));
    }

    const region = canvas.getByRole('region', { name: m.thread_reply_label() });
    const composer = within(region);
    const editor = await waitFor(() => {
      const node = composer.getByRole('textbox', { name: m.thread_reply_label() });
      expect(node).toHaveClass('ProseMirror');
      return node;
    });
    const form = region.querySelector('form');
    const reply = canvas.getByRole('button', { name: m.thread_reply_to_post() });
    targetSize(reply);
    reply.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(editor).toHaveFocus());
    await userEvent.keyboard('Keep the exact draft through selection, refresh, retry and cancellation.');
    await userEvent.tab();
    const view = () =>
      (editor as HTMLElement & { pmViewDesc: { view: unknown; node: { toJSON: () => unknown } } }).pmViewDesc;
    const mountedEditor = view().view;
    await expect(mountedEditor).toBeDefined();
    const snapshot = () => view().node.toJSON();
    const draft = snapshot();
    const cancel = composer.getByRole('button', { name: m.thread_reply_cancel_target() });
    targetSize(cancel);
    await expect(composer.getByRole('link', { name: m.thread_reply_parent() })).toHaveAttribute(
      'href',
      `#post-${post.id}`,
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh context' }));
    await expect(composer.getByRole('textbox', { name: m.thread_reply_label() })).toBe(editor);
    await expect(region.querySelector('form')).toBe(form);
    await expect(view().view).toBe(mountedEditor);
    await expect(snapshot()).toEqual(draft);
    let release!: (value: WriteFailure) => void;
    write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await userEvent.click(composer.getByRole('button', { name: m.thread_write_send() }));
    await waitFor(() => expect(cancel).toBeDisabled());
    await expect(reply).toBeDisabled();
    cancel.click();
    await expect(composer.getByRole('link', { name: m.thread_reply_parent() })).toHaveAttribute(
      'href',
      `#post-${post.id}`,
    );
    release({ ok: false, reason: 'unavailable' });
    await composer.findByRole('alert');
    write.mockResolvedValueOnce({ ok: false, reason: 'forbidden' });
    await userEvent.click(composer.getByRole('button', { name: m.thread_write_retry() }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await expect(write.mock.calls[1]![0]).toEqual(write.mock.calls[0]![0]);
    await waitFor(() => expect(cancel).toBeEnabled());
    cancel.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(editor).toHaveFocus());
    await expect(composer.queryByRole('button', { name: m.thread_reply_cancel_target() })).toBeNull();
    await expect(composer.queryByRole('link', { name: m.thread_reply_parent() })).toBeNull();
    await expect(composer.getByRole('textbox', { name: m.thread_reply_label() })).toBe(editor);
    await expect(region.querySelector('form')).toBe(form);
    await expect(view().view).toBe(mountedEditor);
    await expect(snapshot()).toEqual(draft);
    await expect(canvas.getAllByRole('textbox', { name: m.thread_reply_label() })).toHaveLength(1);
  },
};
