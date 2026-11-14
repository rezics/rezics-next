import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { useLayoutEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { fromPlainText } from '@rezics/document';
import type { RevisedPost, WriteFailure } from '../threads/actions';
import { sessionQueryKey } from '../reader/lifetime/index';
import { PageStory, pagePaths, newThreadReady } from './page';
import { m } from '../paraglide/messages.js';
import type { DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import { suggestionResponse } from '../search/suggestions';
import { getLocale } from '../paraglide/runtime.js';
import searchRecording from '../kernel/recorded/search.json';

const meta = {
  title: 'Community/Post Editor',
  id: 'pages-community-post-editor',
  excludeStories: ['AuthoringRecoveryExample', 'originalRequestJourney'],
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const reply = () => <PageStory visitor="Signed In" path={pagePaths['thread']} />;
const newThread = () => <PageStory visitor="Signed In" path={pagePaths['board-new']} />;
let subjectQueries: string[] = [];
let releaseLateSubjects: (() => void) | undefined;
const emptyReplyPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const send = await view.findByRole('button', { name: m.thread_write_send() });
  await expect(send).toBeDisabled();
};
const textReplyPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const editor = await view.findByRole('textbox', { name: m.thread_reply_label() });
  await userEvent.click(editor);
  await userEvent.keyboard('A thoughtful reply with a few lines.');
};
const imageReplyPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const editor = await view.findByRole('textbox', { name: m.thread_reply_label() });
  await userEvent.click(editor);
  await userEvent.click(await view.findByRole('button', { name: m.editor_image() }));
  const dialog = await view.findByRole('dialog', { name: m.editor_image() });
  await userEvent.upload(
    within(dialog).getByLabelText(m.editor_upload_file()),
    new File(
      [
        Uint8Array.from(
          atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F5sAAAAASUVORK5CYII='),
          (char) => char.charCodeAt(0),
        ),
      ],
      'pixel.png',
      { type: 'image/png' },
    ),
  );
  await userEvent.type(within(dialog).getByLabelText(m.editor_image_alt()), 'A small test image');
  await userEvent.click(within(dialog).getByRole('button', { name: m.editor_insert_image() }));
};
const refusalPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const editor = await view.findByRole('textbox', { name: m.thread_reply_label() });
  await userEvent.click(editor);
  await userEvent.keyboard('A reply that the story will refuse to send.');
  await waitFor(async () => expect(await view.findByRole('button', { name: m.thread_write_send() })).toBeEnabled());
  await userEvent.click(await view.findByRole('button', { name: m.thread_write_send() }));
  await view.findByRole('alert');
};
const longThreadPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  const editor = await view.findByRole('textbox', { name: m.thread_new_body_label() });
  await userEvent.click(editor);
  await userEvent.keyboard(
    'A long opening post with enough words to demonstrate how the editor grows as the author writes.\n\nIt continues in another paragraph to show the writing surface at a useful height.',
  );
};

const pastedBody: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'reply-text' },
        content: [{ type: 'text', text: 'A reply with a copied image.' }],
      },
    ],
  },
};
const reusedImageId = '0192f3a0-6c1e-7b2a-9d4e-000000000075';
const reusedBody: DocumentSnapshot = {
  ...pastedBody,
  doc: {
    ...pastedBody.doc,
    content: [
      ...(pastedBody.doc.content ?? []),
      { type: 'image', attrs: { id: 'reused-image', src: `/media/${reusedImageId}/original`, alt: 'Copied chart' } },
    ],
  },
};
const pasteReuploadPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  await view.findByRole('img', { name: 'Copied chart' });
  await expect(view.getByRole('button', { name: m.thread_write_send() })).toBeDisabled();
  await view.findByRole('status', { name: m.editor_uploading() });
};
const reusedMediaPlay: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
  await view.findByText(m.thread_media_used());
  await view.findByRole('button', { name: m.thread_media_upload_again() });
};
const usedMedia = () => (
  <main className="mx-auto max-w-3xl p-4 sm:p-8">
    <InlinePostEditor
      initialBody={reusedBody}
      revisionId="revision-1"
      idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000076"
      containerId="0192f3a0-6c1e-7b2a-9d4e-000000000077"
      onSubmit={async () => ({
        ok: false,
        reason: 'media-unavailable',
        media: [{ id: reusedImageId, state: 'available' }],
      })}
      onCancel={() => undefined}
      onSuccess={() => undefined}
    />
  </main>
);
function ReuploadingReply() {
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const interceptedFetch = Object.assign(
      (
        input: Parameters<typeof window.fetch>[0],
        init?: Parameters<typeof window.fetch>[1],
      ): ReturnType<typeof window.fetch> => {
        const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (new URL(href, window.location.origin).pathname === `/media/${reusedImageId}/original`)
          return new Promise<Response>(() => {});
        return originalFetch.call(window, input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    window.fetch = interceptedFetch;
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <PostComposer
        initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000078"
        initialBody={reusedBody}
        containerId="0192f3a0-6c1e-7b2a-9d4e-000000000077"
        onSubmit={async () => ({ ok: false, reason: 'unavailable' })}
        onSuccess={() => undefined}
      />
    </main>
  );
}

export const ReplyEmpty: Story = {
  name: 'Reply / Empty',
  render: reply,
  play: emptyReplyPlay,
};
export const ReplyWithText: Story = {
  name: 'Reply / With text',
  render: reply,
  play: textReplyPlay,
};
export const ReplyWithImage: Story = { name: 'Reply / With image', play: imageReplyPlay, render: reply };
export const ReplyRefusal: Story = { name: 'Reply / Refusal', play: refusalPlay, render: reply };
export const NewThreadEmpty: Story = { name: 'New thread / Empty', play: newThreadReady, render: newThread };
export const NewThreadLong: Story = {
  name: 'New thread / Long',
  render: newThread,
  beforeEach: () => {
    const original = globalThis.fetch;
    let first = true;
    let uncertain = true;
    let byteCount = 0;
    let rejected = false;
    const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000086';
    const containerId = '0192f3a0-6c1e-7b2a-9d4e-000000000087';
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path !== '/media' && !path.startsWith(`/media/${mediaId.slice(0, -1)}`)) return original(input, init);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        byteCount = body.byteCount;
        if (body.newThread) {
          if (!first) return Response.json({}, { status: 409 });
          first = false;
        } else if (uncertain) {
          uncertain = false;
          throw new TypeError('Reservation response unavailable');
        } else rejected = true;
      }
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      return Response.json({
        media: {
          id: rejected ? `${mediaId.slice(0, -1)}8` : mediaId,
          containerId,
          state: init?.method === 'POST' ? 'reserved' : rejected ? 'rejected' : 'available',
          mediaType: 'image/png',
          byteCount,
        },
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
  play: async (context) => {
    await longThreadPlay(context);
    const view = within(context.canvasElement);
    const attach = async (name: string) => {
      await userEvent.click(view.getByRole('button', { name: m.editor_image() }));
      const dialog = await screen.findByRole('dialog', { name: m.editor_image() });
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F5sAAAAASUVORK5CYII='),
        (char) => char.charCodeAt(0),
      );
      await userEvent.upload(
        within(dialog).getByLabelText(m.editor_upload_file()),
        new File([bytes], name, { type: 'image/png' }),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: m.editor_insert_image() }));
      return view;
    };
    await attach('first.png');
    await waitFor(() => expect(view.queryByRole('dialog', { name: m.editor_image() })).toBeNull());
    await waitFor(() => expect(view.getByRole('button', { name: m.thread_write_send() })).toBeEnabled());
    const second = await attach('second.png');
    await expect(await second.findByRole('button', { name: m.editor_retry_upload() })).toBeEnabled();
    await expect(view.getByText(m.thread_attachment_reservation_unknown())).toBeVisible();
    await attach('rejected.png');
    await expect(await view.findByText(m.editor_upload_rejected())).toBeVisible();
    await expect(view.getByRole('button', { name: m.thread_attachment_replace() })).toBeEnabled();
    await expect(view.getByRole('button', { name: m.thread_write_send() })).toBeDisabled();
  },
};
export const NewThreadDeparture: Story = {
  name: 'New thread / Protect changed writing on departure',
  render: newThread,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const title = await view.findByLabelText(m.thread_title_label());
    await userEvent.type(title, 'An opening that is not saved yet');
    const destination = view.getByRole('link', { name: m.board_threads_heading() });
    await userEvent.click(destination);
    let dialog = await screen.findByRole('alertdialog', { name: m.thread_authoring_leave_title() });
    await expect(dialog).toHaveTextContent(m.thread_authoring_leave_unsaved());
    await userEvent.click(within(dialog).getByRole('button', { name: m.thread_authoring_stay() }));
    await expect(title).toHaveValue('An opening that is not saved yet');
    await userEvent.click(destination);
    dialog = await screen.findByRole('alertdialog', { name: m.thread_authoring_leave_title() });
    await userEvent.click(within(dialog).getByRole('button', { name: m.thread_authoring_leave() }));
    await view.findByRole('heading', { name: m.board_threads_heading() });
  },
};
export const NewThreadSubjects: Story = {
  name: 'New thread / Choose subjects',
  render: () => (
    <PageStory
      visitor="Signed In"
      path={`${pagePaths['board-new']}?subject=${searchRecording.subjects[0]!.id}&subjectTitle=Original%20title%20hint`}
    />
  ),
  beforeEach: () => {
    const original = globalThis.fetch;
    subjectQueries = [];
    releaseLateSubjects = undefined;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== '/api/search/suggestions') return original(input, init);
      subjectQueries.push(url.searchParams.get('q')!);
      if (url.searchParams.get('q') === 'old')
        await new Promise<void>((resolve) => {
          releaseLateSubjects = resolve;
        });
      if (url.searchParams.get('q') === 'unavailable') return new Response(null, { status: 503 });
      return suggestionResponse(new Request(url, init), {});
    }) as typeof fetch;
    return () => {
      releaseLateSubjects?.();
      globalThis.fetch = original;
    };
  },
  play: async (context) => {
    await newThreadReady(context);
    const canvas = within(context.canvasElement);
    const region = within(canvas.getByRole('region', { name: m.thread_discussion_subjects() }));
    await expect(region.getByText('Original title hint')).toBeVisible();
    await userEvent.click(region.getByRole('button'));
    await expect(region.queryByRole('listitem')).toBeNull();
    const body = canvas.getByRole('textbox', { name: m.thread_new_body_label() });
    await userEvent.click(body);
    await userEvent.keyboard('Keep this draft while choosing subjects.');
    const input = region.getByRole('combobox');
    await userEvent.type(input, 'The');
    for (const subject of searchRecording.subjects) {
      const title = pickText(subject.labels, getLocale()).text;
      await userEvent.click(await screen.findByRole('option', { name: new RegExp(title) }));
    }
    await expect(region.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.clear(input);
    await userEvent.type(input, 'old');
    await waitFor(() => expect(releaseLateSubjects).toBeDefined());
    await userEvent.clear(input);
    await userEvent.type(input, 'The');
    await screen.findAllByRole('option');
    releaseLateSubjects?.();
    await userEvent.clear(input);
    await userEvent.type(input, 'unavailable');
    await waitFor(() => expect(subjectQueries).toEqual(['The', 'old', 'The', 'unavailable']));
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull());
    await expect(region.getAllByRole('listitem')).toHaveLength(2);
    await expect(body).toHaveTextContent('Keep this draft while choosing subjects.');
    await userEvent.keyboard('{Escape}');
    for (const remove of region.getAllByRole('button')) await userEvent.click(remove);
    await expect(region.queryByRole('listitem')).toBeNull();
    await userEvent.type(canvas.getByRole('textbox', { name: m.thread_title_label() }), 'No references required');
    await expect(canvas.getByRole('button', { name: m.thread_write_send() })).toBeEnabled();
  },
};
export const ReplyPastedImageUploading: Story = {
  name: 'Reply / Pasted image uploading again',
  render: () => <ReuploadingReply />,
  play: pasteReuploadPlay,
};
export const ReplyImageUsed: Story = {
  name: 'Reply / Image used in another post',
  render: usedMedia,
  play: reusedMediaPlay,
};

type RecoveryKind = 'create' | 'reply' | 'edit' | 'publish';
type RecoveryResult = { ok: true; value: string; post: RevisedPost } | WriteFailure;
/** Prepared transport only: real shared composer, request owner, reader, editor and departure confirmation. */
export function AuthoringRecoveryExample({ kind = 'reply' }: { kind?: RecoveryKind }) {
  const [client] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQueryKey, {
      state: 'signed-in',
      subject: 'prepared-author',
      csrfToken: 'prepared-authoring-credential',
    });
    return client;
  });
  const [commands, setCommands] = useState<object[]>([]);
  const count = useRef(0);
  const pending = useRef<((result: RecoveryResult) => void) | null>(null);
  const [completed, setCompleted] = useState(false);
  const accepted = (): RecoveryResult => ({
    ok: true,
    value: 'acknowledged',
    post: { id: 'prepared-post', revisionId: 'acknowledged-revision' } as RevisedPost,
  });
  const submit = async (command: object): Promise<RecoveryResult> => {
    count.current++;
    setCommands((current) => [...current, structuredClone(command)]);
    if (count.current === 1) return { ok: false, reason: 'unavailable' };
    if (count.current > 2) return accepted();
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  };
  const finish = () => {
    pending.current?.(accepted());
    pending.current = null;
  };
  const refuse = () => {
    pending.current?.({ ok: false, reason: 'invalid' });
    pending.current = null;
  };
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto min-w-0 max-w-4xl space-y-4 p-4 sm:p-8">
        <p className="rounded-lg border border-border p-3 text-sm">
          Prepared transport: the first response is lost. Original retry waits for the supplied acknowledgement or
          refusal below. The command reader and working editor are real; no native request is sent.
        </p>
        <output aria-label="Prepared command count">{commands.length}</output>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button className="h-auto min-h-11 whitespace-normal" onClick={finish}>
            Prepared acknowledge original
          </Button>
          <Button className="h-auto min-h-11 whitespace-normal" onClick={refuse}>
            Prepared refuse original
          </Button>
        </div>
        {completed ? (
          <p role="status">Prepared deliberate completion</p>
        ) : kind === 'edit' || kind === 'publish' ? (
          <InlinePostEditor
            initialBody={fromPlainText('The original submitted correction.', 'blocks')}
            revisionId="original-revision"
            idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000082"
            containerId="0192f3a0-6c1e-7b2a-9d4e-000000000077"
            allowPublish={kind === 'publish'}
            onSubmit={submit}
            onPublish={submit}
            onCancel={() => setCompleted(true)}
            onSuccess={() => setCompleted(true)}
          />
        ) : (
          <PostComposer
            initialBody={fromPlainText('The original submitted writing.', 'blocks')}
            initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000081"
            localDraft={false}
            titleRequired={kind === 'create'}
            {...(kind === 'create'
              ? { boardId: '0192f3a0-6c1e-7b2a-9d4e-000000000077' }
              : { containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000077' })}
            replyTargetId={kind === 'reply' ? '0192f3a0-6c1e-7b2a-9d4e-000000000079' : null}
            onSubmit={submit}
            onSuccess={() => setCompleted(true)}
          />
        )}
        <details className="min-w-0">
          <summary className="min-h-11 cursor-pointer p-3">Prepared request operands</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
            {JSON.stringify(commands, null, 2)}
          </pre>
        </details>
      </main>
    </QueryClientProvider>
  );
}

export const originalRequestJourney =
  (kind: RecoveryKind): NonNullable<Story['play']> =>
  async ({ canvasElement }) => {
    const view = within(canvasElement);
    const label =
      kind === 'create'
        ? m.thread_new_body_label()
        : kind === 'reply'
          ? m.thread_reply_label()
          : m.thread_reply_body_label();
    const editor = await view.findByRole('textbox', { name: label });
    if (kind === 'create') await userEvent.type(view.getByLabelText(m.thread_title_label()), 'Original title');
    const send =
      kind === 'edit' ? m.thread_edit_save() : kind === 'publish' ? m.own_drafts_publish() : m.thread_write_send();
    await userEvent.click(await view.findByRole('button', { name: send }));
    await view.findByText(m.thread_recovery_unknown());
    await userEvent.click(editor);
    await userEvent.keyboard(' Newer working words.');
    if (kind === 'create') await userEvent.type(view.getByLabelText(m.thread_title_label()), ' with a newer title');
    await userEvent.click(view.getByText(m.thread_recovery_submitted(), { selector: 'summary' }));
    const submitted = within(view.getByRole('region', { name: m.thread_recovery_submitted() }));
    await expect(submitted.queryByText(/Newer working words/)).toBeNull();
    if (kind === 'create') await expect(submitted.getByText('Original title')).toBeVisible();
    const retry = view.getByRole('button', { name: m.thread_recovery_retry_original() });
    await expect(retry).toBeEnabled();
    await userEvent.click(retry);
    await expect(view.getByLabelText('Prepared command count')).toHaveTextContent('2');
    await userEvent.click(view.getByRole('button', { name: 'Prepared acknowledge original' }));
    await view.findByText(m.thread_recovery_acknowledged());
    await expect(editor).toHaveTextContent('Newer working words.');
    await expect(retry).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.thread_recovery_working() }));
    await expect(editor).toHaveFocus();
  };
export const OriginalCreateRetry: Story = {
  name: 'New thread / Edit locally and retry original',
  render: () => <AuthoringRecoveryExample kind="create" />,
  play: originalRequestJourney('create'),
};
export const OriginalReplyRetry: Story = {
  name: 'Reply / Edit locally and retry original',
  render: () => <AuthoringRecoveryExample />,
  play: originalRequestJourney('reply'),
};
export const OriginalEditRetry: Story = {
  name: 'Edit / Edit locally and retry original',
  render: () => <AuthoringRecoveryExample kind="edit" />,
  play: originalRequestJourney('edit'),
};
export const OriginalPublishRetry: Story = {
  name: 'Publish / Edit locally and retry original',
  render: () => <AuthoringRecoveryExample kind="publish" />,
  play: originalRequestJourney('publish'),
};
export const KnownRefusalCorrection: Story = {
  name: 'Reply / Correct newer writing after known refusal',
  render: () => <AuthoringRecoveryExample />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_write_send() }));
    await view.findByText(m.thread_recovery_unknown());
    const editor = view.getByRole('textbox', { name: m.thread_reply_label() });
    await userEvent.click(editor);
    await userEvent.keyboard(' Keep this correction.');
    await userEvent.click(view.getByRole('button', { name: m.thread_recovery_retry_original() }));
    await userEvent.click(view.getByRole('button', { name: 'Prepared refuse original' }));
    await view.findByText(m.thread_write_invalid());
    await expect(editor).toHaveTextContent('Keep this correction.');
    await expect(view.getByRole('button', { name: m.thread_write_send() })).toBeEnabled();
  },
};

export const OriginalReplyWithNewMedia: Story = {
  name: 'Reply / Original retry keeps newer media local',
  render: () => <AuthoringRecoveryExample />,
  beforeEach: () => {
    const original = globalThis.fetch;
    const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000083';
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path !== '/media' && path !== `/media/${mediaId}`) return original(input, init);
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      return Response.json({
        media: {
          id: mediaId,
          containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000077',
          state: init?.method === 'POST' ? 'reserved' : 'available',
          mediaType: 'image/png',
          byteCount: 68,
        },
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
  play: async (context) => {
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_write_send() }));
    await view.findByText(m.thread_recovery_unknown());
    await imageReplyPlay(context);
    await view.findByRole('img', { name: 'A small test image' });
    await userEvent.click(view.getByRole('button', { name: m.thread_recovery_retry_original() }));
    await userEvent.click(view.getByRole('button', { name: 'Prepared acknowledge original' }));
    await view.findByText(m.thread_recovery_acknowledged());
    await expect(view.getByRole('img', { name: 'A small test image' })).toBeVisible();
    await expect(view.getByLabelText('Prepared command count')).toHaveTextContent('2');
  },
};
