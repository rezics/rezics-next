import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import type { CurrentPost, EditFailure, WriteFailure } from '../threads/actions';
import type { DraftMediaState } from '../threads/media-state';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';
import { sessionQuery } from '../session/query';
import recorded from '../kernel/recorded/thread-owned.json';

const meta = {
  title: 'Community/Authoring/Authoring Controls',
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

function AuthoringStory({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const fixture = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    fixture.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: post.authorId,
      csrfToken: 'prepared-authoring-session',
    });
    return fixture;
  });
  return (
    <PatternStory visitor="Signed In">
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </PatternStory>
  );
}

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
  await expect(getComputedStyle(control).minHeight).toBe('28px');
  await expect(getComputedStyle(control).whiteSpace).toBe('normal');
  await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
  control.scrollIntoView({ block: 'center' });
  const rect = control.getBoundingClientRect();
  await expect(rect.height).toBeGreaterThanOrEqual(28);
  const centerX = (rect.left + rect.right) / 2;
  for (const y of [rect.top + 1, rect.bottom - 1]) {
    await expect(control.contains(control.ownerDocument.elementFromPoint(centerX, y))).toBe(true);
  }
  control.focus();
  await expect(control).toHaveFocus();
}

export const OpeningAndReply: Story = {
  render: () => (
    <AuthoringStory>
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
    </AuthoringStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const title = await view.findByLabelText(m.thread_title_label());
    await waitFor(() => expect(canvasElement.querySelectorAll('.ProseMirror')).toHaveLength(2));
    const sendButtons = () => view.getAllByRole<HTMLButtonElement>('button', { name: m.thread_write_send() });
    const [openingSend, replySend] = sendButtons();
    await expect(title.id).toBe('thread-title');
    await expect((title as HTMLInputElement).form).toBe(openingSend!.form);
    await expect(openingSend!.form).not.toBe(replySend!.form);
    await expect(openingSend).toBeDisabled();
    await userEvent.type(title, m.thread_media_state_unavailable());
    await waitFor(() => expect(sendButtons()[0]).toBeEnabled());
    for (const send of sendButtons()) await ownControl(send);
    await userEvent.click(sendButtons()[1]!);
    const retry = await view.findByRole('button', { name: m.thread_recovery_retry_original() });
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
      <AuthoringStory>
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
      </AuthoringStory>
    );
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const save = await view.findByRole('button', { name: m.thread_edit_save() });
    const cancel = await view.findByRole('button', { name: m.thread_edit_cancel() });
    await ownControl(save);
    await ownControl(cancel);
    await userEvent.click(save);
    const review = await waitFor(() => {
      const control = view.getByRole('button', { name: m.thread_edit_review_current() });
      expect(control).toBeEnabled();
      expect(getComputedStyle(control).minHeight).toBe('28px');
      return control;
    });
    await ownControl(review);
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog', { name: m.thread_inspect_title() });
    const replace = within(dialog).getByRole('button', { name: m.thread_edit_replace_current() });
    await userEvent.click(replace);
    await waitFor(() => expect(view.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(canvasElement.querySelector('.ProseMirror')).toHaveTextContent(m.thread_media_state_unavailable()),
    );
  },
};

export const MediaRecoveryLongText: Story = {
  render: () => (
    <AuthoringStory>
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
    </AuthoringStory>
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
