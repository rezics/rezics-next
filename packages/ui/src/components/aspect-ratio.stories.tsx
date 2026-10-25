import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { cn } from '../utils.ts';
import { AspectRatio } from './aspect-ratio.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

// Inline cover and banner so stories never depend on the network.
const cover = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="#1f4a85"/><circle cx="100" cy="120" r="46" fill="#bf7a0e"/><rect x="30" y="220" width="140" height="10" fill="#e4ecf7"/><rect x="50" y="240" width="100" height="6" fill="#e4ecf7"/></svg>',
)}`;
const banner = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 400"><rect width="1600" height="400" fill="#2b343d"/><circle cx="1200" cy="200" r="140" fill="#2f63ad"/><circle cx="1320" cy="140" r="60" fill="#e4ecf7"/></svg>',
)}`;

const meta = {
  title: 'Rezics UI/Layout/Aspect Ratio',
  component: AspectRatio,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'Keeps media at a fixed width-to-height ratio while the width follows its container, so covers and banners reserve their space before the image loads. Use `ratio={2 / 3}` for Work covers (with `rounded-sm`, the cover radius), `4 / 1` for Realm banners and `16 / 9` for embedded trailers. Content is clipped to the box; fill it with an `object-cover` image.',
      },
    },
  },
} satisfies Meta<typeof AspectRatio>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkCover: Story = {
  args: { ratio: 2 / 3, className: 'w-40 rounded-sm bg-muted' },
  render: (args) => (
    <AspectRatio {...args}>
      <img alt="Cover of The Dispossessed" className="size-full object-cover" src={cover} />
    </AspectRatio>
  ),
  async play({ canvasElement }) {
    const box = canvasElement.querySelector<HTMLElement>('[data-slot="aspect-ratio"]');
    const { width, height } = box?.getBoundingClientRect() ?? { width: 0, height: 0 };
    await expect(Math.round((width / height) * 100)).toBe(67);
  },
};

export const RealmBanner: Story = {
  args: { ratio: 4 / 1, className: 'max-w-2xl rounded-2xl bg-muted' },
  render: (args) => (
    <AspectRatio {...args}>
      <img alt="Hard Science Fiction banner" className="size-full object-cover" src={banner} />
    </AspectRatio>
  ),
};

export const Placeholder: Story = {
  name: 'Placeholder (no cover yet)',
  args: { ratio: 2 / 3, className: 'w-40 rounded-sm border border-border/60 bg-secondary' },
  render: (args) => (
    <AspectRatio {...args}>
      <div className="flex size-full items-center justify-center p-3 text-center font-heading text-muted-foreground text-sm">
        A Memory Called Empire
      </div>
    </AspectRatio>
  ),
};

export const Ratios: Story = {
  render: () => (
    <div className="flex items-start gap-4">
      {(
        [
          ['1 / 1', 1],
          ['2 / 3', 2 / 3],
          ['16 / 9', 16 / 9],
        ] as const
      ).map(([label, ratio]) => (
        <AspectRatio className="w-40 rounded-xl bg-accent" key={label} ratio={ratio}>
          <div className="flex size-full items-center justify-center text-accent-foreground text-sm">
            {label}
          </div>
        </AspectRatio>
      ))}
    </div>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN placeholder',
  args: { ratio: 2 / 3, className: 'w-40 rounded-sm border border-border/60 bg-secondary' },
  render: (args) => (
    <AspectRatio lang="zh-CN" {...args}>
      <div className="flex size-full flex-col items-center justify-center gap-1 p-3 text-center text-muted-foreground">
        <span className="font-heading text-base">《三体》</span>
        <span className="text-xs">刘慈欣</span>
      </div>
    </AspectRatio>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex items-start gap-4">
      <AspectRatio className="w-32 rounded-sm bg-muted" ratio={2 / 3}>
        <img alt="Cover of The Dispossessed" className="size-full object-cover" src={cover} />
      </AspectRatio>
      <AspectRatio className="w-32 rounded-sm border border-border/60 bg-secondary" ratio={2 / 3}>
        <div className="flex size-full items-center justify-center p-3 text-center font-heading text-muted-foreground text-sm">
          A Memory Called Empire
        </div>
      </AspectRatio>
    </div>
  ),
};
