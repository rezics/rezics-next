import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { ExactRevisionExample } from './exact-revision/example';
import { current, exactRevisionViewports, id, identity, ready, selected } from './exact-revision/fixture';
import * as pattern from './exact-revision/exact-revision.stories';
import { loadExactRevision } from '../threads/exact-revision';
import type { DocumentImagePresentation } from '../threads/document-media';
import recordedSubject from '../kernel/recorded/subject.json';

const meta = {
  title: 'Pages/Community/Exact revision',
  component: ExactRevisionExample,
  parameters: { layout: 'fullscreen', viewport: { options: exactRevisionViewports } },
  args: { initial: ready, shell: true },
} satisfies Meta<typeof ExactRevisionExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedRevision: Story = { ...pattern.SelectedRevision };
export const LongDocument: Story = { ...pattern.LongDocument };
export const Unavailable: Story = { ...pattern.Unavailable };
export const Loading: Story = { ...pattern.Loading };
export const NativeRetry: Story = { ...pattern.NativeRetry };
export const DifferentCurrentHead: Story = { ...pattern.DifferentCurrentHead };

export const DocumentMediaUnavailable: Story = {
  args: {
    initial: {
      ...ready,
      revision: {
        ...selected,
        mediaIds: [id(60)],
        body: {
          ...selected.body,
          doc: {
            ...selected.body.doc,
            content: [
              ...(selected.body.doc.content ?? []),
              { type: 'image', attrs: { id: 'edition-image', src: id(60), alt: 'A quiet reading room' } },
            ],
          },
        },
      },
    },
  },
};

// Constructed native responses reuse the existing derivative fixture; they establish no native authorization proof.
const cover = recordedSubject.summary.cover;
const image: DocumentImagePresentation = {
  id: cover.media,
  containerId: selected.threadId,
  digest: '0'.repeat(64),
  width: cover.width,
  height: cover.height,
  variants: [{ format: 'webp', width: cover.variants[0]!.width, height: cover.height }],
  placeholder: cover.placeholder,
  focalPoint: null,
  credit: { ...cover.credit, obligations: [] },
};
export const DocumentMediaAvailable: Story = {
  loaders: [
    async () => {
      const revision = {
        ...selected,
        mediaIds: [image.id, id(61)],
        body: {
          ...selected.body,
          doc: {
            ...selected.body.doc,
            content: [
              ...(selected.body.doc.content ?? []),
              {
                type: 'image',
                attrs: { id: 'available-image', src: image.id, alt: 'The Little Prince cover illustration' },
              },
              {
                type: 'image',
                attrs: { id: 'omitted-image', src: id(61), alt: 'An unavailable recorded illustration' },
              },
            ],
          },
        },
      };
      const client = createKernelClient('https://kernel.example', {
        fetch: Object.assign(
          async (input: RequestInfo | URL) => {
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            if (path === `/v1/posts/${identity.postId}/revisions/${identity.revisionId}`)
              return Response.json({ post: revision });
            if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
            if (path === '/v1/media/presentations') return Response.json({ images: [image] });
            if (path === '/v1/accounts') return Response.json({ accounts: [] });
            throw new Error(`Unexpected exact revision example read: ${path}`);
          },
          { preconnect() {} },
        ),
      });
      return { page: await loadExactRevision(client, identity) };
    },
  ],
  render: (args, { loaded }) => <ExactRevisionExample {...args} initial={loaded.page} />,
};
