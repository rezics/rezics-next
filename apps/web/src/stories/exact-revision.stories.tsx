import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { expect, userEvent, within } from 'storybook/test';
import { ExactRevisionExample } from './exact-revision/example';
import { current, exactRevisionViewports, id, identity, ready, selected } from './exact-revision/fixture';
import * as pattern from './exact-revision/exact-revision.stories';
import { loadExactRevision } from '../threads/exact-revision';
import type { DocumentImagePresentation } from '../threads/document-media';
import { m } from '../paraglide/messages.js';
import recordedSubject from '../kernel/recorded/subject.json';

const meta = {
  title: 'Pages/Community/Exact revision',
  component: ExactRevisionExample,
  parameters: { layout: 'fullscreen', viewport: { options: exactRevisionViewports } },
  args: { initial: ready, shell: true },
} satisfies Meta<typeof ExactRevisionExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedRevision: Story = {
  ...pattern.SelectedRevision,
  play: async (context) => {
    await pattern.SelectedRevision.play?.(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText(m.discussion_provenance_details_subject_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.thread_provenance_heading() }));
    await userEvent.click(canvas.getByText(m.discussion_provenance_details_heading()));
    await expect(
      canvas.getByText(
        m.thread_provenance_vote({ units: '14', questionId: selected.voteCitation!.questionId, revision: '2' }),
      ),
    ).toBeVisible();
  },
};
export const LongDocument: Story = { ...pattern.LongDocument };
export const Unavailable: Story = {
  ...pattern.Unavailable,
  play: async (context) => {
    await pattern.Unavailable.play?.(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: m.exact_revision_heading() })).toBeVisible();
    await expect(canvas.queryByText('The original edition leaves room for the reader to pause.')).toBeNull();
  },
};
export const Loading: Story = { ...pattern.Loading };
export const NativeRetry: Story = { ...pattern.NativeRetry };
export const DifferentCurrentHead: Story = { ...pattern.DifferentCurrentHead };

const longSubjectId = `${id(70)}-unresolved-${'reference-'.repeat(10)}`;
const longQuestionId = `${id(71)}-question-${'citation-'.repeat(9)}`;
export const LongSourceReferences: Story = {
  args: {
    initial: {
      ...ready,
      revision: {
        ...selected,
        subjectIds: [longSubjectId],
        voteCitation: { ...selected.voteCitation!, questionId: longQuestionId, revision: 123456789 },
      },
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Constructed immutable revision example with long unresolved source IDs for the 390px and 1280px viewports; it is not native response or authorization evidence.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: m.exact_revision_heading() })).toBeVisible();
    await expect(canvas.getByText(m.discussion_provenance_details_subject_unavailable())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.thread_provenance_heading() }));
    await userEvent.click(canvas.getByText(m.discussion_provenance_details_heading()));
    await expect(canvas.getByText(m.thread_provenance_subject_reference({ id: longSubjectId }))).toBeVisible();
    await expect(canvas.getByText((text) => text.includes(longQuestionId))).toBeVisible();
  },
};

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
