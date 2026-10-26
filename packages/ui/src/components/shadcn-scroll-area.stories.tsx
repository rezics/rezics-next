import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { ScrollArea, ScrollBar } from '@rezics/ui/shadcn/scroll-area';
import { Separator } from '@rezics/ui/shadcn/separator';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/ScrollArea',
  component: ScrollArea,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof ScrollArea>;
export default meta;
type Story = StoryObj<typeof meta>;

const titles = [
  'The Three-Body Problem',
  '三体：黑暗森林',
  'Dune',
  '流浪地球',
  'Neuromancer',
  'The Left Hand of Darkness',
  '球状闪电与更多的长标题作品名称，用来检查换行',
  'Solaris',
  'Hyperion',
  'Foundation',
];

const Shelf = () => (
  <div className="p-4">
    <h4 className="mb-3 text-sm font-medium">Shelf</h4>
    {titles.map((title) => (
      <div key={title}>
        <div className="py-2 text-sm">{title}</div>
        <Separator />
      </div>
    ))}
  </div>
);

export const Vertical: Story = {
  render: () => (
    <ScrollArea className="h-56 w-72 rounded-2xl border" aria-label="Shelf">
      <Shelf />
    </ScrollArea>
  ),
  async play({ canvasElement }) {
    const viewport = canvasElement.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    await waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    viewport.scrollTop = 80;
    await waitFor(() => expect(viewport.scrollTop).toBe(80));
    await expect(within(canvasElement).getByText('Solaris')).toBeInTheDocument();
  },
};

export const Horizontal: Story = {
  render: () => (
    <ScrollArea className="w-72 rounded-2xl border whitespace-nowrap" aria-label="Covers">
      <div className="flex w-max gap-3 p-4 text-sm">
        {titles.map((title) => (
          <figure key={title} className="grid h-24 w-28 place-items-center rounded-xl bg-muted p-2 text-center">
            {title.slice(0, 12)}
          </figure>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
  async play({ canvasElement }) {
    const viewport = canvasElement.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    await waitFor(() => expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth));
    viewport.scrollLeft = 120;
    await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
  },
};

export const ShortContent: Story = {
  render: () => (
    <ScrollArea className="h-56 w-72 rounded-2xl border" aria-label="Short shelf">
      <p className="p-4 text-sm">暂无作品。No Works yet.</p>
    </ScrollArea>
  ),
  async play({ canvasElement }) {
    const viewport = canvasElement.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    await expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight);
  },
};
