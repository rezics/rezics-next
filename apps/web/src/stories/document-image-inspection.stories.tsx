import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { DocumentImagePresentation } from '../threads/document-media';
import type { ThreadDocumentMedia } from '../threads/document-media-read';
import { selectDocumentImageInspectionVariant } from '../threads/document-image-inspection';
import { ThreadPostReadingBody } from '../threads/post-reading-body';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { preparedPostReading } from './post-reading-fixtures';
import { PatternStory } from './page';

function preparedVisit(failure: boolean) {
  const prepared = preparedPostReading(5);
  const imageId = failure ? '00000000-0000-0000-0000-000000000001' : prepared.image.id;
  const image: DocumentImagePresentation = { ...prepared.image, id: imageId };
  const post = {
    ...prepared.post,
    mediaIds: [imageId],
    body: {
      ...prepared.post.body,
      doc: {
        ...prepared.post.body.doc,
        content: prepared.post.body.doc.content!.map((node) =>
          node.type === 'image' ? { ...node, attrs: { ...node.attrs, src: imageId } } : node,
        ),
      },
    },
  };
  const supplied = prepared.page.documentMedia as Extract<ThreadDocumentMedia, { kind: 'ready' }>;
  const documentMedia: ThreadDocumentMedia = {
    ...supplied,
    images: [image],
    documents: supplied.documents.map((document) => ({ ...document, mediaIds: [imageId] })),
  };
  return { post, documentMedia, image };
}

function InspectionReader({ failure = false }: { failure?: boolean }) {
  const locale = getLocale();
  const visit = useMemo(() => preparedVisit(failure), [failure]);
  return (
    <PatternStory visitor="Signed Out" path="/en/threads/prepared-image-inspection">
      <main className="mx-auto w-full max-w-4xl min-w-0 space-y-4 px-4 py-8 text-foreground">
        <h1 className="text-2xl font-semibold">Field notes / 観測記録</h1>
        <p className="max-w-prose text-muted-foreground">
          Inspect the illustration and return to the same prepared post. The reader retains its existing retry control
          if the admitted derivative is unavailable.
        </p>
        <ThreadPostReadingBody post={visit.post} documentMedia={visit.documentMedia} mentions={{}} locale={locale} />
      </main>
    </PatternStory>
  );
}

const meta = {
  title: 'Community/Document image inspection',
  id: 'pages-community-document-image-inspection',
  component: InspectionReader,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      viewports: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  render: (args) => <InspectionReader {...args} />,
} satisfies Meta<typeof InspectionReader>;
export default meta;
type Story = StoryObj<typeof meta>;

async function inspectAndReturn({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const { image } = preparedVisit(false);
  const trigger = await canvas.findByRole('button', { name: m.document_image_inspect() });
  await userEvent.click(trigger);
  const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog');
  await expect(dialog.querySelector('[data-slot="document-image-inspection-stage"] img')).not.toBeNull();
  const delivered = selectDocumentImageInspectionVariant(image)!;
  await expect(dialog).toHaveTextContent(
    m.document_image_inspection_size({ width: delivered.width, height: delivered.height }),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: m.document_image_inspection_actual() }));
  await expect(dialog.querySelector('[data-slot="document-image-inspection-stage"]')).toHaveAttribute(
    'data-scale',
    'actual',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: m.document_image_inspection_close() }));
  await expect(canvas.getByRole('button', { name: m.document_image_inspect() })).toBeVisible();
}

async function unavailableImage({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const { image } = preparedVisit(true);
  await expect(canvas.getByRole('button', { name: m.document_image_retry() })).toBeVisible();
  await expect(canvas.queryByRole('button', { name: m.document_image_inspect() })).toBeNull();
  await expect(canvas.queryByText(image.credit!.rightsHolder)).toBeNull();
}

export const PhoneLight: Story = { name: 'Default', globals: {}, play: inspectAndReturn };
export const PhoneDark: Story = { tags: ['!dev'], globals: {}, play: inspectAndReturn };
export const DesktopLight: Story = { tags: ['!dev'], globals: {}, play: inspectAndReturn };
export const DesktopDark: Story = { tags: ['!dev'], globals: {}, play: inspectAndReturn };
export const PhoneFailureLight: Story = {
  name: 'Failure',
  args: { failure: true },
  globals: {},
  play: unavailableImage,
};
export const PhoneFailureDark: Story = { tags: ['!dev'], args: { failure: true }, globals: {}, play: unavailableImage };
export const DesktopFailureLight: Story = {
  tags: ['!dev'],
  args: { failure: true },
  globals: {},
  play: unavailableImage,
};
export const DesktopFailureDark: Story = {
  tags: ['!dev'],
  args: { failure: true },
  globals: {},
  play: unavailableImage,
};
