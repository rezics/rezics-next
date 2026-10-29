import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DecisionPage } from '../moderation/decision-read';
import { DecisionPageView } from '../moderation/decision-page';

const meta = {
  title: 'Pages/Moderation decision',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      viewports: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
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

function makeStory(
  state: 'open' | 'pending' | 'expired',
  locale: 'en' | 'zh-Hans',
  viewport: 'phone390' | 'desktop1280',
) {
  return {
    name: `${state} appeal · ${locale} · ${viewport}`,
    globals: { locale },
    parameters: { viewport: { defaultViewport: viewport } },
    render: () => story(state),
  } satisfies Story;
}

export const OpenEnglishPhone: Story = makeStory('open', 'en', 'phone390');
export const OpenEnglishDesktop: Story = makeStory('open', 'en', 'desktop1280');
export const OpenChinesePhone: Story = makeStory('open', 'zh-Hans', 'phone390');
export const OpenChineseDesktop: Story = makeStory('open', 'zh-Hans', 'desktop1280');
export const PendingEnglishPhone: Story = makeStory('pending', 'en', 'phone390');
export const PendingEnglishDesktop: Story = makeStory('pending', 'en', 'desktop1280');
export const PendingChinesePhone: Story = makeStory('pending', 'zh-Hans', 'phone390');
export const PendingChineseDesktop: Story = makeStory('pending', 'zh-Hans', 'desktop1280');
export const ExpiredEnglishPhone: Story = makeStory('expired', 'en', 'phone390');
export const ExpiredEnglishDesktop: Story = makeStory('expired', 'en', 'desktop1280');
export const ExpiredChinesePhone: Story = makeStory('expired', 'zh-Hans', 'phone390');
export const ExpiredChineseDesktop: Story = makeStory('expired', 'zh-Hans', 'desktop1280');
