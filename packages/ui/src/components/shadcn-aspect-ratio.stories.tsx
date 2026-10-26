import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AspectRatio } from '@rezics/ui/shadcn/aspect-ratio';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/AspectRatio',
  component: AspectRatio,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: { ratio: 2 / 3 },
} satisfies Meta<typeof AspectRatio>;
export default meta;
type Story = StoryObj<typeof meta>;

const cover = (title: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#1f3a5f"/><text x="100" y="150" fill="#fff" font-family="sans-serif" font-size="20" text-anchor="middle">${title}</text></svg>`,
  )}`;

const ratioOf = (element: HTMLElement) =>
  element.getBoundingClientRect().width / element.getBoundingClientRect().height;

export const Cover: Story = {
  render: (args) => (
    <div className="w-40">
      <AspectRatio {...args} className="overflow-hidden rounded-xl bg-muted">
        <img src={cover('Dune')} alt="Cover of Dune" className="size-full object-cover" />
      </AspectRatio>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Cover of Dune' })).toBeVisible();
    const box = canvasElement.querySelector<HTMLElement>('[data-slot="aspect-ratio"]')!;
    await expect(ratioOf(box)).toBeCloseTo(2 / 3, 2);
  },
};

export const Widescreen: Story = {
  args: { ratio: 16 / 9 },
  render: (args) => (
    <div className="w-80">
      <AspectRatio {...args} className="grid place-items-center rounded-xl bg-muted text-sm text-muted-foreground">
        <span>Trailer unavailable</span>
      </AspectRatio>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Trailer unavailable')).toBeVisible();
    const box = canvasElement.querySelector<HTMLElement>('[data-slot="aspect-ratio"]')!;
    await expect(ratioOf(box)).toBeCloseTo(16 / 9, 2);
  },
};

export const MissingImageWithCjkText: Story = {
  render: (args) => (
    <div className="w-40">
      <AspectRatio
        {...args}
        className="grid place-items-center overflow-hidden rounded-xl bg-muted p-2 text-center text-sm"
      >
        <span>封面尚未提供：三體 II 黑暗森林（日本語版）</span>
      </AspectRatio>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/封面尚未提供/)).toBeVisible();
  },
};
