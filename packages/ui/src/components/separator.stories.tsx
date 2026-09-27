import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Separator } from './separator.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-md bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Layout/Separator',
  component: Separator,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A hairline between groups of content: sections of a Work page, metadata in a byline, or groups of toolbar actions. It is a `separator` for assistive technology by default; pass `decorative` where the line only draws a boundary, such as between list items, so it is hidden instead. Prefer spacing alone when the groups are already distinct.',
      },
    },
  },
} satisfies Meta<typeof Separator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4 text-sm">
      <p>Ratings from Hard Science Fiction members</p>
      <Separator {...args} />
      <p>Source statistic: Goodreads average</p>
    </div>
  ),
  async play({ canvasElement }) {
    const separator = within(canvasElement).getByRole('separator');
    await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
  },
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-5 items-center gap-3 text-muted-foreground text-sm">
      <span>Ursula K. Le Guin</span>
      <Separator orientation="vertical" />
      <span>1974</span>
      <Separator orientation="vertical" />
      <span>387 pages</span>
    </div>
  ),
};

export const Decorative: Story = {
  args: { decorative: true },
  render: Horizontal.render,
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('separator')).not.toBeInTheDocument();
  },
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => (
    <div className="flex h-5 items-center gap-3 text-muted-foreground text-sm" lang="zh-CN">
      <span>《三体》</span>
      <Separator orientation="vertical" />
      <span>刘慈欣</span>
      <Separator orientation="vertical" />
      <span>重庆出版社</span>
    </div>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: () => (
    <div className="flex flex-col gap-4 text-sm">
      <p>Ratings from Hard Science Fiction members</p>
      <Separator />
      <div className="flex h-5 items-center gap-3 text-muted-foreground">
        <span>Ursula K. Le Guin</span>
        <Separator orientation="vertical" />
        <span>1974</span>
      </div>
    </div>
  ),
};
