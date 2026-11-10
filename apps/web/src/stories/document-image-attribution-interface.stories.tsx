import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { DocumentImagePresentation } from '../threads/document-media';
import { NativeDocumentImage } from '../threads/document-media-image';

const alt = `A charcoal field drawing of a mountain village, with a river crossing the foreground and a small bridge beside the old stone mill. ${'The artist marks the evening light across the rooftops. '.repeat(5)}`;
const viaName = `The Regional Archive Collection ${'Conservation and Image Records '.repeat(4)}`;
const viaUrl = 'https://images.example.test/collections/river-village';
const rightsHolder = `Mira Chen and the Regional Archive ${'Image Preservation Contributors '.repeat(3)}`;

const image: DocumentImagePresentation = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000041',
  containerId: '0192f3a0-6c1e-7b2a-9d4e-000000000042',
  digest: 'a'.repeat(64),
  width: 960,
  height: 640,
  variants: [
    { format: 'avif', width: 960, height: 640 },
    { format: 'webp', width: 480, height: 320 },
  ],
  placeholder: null,
  focalPoint: null,
  credit: {
    rightsHolder,
    via: { name: viaName, url: viaUrl },
    license: 'CC-BY-4.0',
    obligations: ['cc:Attribution'],
  },
};

const meta = {
  title: 'Content/Document image attribution',
  id: 'interfaces-content-document-image-attribution',
  component: NativeDocumentImage,
  args: { image, alt, locale: 'en' },
} satisfies Meta<typeof NativeDocumentImage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AvailableCredit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const source = canvas.getByRole('link', { name: viaName });
    await userEvent.tab();
    await expect(document.activeElement).toBe(source);
    await expect(source).toHaveAttribute('href', viaUrl);
    await expect(canvas.getByRole('img', { name: alt })).toBeVisible();
    await expect(canvas.getByText(rightsHolder, { exact: false })).toBeVisible();
    await expect(canvas.getByText('CC-BY-4.0')).toBeVisible();
  },
};

export const UnavailableCredit: Story = {
  args: { image: null, alt, locale: 'en' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: `Image unavailable: ${alt}` })).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
