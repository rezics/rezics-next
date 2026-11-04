import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { useLayoutEffect } from 'react';
import { PageStory, pagePaths, newThreadReady } from './page';
import { m } from '../paraglide/messages.js';
import type { DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import { suggestionResponse } from '../search/suggestions';
import { getLocale } from '../paraglide/runtime.js';
import searchRecording from '../kernel/recorded/search.json';

const meta = {
  title: 'Pages/Community/Post Editor',
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
    const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000086';
    const containerId = '0192f3a0-6c1e-7b2a-9d4e-000000000087';
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input), window.location.href).pathname;
      if (path !== '/media' && path !== `/media/${mediaId}`) return original(input, init);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        byteCount = body.byteCount;
        if (body.newThread) {
          if (!first) return Response.json({}, { status: 409 });
          first = false;
        } else if (uncertain) {
          uncertain = false;
          throw new TypeError('Reservation response unavailable');
        }
      }
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      return Response.json({
        media: {
          id: mediaId,
          containerId,
          state: init?.method === 'POST' ? 'reserved' : 'available',
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
      await userEvent.click(view.getByRole('button', { name: m.editor_image(), exact: true }));
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
    // Leave the real recovery control visible; deliberate retry uses the retained command.
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
