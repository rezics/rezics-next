import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { CommandIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Kbd, KbdGroup } from './kbd.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Display/Kbd',
  component: Kbd,
  tags: ['autodocs'],
  decorators: [surface],
  args: { children: '/' },
  parameters: {
    docs: {
      description: {
        component:
          'A keyboard key in running text or next to a command: the `/` search shortcut in the top bar, `J`/`K` to move through a feed, or `Esc` to leave the reader. It renders `<kbd>`, which screen readers announce as text, so spell out modifiers a symbol alone would not convey (`aria-label` on the group or visible words). Use `KbdGroup` for a combination.',
      },
    },
  },
} satisfies Meta<typeof Kbd>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const key = within(canvasElement).getByText('/');
    await expect(key.tagName).toBe('KBD');
  },
};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Kbd>Esc</Kbd>
      <Kbd variant="outline">Esc</Kbd>
    </div>
  ),
};

export const Combination: Story = {
  render: () => (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-2">
        Open the command palette
        <KbdGroup aria-label="Command K" role="group">
          <Kbd>
            <CommandIcon aria-hidden />
          </Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </div>
      <div className="flex items-center gap-2">
        Rate the Work you are reading
        <KbdGroup>
          <Kbd>Shift</Kbd>
          <span className="text-muted-foreground">+</span>
          <Kbd>1</Kbd>
          <span className="text-muted-foreground">to</span>
          <Kbd>5</Kbd>
        </KbdGroup>
      </div>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('group', { name: 'Command K' })).toBeVisible();
  },
};

export const InText: Story = {
  name: 'In running text',
  render: () => (
    <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
      Press <Kbd>J</Kbd> and <Kbd>K</Kbd> to move through the Realm feed, <Kbd>R</Kbd> to reply and{' '}
      <Kbd>Esc</Kbd> to close the reader.
    </p>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN',
  render: () => (
    <p className="text-muted-foreground text-sm" lang="zh-CN">
      按 <Kbd>/</Kbd> 搜索作品，例如《三体》；按 <Kbd>Esc</Kbd> 退出阅读器。
    </p>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex items-center gap-3 text-sm">
      <Kbd>Esc</Kbd>
      <Kbd variant="outline">Esc</Kbd>
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
    </div>
  ),
};
