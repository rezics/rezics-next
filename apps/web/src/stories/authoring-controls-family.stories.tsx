import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import type { CurrentPost, EditFailure, WriteFailure } from '../threads/actions';
import type { DraftMediaState } from '../threads/media-state';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';
import recorded from '../kernel/recorded/thread-owned.json';

const meta = {
  title: 'Community/Authoring Controls',
  id: 'families-community-authoring-controls',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual opening, reply and revision composers with supplied controller outcomes. Use the global locale, phone390/desktop1280 and theme controls. Authored interaction and geometry assertions are UNRUN; these fixtures establish no native admission, privacy, lifetime or population-cost evidence.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const post = recorded.thread.firstPost;
const body = post.body as DocumentSnapshot;
const unavailable = async (): Promise<WriteFailure> => ({ ok: false, reason: 'unavailable' });
const keepDraft = () => undefined;
const shell = 'mx-auto grid w-full min-w-0 max-w-5xl gap-8 p-4 sm:p-8';
const section = 'min-w-0 space-y-3 [overflow-wrap:anywhere]';
const heading = 'text-xl font-semibold';

// These are bounded document DTO examples, following the existing composer/media fixtures.
const mediaIds = Array.from(
  { length: 6 },
  (_, index) => `0192f3a0-6c1e-7b2a-9d4e-${String(75 + index).padStart(12, '0')}`,
);
const states: DraftMediaState['state'][] = ['missing', 'rejected', 'unavailable', 'reserved', 'uploaded', 'available'];
function recoveryBody(): DocumentSnapshot {
  return {
    ...body,
    doc: {
      ...body.doc,
      content: [
        ...(body.doc.content ?? []),
        ...mediaIds.map((id, index) => ({
          type: 'image',
          attrs: {
            id: `recovery-image-${index}`,
            src: `/media/${id}/original`,
            // Keep the catalog message intact beside an unbroken supplied description.
            alt: `${m.thread_media_state_unavailable()} ${'Wiederherstellungsbeschreibung'.repeat(5)}`,
          },
        })),
      ],
    },
  };
}
const mediaRefusal = async (): Promise<EditFailure> => ({
  ok: false,
  reason: 'media-unavailable',
  media: mediaIds.map((id, index) => ({ id, state: states[index]! })),
});

async function ownControl(control: HTMLElement) {
  await expect(control).toHaveClass('min-h-11', 'min-w-11', 'whitespace-normal', '[overflow-wrap:anywhere]');
  await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  control.focus();
  await expect(control).toHaveFocus();
}

export const OpeningAndReply: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <main className={shell}>
        <h1 className={heading}>{m.thread_new_heading()}</h1>
        <section className={section} aria-label={m.thread_new_body_label()}>
          <PostComposer
            titleRequired
            boardId={recorded.thread.boardId}
            initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000081"
            initialBody={body}
            onSubmit={unavailable}
            onSuccess={keepDraft}
          />
        </section>
        <section className={section} aria-label={m.thread_reply_label()}>
          <h2 className={heading}>{m.thread_reply_label()}</h2>
          <PostComposer
            containerId={recorded.thread.id}
            replyTargetId={post.id}
            initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000082"
            initialBody={body}
            onSubmit={unavailable}
            onSuccess={keepDraft}
          />
        </section>
      </main>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const title = await view.findByLabelText(m.thread_title_label());
    const sends = await view.findAllByRole('button', { name: m.thread_write_send() });
    await waitFor(() => expect(canvasElement.querySelectorAll('.ProseMirror')).toHaveLength(2));
    await expect(title.id).toBe('thread-title');
    await expect((title as HTMLInputElement).form).toBe((sends[0] as HTMLButtonElement).form);
    await expect((sends[0] as HTMLButtonElement).form).not.toBe((sends[1] as HTMLButtonElement).form);
    await expect(sends[0]).toBeDisabled();
    await userEvent.type(title, m.thread_media_state_unavailable());
    await waitFor(() => expect(sends[0]).toBeEnabled());
    for (const send of sends) await ownControl(send);
    await userEvent.click(sends[1]!);
    const retry = await view.findByRole('button', { name: m.thread_write_retry() });
    await ownControl(retry);
  },
};

export const InlineRevision: Story = {
  render: () => {
    const currentPost = {
      ...post,
      revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000083',
      body: fromPlainText(m.thread_media_state_unavailable(), 'blocks'),
      attribution: null,
    } as CurrentPost;
    return (
      <PatternStory visitor="Signed In">
        <main className={shell}>
          <h1 className={heading}>{m.thread_edit_save()}</h1>
          <InlinePostEditor
            initialBody={body}
            initialMediaIds={post.mediaIds}
            revisionId={post.revisionId}
            idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000084"
            containerId={recorded.thread.id}
            onSubmit={async () => ({ ok: false, reason: 'stale', currentPost })}
            onCancel={keepDraft}
            onSuccess={keepDraft}
          />
        </main>
      </PatternStory>
    );
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const save = await view.findByRole('button', { name: m.thread_edit_save() });
    const cancel = await view.findByRole('button', { name: m.thread_edit_cancel() });
    await ownControl(save);
    await ownControl(cancel);
    await userEvent.click(save);
    const load = await view.findByRole('button', { name: m.thread_edit_load_current() });
    await ownControl(load);
    await userEvent.click(load);
    await waitFor(() => expect(view.queryByRole('alert')).not.toBeInTheDocument());
    await view.findByText(m.thread_media_state_unavailable());
  },
};

export const MediaRecoveryLongText: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <main className={shell}>
        <h1 className={heading}>{m.thread_media_status()}</h1>
        <InlinePostEditor
          initialBody={recoveryBody()}
          revisionId={post.revisionId}
          idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000085"
          containerId={recorded.thread.id}
          onSubmit={mediaRefusal}
          onCancel={keepDraft}
          onSuccess={keepDraft}
        />
      </main>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
    const issues = within(await view.findByRole('list', { name: m.thread_media_status() }));
    await expect(issues.getAllByRole('listitem')).toHaveLength(6);
    for (const button of issues.getAllByRole('button')) await ownControl(button);
    await issues.findByText(m.thread_media_missing());
    await issues.findByText(m.thread_media_rejected());
    await issues.findByText(m.thread_media_state_unavailable());
    await issues.findByRole('button', { name: m.thread_media_upload_again() });
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  },
};
