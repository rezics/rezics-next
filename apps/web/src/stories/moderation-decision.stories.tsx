import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DecisionPage } from '../moderation/decision-read';
import { DecisionPageView } from '../moderation/decision-page';

const meta = {
  title: 'Pages/Community/Moderation decision',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const decidedAt = '2026-10-01T09:30:00.000Z';
const deadline = '2027-04-02T09:30:00.000Z';
const now = Date.parse('2026-10-29T10:00:00.000Z');

function page(state: 'open' | 'pending' | 'expired'): DecisionPage {
  return {
    viewerId: 'author-1',
    decision: {
      id: 'decision-1',
      targetKind: 'post',
      targetId: 'post-1',
      action: 'takedown',
      statement:
        'This post was withheld because it included personal information about another person without their consent. The decision applies to the post and its attached replies.',
      decidedAt,
      appealDeadline: state === 'expired' ? '2026-10-28T09:30:00.000Z' : deadline,
      appeal:
        state === 'pending'
          ? { id: 'appeal-1', outcome: null, statement: 'The post does not identify another person.', resolvedAt: null }
          : null,
    },
    target: {
      id: 'post-1',
      authorId: 'author-1',
      threadId: 'thread-1',
      createdAt: decidedAt,
      text: 'A post with a decision attached',
      href: '/threads/thread-1#post-1',
    },
  };
}

function story(state: 'open' | 'pending' | 'expired') {
  return <DecisionPageView page={page(state)} now={now} />;
}

function makeStory(state: 'open' | 'pending' | 'expired', locale: 'en' | 'zh-Hans' = 'en', regression = false) {
  return {
    ...(regression ? { tags: ['!dev'] } : {}),
    ...(locale !== 'en' ? { globals: { locale } } : {}),
    render: () => story(state),
  } satisfies Story;
}

export const Open: Story = { name: 'Appeal open', ...makeStory('open') };
export const Pending: Story = { name: 'Appeal pending', ...makeStory('pending') };
export const Expired: Story = { name: 'Appeal expired', ...makeStory('expired') };
export const OpenChinese: Story = {
  name: 'Appeal open',
  tags: ['!dev'],
  ...makeStory('open', 'zh-Hans', true),
};
export const OpenDesktopRegression: Story = {
  name: 'Appeal open',
  tags: ['!dev'],
  ...makeStory('open', 'en', true),
};
export const PendingChinese: Story = {
  name: 'Appeal pending',
  tags: ['!dev'],
  ...makeStory('pending', 'zh-Hans', true),
};
export const PendingDesktopRegression: Story = {
  name: 'Appeal pending',
  tags: ['!dev'],
  ...makeStory('pending', 'en', true),
};
export const ExpiredChinese: Story = {
  name: 'Appeal expired',
  tags: ['!dev'],
  ...makeStory('expired', 'zh-Hans', true),
};
export const ExpiredDesktopRegression: Story = {
  name: 'Appeal expired',
  tags: ['!dev'],
  ...makeStory('expired', 'en', true),
};
