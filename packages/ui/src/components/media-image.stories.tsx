import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { brokenSrc, fixtureSrc, summary } from '../stories/media-fixtures.ts';
import { withSurface } from '../stories/support.tsx';
import { MediaImage } from './media-image.tsx';

const meta = {
  title: 'Components/Media image',
  component: MediaImage,
  tags: ['autodocs'],
  args: {
    ...summary('0192-media-figure', { width: 1200, height: 800 }),
    src: fixtureSrc,
    alt: 'A map of the Trisolaran system',
    sizes: '(min-width: 768px) 640px, 100vw',
  },
  parameters: {
    docs: {
      description: {
        component:
          'An image in a document or gallery that is not a subject cover. It takes the cover summary, reserves the image’s own ratio before any byte arrives, paints the stored placeholder colour while it loads, offers AVIF before WebP and sets `sizes` from a prop. A failed image becomes a quiet frame holding the alt text, never a broken-image icon.',
      },
    },
  },
  decorators: [withSurface],
} satisfies Meta<typeof MediaImage>;
export default meta;
type Story = StoryObj<typeof meta>;

const ratio = (element: Element) => {
  const { width, height } = element.getBoundingClientRect();
  return width / height;
};

export const Loaded: Story = {
  render: (args) => (
    <div className="max-w-xl">
      <MediaImage {...args} />
    </div>
  ),
  async play({ canvasElement, args }) {
    const picture = canvasElement.querySelector('picture')!;
    const types = [...picture.querySelectorAll('source')].map((source) => source.type);
    // The browser tries sources in document order, so AVIF has to come first.
    await expect(types).toEqual(['image/avif', 'image/webp']);
    const [avif] = picture.querySelectorAll('source');
    await expect(avif!.srcset.split(', ').map((entry) => entry.split(' ').at(-1))).toEqual(['320w', '640w', '960w']);
    await expect(avif!.sizes).toBe(args.sizes);
    const image = within(canvasElement).getByRole('img', { name: args.alt }) as HTMLImageElement;
    await waitFor(() => expect(image.complete && image.naturalWidth > 0).toBe(true));
    await expect(image.currentSrc.startsWith('data:image/avif')).toBe(true);
    await expect(canvasElement.querySelector('[data-state="unavailable"]')).toBeNull();
  },
};

export const ReservesSize: Story = {
  render: (args) => (
    <div className="max-w-xl">
      <div className="h-[3000px]" aria-hidden="true" />
      <MediaImage {...args} />
    </div>
  ),
  async play({ canvasElement }) {
    // Far below the viewport the image is lazy: the frame already holds its place and colour.
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="media-image"]')!;
    const image = frame.querySelector('img')!;
    await expect(image.loading).toBe('lazy');
    await expect(ratio(frame)).toBeCloseTo(1200 / 800, 2);
    await expect(frame.getBoundingClientRect().height).toBeGreaterThan(100);
    await expect(getComputedStyle(frame).backgroundColor).toBe('rgb(90, 70, 50)');
    await expect(image.getAttribute('width')).toBe('1200');
    await expect(image.getAttribute('height')).toBe('800');
    await expect(frame.querySelector('[data-slot="media-image-fallback"]')).toBeNull();
  },
};

export const BrokenImage: Story = {
  args: { src: brokenSrc },
  render: (args) => (
    <div className="max-w-xl">
      <MediaImage {...args} />
    </div>
  ),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    // The image fails to decode, so no <img> may stay for the browser to draw its broken-image icon.
    await waitFor(() => expect(canvasElement.querySelector('[data-state="unavailable"]')).not.toBeNull());
    const frame = canvas.getByRole('img', { name: args.alt });
    await expect(canvasElement.querySelector('img')).toBeNull();
    await expect(frame).toHaveTextContent(args.alt);
    await expect(ratio(canvasElement.querySelector('[data-slot="media-image"]')!)).toBeCloseTo(1200 / 800, 2);
  },
};

export const MissingData: Story = {
  args: { variants: [], placeholder: null, alt: '' },
  render: (args) => (
    <div className="max-w-xs">
      <MediaImage {...args} />
    </div>
  ),
  async play({ canvasElement }) {
    // A summary with no variants and no colour still reserves its frame and draws no image element.
    const frame = canvasElement.querySelector<HTMLElement>('[data-slot="media-image"]')!;
    await expect(frame.dataset.state).toBe('unavailable');
    await expect(frame.querySelector('img, picture')).toBeNull();
    await expect(ratio(frame)).toBeCloseTo(1200 / 800, 2);
    await expect(frame.textContent).toBe('');
  },
};

export const LongCjkAlt: Story = {
  args: {
    src: brokenSrc,
    width: 600,
    height: 400,
    alt: '《三体》第二部《黑暗森林》中罗辑面壁计划的示意图，包含恒星、行星与宇宙社会学公理的推演过程以及各个文明之间的猜疑链',
  },
  render: (args) => (
    <div className="w-60">
      <MediaImage {...args} />
    </div>
  ),
  async play({ canvasElement, args }) {
    await waitFor(() => expect(canvasElement.querySelector('[data-state="unavailable"]')).not.toBeNull());
    const frame = within(canvasElement).getByRole('img', { name: args.alt });
    // The alt text clamps inside the frame instead of growing it or running past its edge.
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    await expect(frame.scrollHeight).toBeLessThanOrEqual(frame.clientHeight);
  },
};

export const FixedFrame: Story = {
  render: (args) => (
    <ul className="grid max-w-xl grid-cols-3 gap-3">
      {[
        { width: 1200, height: 800 },
        { width: 600, height: 1200 },
        { width: 900, height: 900 },
      ].map((size) => (
        <li key={size.width}>
          <MediaImage {...args} {...size} frame={1} alt={`Figure ${size.width}`} />
        </li>
      ))}
    </ul>
  ),
  async play({ canvasElement }) {
    // Tiles of different shapes share one frame, so a gallery row stays aligned.
    const frames = [...canvasElement.querySelectorAll('[data-slot="media-image"]')];
    await expect(frames).toHaveLength(3);
    for (const frame of frames) await expect(ratio(frame)).toBeCloseTo(1, 2);
  },
};
