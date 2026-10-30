import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { DocumentSnapshot } from '@rezics/document';
import { InlinePostEditor } from '../threads/composer';
import { m } from '../paraglide/messages.js';

const processingId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const unusableId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const initialBody: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'reply-text' }, content: [{ type: 'text', text: 'Keep this reply draft.' }] },
      { type: 'image', attrs: { id: 'processing-image', src: processingId, alt: 'Processing image' } },
      { type: 'image', attrs: { id: 'unusable-image', src: unusableId, alt: 'Unusable image' } },
    ],
  },
};

const meta = { title: 'Pages/Community/Thread', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReplyMediaUnavailable: Story = {
  name: 'Reply draft with unavailable images',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_edit_save() }));
    await waitFor(async () => expect(await canvas.findByText(m.thread_media_processing())).toBeVisible());
    await canvas.findByText(m.thread_media_unusable());
  },
  render: () => (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <InlinePostEditor
        initialBody={initialBody}
        revisionId="revision-1"
        idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000003"
        containerId="thread-1"
        onSubmit={async () => ({
          ok: false,
          reason: 'media-unavailable',
          media: [
            { id: processingId, state: 'uploaded' },
            { id: unusableId, state: 'rejected' },
          ],
        })}
        onCancel={() => undefined}
        onSuccess={() => undefined}
      />
    </main>
  ),
};
