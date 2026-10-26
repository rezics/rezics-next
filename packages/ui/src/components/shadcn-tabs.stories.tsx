import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/shadcn/tabs';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  decorators: [withSurface],
  render: (args) => (
    <Tabs defaultValue="overview" className="max-w-md" {...args}>
      <TabsList aria-label="Work sections">
        <TabsTrigger className={quiet} value="overview">
          Overview
        </TabsTrigger>
        <TabsTrigger className={quiet} value="reviews">
          Reviews
        </TabsTrigger>
        <TabsTrigger className={quiet} value="editions" disabled>
          Editions
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview">A hard science fiction novel about first contact.</TabsContent>
      <TabsContent value="reviews">三体：一部关于文明与生存的长篇评论。</TabsContent>
      <TabsContent value="editions">Hidden while disabled.</TabsContent>
    </Tabs>
  ),
} satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

// The Rhea inactive tab color (foreground at 60%) is 3.5:1 on the muted tab list in the light theme; this token pair clears 4.5:1.
const quiet = 'text-muted-foreground';

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByRole('tabpanel')).toHaveTextContent('first contact');
    await userEvent.click(canvas.getByRole('tab', { name: 'Reviews' }));
    await expect(canvas.getByRole('tab', { name: 'Reviews' })).toHaveAttribute('aria-selected', 'true');
    await expect(await canvas.findByRole('tabpanel')).toHaveTextContent('三体');
  },
};

export const Keyboard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    canvas.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('tab', { name: 'Reviews' })).toHaveFocus();
    await expect(canvas.getByRole('tab', { name: 'Editions' })).toHaveAttribute('aria-disabled', 'true');
  },
};

export const Line: Story = {
  render: () => (
    <Tabs defaultValue="works">
      <TabsList variant="line" aria-label="Profile sections">
        <TabsTrigger className={quiet} value="works">
          Works
        </TabsTrigger>
        <TabsTrigger className={quiet} value="people">
          People
        </TabsTrigger>
      </TabsList>
      <TabsContent value="works">Works list</TabsContent>
      <TabsContent value="people">People list</TabsContent>
    </Tabs>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: 'People' }));
    await expect(await canvas.findByRole('tabpanel')).toHaveTextContent('People list');
  },
};

export const LongCJKLabels: Story = {
  render: () => (
    <Tabs defaultValue="a" className="max-w-xs">
      <TabsList aria-label="分区" className="h-auto! w-full flex-wrap">
        <TabsTrigger className={`${quiet} h-auto whitespace-normal py-1`} value="a">
          作品的完整长标题与别名
        </TabsTrigger>
        <TabsTrigger className={`${quiet} h-auto whitespace-normal py-1`} value="b">
          相关人物与评论
        </TabsTrigger>
      </TabsList>
      <TabsContent value="a">内容 A</TabsContent>
      <TabsContent value="b">内容 B</TabsContent>
    </Tabs>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('tab', { name: /相关人物/ }));
    await expect(await within(canvasElement).findByRole('tabpanel')).toHaveTextContent('内容 B');
  },
};
