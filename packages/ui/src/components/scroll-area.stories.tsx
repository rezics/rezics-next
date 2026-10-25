import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { cn } from '../utils.ts';
import { ScrollArea } from './scroll-area.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const chapters = [
  'A Remembrance of Earth’s Past',
  'Silent Spring',
  'Red Coast',
  'Three Body: King Wen of Zhou and the Long Night',
  'Ye Wenjie',
  'Three Body: Mozi and Fiery Flames',
  'The Madman',
  'Three Body: Copernicus, Universal Football, and Tri-Solar Day',
  'The Frenzied Gods',
  'Three Body: Newton, Von Neumann, the First Emperor, and Tri-Solar Syzygy',
  'The Shooter and the Farmer',
  'Lei Zhicheng, Yang Weining',
  'Three Body: Einstein, the Pendulum, and the Great Rip',
  'Rebels of Earth',
];

const meta = {
  title: 'Rezics UI/Layout/Scroll Area',
  component: ScrollArea,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A scroll container with thin overlay scrollbars that appear on hover and while scrolling: a chapter list in the reader, a long member list in a popover, or a horizontal row of covers. The viewport joins the tab order whenever it overflows so keyboard users can scroll it, and shows the focus ring. Set a height (or max height) on the root; use `scrollFade` to fade edges that have more content.',
      },
    },
  },
} satisfies Meta<typeof ScrollArea>;
export default meta;
type Story = StoryObj<typeof meta>;

const ChapterList = () => (
  <ol className="flex flex-col gap-1 p-4 text-sm">
    {chapters.map((title, index) => (
      <li className="flex gap-3" key={title}>
        <span className="w-5 text-right text-muted-foreground tabular-nums">{index + 1}</span>
        {title}
      </li>
    ))}
  </ol>
);

export const Vertical: Story = {
  args: { className: 'h-64 w-80 rounded-2xl border border-border/60 bg-card' },
  render: (args) => (
    <ScrollArea aria-label="Chapters of The Three-Body Problem" {...args}>
      <ChapterList />
    </ScrollArea>
  ),
  async play({ canvasElement }) {
    const viewport = canvasElement.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    await waitFor(() => expect(viewport).toHaveAttribute('tabindex', '0'));
    await userEvent.tab();
    await expect(viewport).toHaveFocus();
  },
};

export const ScrollFade: Story = {
  args: { scrollFade: true, className: 'h-64 w-80 rounded-2xl border border-border/60 bg-card' },
  render: Vertical.render,
};

const covers = [
  '#2f63ad',
  '#1d8a7a',
  '#bf7a0e',
  '#6a5bb5',
  '#1f4a85',
  '#c42840',
  '#2c7a33',
  '#8a5a00',
];

export const Horizontal: Story = {
  render: () => (
    <ScrollArea className="w-96 rounded-2xl border border-border/60 bg-card">
      <ul aria-label="Recently read" className="flex w-max gap-3 p-4">
        {covers.map((color, index) => (
          <li className="flex w-20 flex-col gap-2 text-xs" key={color}>
            <div className="aspect-2/3 rounded-sm" style={{ background: color }} />
            Work {index + 1}
          </li>
        ))}
      </ul>
    </ScrollArea>
  ),
};

export const NoOverflow: Story = {
  args: { className: 'h-64 w-80 rounded-2xl border border-border/60 bg-card' },
  render: (args) => (
    <ScrollArea {...args}>
      <p className="p-4 text-sm">Only one chapter so far.</p>
    </ScrollArea>
  ),
  async play({ canvasElement }) {
    const viewport = canvasElement.querySelector('[data-slot="scroll-area-viewport"]');
    await waitFor(() => expect(viewport).not.toHaveAttribute('tabindex'));
  },
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => (
    <ScrollArea className="h-48 w-72 rounded-2xl border border-border/60 bg-card" lang="zh-CN">
      <ol className="flex flex-col gap-1 p-4 text-sm">
        {[
          '科学边界',
          '台球',
          '射手和农场主',
          '三体、周文王、长夜',
          '叶文洁',
          '宇宙闪烁',
          '红岸之一',
          '红岸之二',
          '三体、墨子、烈焰',
          '古筝行动',
          '尾声',
        ].map((title, index) => (
          <li key={title}>
            {index + 1}. {title}
          </li>
        ))}
      </ol>
    </ScrollArea>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  args: { className: 'h-64 w-80 rounded-2xl border border-border/60 bg-card' },
  render: Vertical.render,
};
