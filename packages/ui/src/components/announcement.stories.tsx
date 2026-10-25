import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { ArrowRightIcon, SparklesIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Announcement, AnnouncementTitle } from './announcement.tsx';
import { Badge } from './badge.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Announcement',
  component: Announcement,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A compact pill for one piece of news above a page heading, such as a new Rezics feature, a Realm event or a reading challenge. It is a polite `status` region by default; render it as a link (`asChild` with `<a>`) when it leads somewhere. Pair it with a Badge for the category. Use Alert for messages about the current content instead.',
      },
    },
  },
} satisfies Meta<typeof Announcement>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Announcement {...args}>
      <AnnouncementTitle>Shelves can now be shared with a Realm</AnnouncementTitle>
    </Announcement>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Shelves can now be shared');
  },
};

export const WithBadge: Story = {
  render: () => (
    <Announcement>
      <Badge variant="secondary">New</Badge>
      <AnnouncementTitle>Reading challenges for 2027</AnnouncementTitle>
    </Announcement>
  ),
};

export const AsLink: Story = {
  render: () => (
    <Announcement asChild>
      <a href="#realm-event">
        <Badge>Event</Badge>
        <AnnouncementTitle>
          Hard SF Realm: Hugo shortlist read-along
          <ArrowRightIcon aria-hidden />
        </AnnouncementTitle>
      </a>
    </Announcement>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: /Hugo shortlist read-along/ });
    await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};

export const WithIcon: Story = {
  render: () => (
    <Announcement>
      <SparklesIcon aria-hidden />
      <AnnouncementTitle>Rezics now imports ratings from Douban</AnnouncementTitle>
    </Announcement>
  ),
};

export const Chinese: Story = {
  name: 'zh-CN and long content',
  render: () => (
    <div className="flex max-w-sm flex-col gap-3" lang="zh-CN">
      <Announcement>
        <Badge variant="secondary">新功能</Badge>
        <AnnouncementTitle>《三体》读书会本周六开始</AnnouncementTitle>
      </Announcement>
      <Announcement>
        <Badge variant="secondary">Realm</Badge>
        <AnnouncementTitle>
          硬科幻 Realm 的 Hugo Award 2026 shortlist 共读活动现已开放报名，名额有限
        </AnnouncementTitle>
      </Announcement>
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <Announcement>
        <Badge variant="secondary">New</Badge>
        <AnnouncementTitle>Reading challenges for 2027</AnnouncementTitle>
      </Announcement>
      <Announcement asChild>
        <a href="#realm-event">
          <Badge>Event</Badge>
          <AnnouncementTitle>
            Hugo shortlist read-along
            <ArrowRightIcon aria-hidden />
          </AnnouncementTitle>
        </a>
      </Announcement>
    </div>
  ),
};
