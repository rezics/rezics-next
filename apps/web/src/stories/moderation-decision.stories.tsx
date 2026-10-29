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

const viewports = ['phone390', 'desktop1280'] as const;
const locales = ['en', 'zh-Hans'] as const;
function variants(state: 'open' | 'pending' | 'expired') {
  return Object.fromEntries(
    locales.flatMap((locale) =>
      viewports.map((viewport) => [
        `${state}_${locale.replace('-', '')}_${viewport}`,
        {
          name: `${state} appeal · ${locale} · ${viewport}`,
          globals: { locale },
          parameters: { viewport: { defaultViewport: viewport } },
          render: () => story(state),
        } satisfies Story,
      ]),
    ),
  ) as Record<string, Story>;
}

export const {
  open_en_phone390: OpenEnglishPhone,
  open_en_desktop1280: OpenEnglishDesktop,
  open_zhHans_phone390: OpenChinesePhone,
  open_zhHans_desktop1280: OpenChineseDesktop,
} = variants('open');
export const {
  pending_en_phone390: PendingEnglishPhone,
  pending_en_desktop1280: PendingEnglishDesktop,
  pending_zhHans_phone390: PendingChinesePhone,
  pending_zhHans_desktop1280: PendingChineseDesktop,
} = variants('pending');
export const {
  expired_en_phone390: ExpiredEnglishPhone,
  expired_en_desktop1280: ExpiredEnglishDesktop,
  expired_zhHans_phone390: ExpiredChinesePhone,
  expired_zhHans_desktop1280: ExpiredChineseDesktop,
} = variants('expired');
