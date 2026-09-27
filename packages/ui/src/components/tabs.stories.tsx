import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookOpenIcon, LibraryIcon, MessagesSquareIcon, StarIcon } from 'lucide-react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.tsx';

const meta = {
  title: 'Rezics UI/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  decorators: [withSurface],
  args: { defaultValue: 'overview', onValueChange: fn() },
} satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

const WorkTabs = (
  props: React.ComponentProps<typeof Tabs> & { variant?: 'default' | 'underline' },
) => {
  const { variant, ...rest } = props;

  return (
    <Tabs {...rest}>
      <TabsList aria-label="The Three-Body Problem" variant={variant}>
        <TabsTrigger value="overview">
          <BookOpenIcon aria-hidden />
          Overview
        </TabsTrigger>
        <TabsTrigger value="editions">
          <LibraryIcon aria-hidden />
          Editions (12)
        </TabsTrigger>
        <TabsTrigger value="reviews">
          <StarIcon aria-hidden />
          Reviews (1,284)
        </TabsTrigger>
        <TabsTrigger disabled value="discussions">
          <MessagesSquareIcon aria-hidden />
          Discussions
        </TabsTrigger>
      </TabsList>
      <TabsContent className="max-w-prose pt-2 text-sm" value="overview">
        Liu Cixin’s first-contact novel, begun during the Cultural Revolution and ending in the
        Trisolaran crisis. Hard SF readers rate it 4.3 from 1,284 ratings.
      </TabsContent>
      <TabsContent className="pt-2 text-sm" value="editions">
        12 editions in 6 languages, from the 2008 Chongqing Publishing Group original to the 2014
        Tor translation by Ken Liu.
      </TabsContent>
      <TabsContent className="pt-2 text-sm" value="reviews">
        Most helpful: “A slow first third that pays off enormously.” — @ye_wenjie
      </TabsContent>
      <TabsContent className="pt-2 text-sm" value="discussions">
        Discussions open once the Work has ten ratings.
      </TabsContent>
    </Tabs>
  );
};

export const Default: Story = {
  render: (args) => <WorkTabs {...args} />,
  async play({ args, canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(canvas.getByRole('tab', { name: /Reviews/ }));
    await expect(canvas.getByRole('tabpanel', { name: /Reviews/ })).toHaveTextContent(
      /Most helpful/,
    );
    await expect(args.onValueChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'reviews' }),
    );
  },
};

export const KeyboardNavigation: Story = {
  render: (args) => <WorkTabs {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('tab', { name: /Overview/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    // Zag moves focus on the next frame.
    await waitFor(() => expect(canvas.getByRole('tab', { name: /Editions/ })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('tab', { name: /Editions/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const Underline: Story = {
  render: (args) => <WorkTabs {...args} variant="underline" />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('tab', { name: /Editions/ }));
    await expect(
      within(canvasElement).getByRole('tabpanel', { name: /Editions/ }),
    ).toHaveTextContent(/12 editions/);
  },
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => <WorkTabs {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /Overview/ }));
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(canvas.getByRole('tab', { name: /Editions/ })).toHaveFocus());
  },
};

export const Chinese: Story = {
  args: { defaultValue: 'hot' },
  render: (args) => (
    <Tabs {...args}>
      <TabsList aria-label="「科幻」Realm 帖子">
        <TabsTrigger value="hot">热门</TabsTrigger>
        <TabsTrigger value="new">最新</TabsTrigger>
        <TabsTrigger value="top">本周最佳</TabsTrigger>
      </TabsList>
      <TabsContent className="pt-2 text-sm" value="hot">
        《三体》读书会第 3 周：你怎么看“黑暗森林”法则？
      </TabsContent>
      <TabsContent className="pt-2 text-sm" value="new">
        新帖：Ken Liu 译本与原文第 12 章对照。
      </TabsContent>
      <TabsContent className="pt-2 text-sm" value="top">
        本周最佳：重读《球状闪电》的十个理由。
      </TabsContent>
    </Tabs>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('tab', { name: '最新' }));
    await expect(within(canvasElement).getByRole('tabpanel', { name: '最新' })).toHaveTextContent(
      'Ken Liu',
    );
  },
};

export const Dark: Story = {
  ...Default,
  globals: { theme: 'dark' },
};

export const DarkUnderline: Story = {
  ...Underline,
  globals: { theme: 'dark' },
};
