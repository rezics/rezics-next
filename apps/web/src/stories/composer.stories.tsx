import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useLayoutEffect } from 'react';
import { PageStory, pagePaths, newThreadReady } from './page';
import { m } from '../paraglide/messages.js';
import type { DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor, PostComposer } from '../threads/composer';

const meta = { title: 'Pages/Post Editor', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const reply = () => <PageStory visitor="Signed In" path={pagePaths['thread']} />;
const newThread = () => <PageStory visitor="Signed In" path={pagePaths['board-new']} />;
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
    window.fetch = (input, init) => {
      const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (new URL(href, window.location.origin).pathname === `/media/${reusedImageId}/original`)
        return new Promise<Response>(() => {});
      return originalFetch.call(window, input, init);
    };
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
  play: longThreadPlay,
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

// Capture these same six states at the required 390px and 1280px screenshot widths.
export const ReplyEmpty390: Story = { name: 'Reply / Empty / 390', play: emptyReplyPlay, render: reply };
export const ReplyWithText390: Story = { name: 'Reply / With text / 390', play: textReplyPlay, render: reply };
export const ReplyWithImage390: Story = { name: 'Reply / With image / 390', play: imageReplyPlay, render: reply };
export const ReplyRefusal390: Story = { name: 'Reply / Refusal / 390', play: refusalPlay, render: reply };
export const NewThreadEmpty390: Story = { name: 'New thread / Empty / 390', play: newThreadReady, render: newThread };
export const NewThreadLong390: Story = { name: 'New thread / Long / 390', play: longThreadPlay, render: newThread };
export const ReplyPastedImageUploading390: Story = {
  name: 'Reply / Pasted image uploading again / 390',
  render: () => <ReuploadingReply />,
  play: pasteReuploadPlay,
};
export const ReplyImageUsed390: Story = {
  name: 'Reply / Image used in another post / 390',
  render: usedMedia,
  play: reusedMediaPlay,
};
