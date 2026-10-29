import type { Meta, StoryObj } from '@storybook/react-vite';
import { ModerationReportsView } from '../moderation/reports-page';

const meta = {
  title: 'Pages/Moderation reports',
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

const postReport = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  target: { kind: 'post' as const, id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  revisionId: null,
  reason: 'Contains personal information that should not be public.',
  evidence: null,
  createdAt: '2026-10-28T15:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const threadReport = {
  ...postReport,
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  target: { kind: 'thread' as const, id: '0192f3a0-6c1e-7b2a-9d4e-000000000051' },
  reason: 'The thread appears to be advertising.',
};
const targets = [
  {
    key: `post:${postReport.target.id}`,
    kind: 'post' as const,
    value: {
      post: {
        body: {
          profile: 'blocks',
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'A sample reported post with enough text to show how a moderator reviews the target.',
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
  {
    key: `thread:${threadReport.target.id}`,
    kind: 'thread' as const,
    value: { thread: { title: 'A reported thread with an unavailable promise' } },
  },
];

function makeStory(
  state: 'open' | 'resolved',
  locale: 'en' | 'zh-Hans',
  theme: 'light' | 'dark',
  viewport: 'phone390' | 'desktop1280',
) {
  const reports =
    state === 'open'
      ? [postReport, threadReport]
      : [
          { ...postReport, outcome: 'actioned' as const, resolvedAt: '2026-10-29T08:30:00.000Z' },
          { ...threadReport, outcome: 'dismissed' as const, resolvedAt: '2026-10-29T08:45:00.000Z' },
        ];
  return {
    name: `${state} reports · ${locale} · ${theme} · ${viewport}`,
    globals: { locale, theme },
    parameters: { viewport: { defaultViewport: viewport } },
    render: () => (
      <ModerationReportsView reports={reports} targets={targets} next={state === 'open' ? 'cursor-next' : null} />
    ),
  } satisfies Story;
}

export const OpenEnglishLightPhone: Story = makeStory('open', 'en', 'light', 'phone390');
export const OpenEnglishLightDesktop: Story = makeStory('open', 'en', 'light', 'desktop1280');
export const OpenEnglishDarkPhone: Story = makeStory('open', 'en', 'dark', 'phone390');
export const OpenEnglishDarkDesktop: Story = makeStory('open', 'en', 'dark', 'desktop1280');
export const OpenChineseLightPhone: Story = makeStory('open', 'zh-Hans', 'light', 'phone390');
export const OpenChineseLightDesktop: Story = makeStory('open', 'zh-Hans', 'light', 'desktop1280');
export const OpenChineseDarkPhone: Story = makeStory('open', 'zh-Hans', 'dark', 'phone390');
export const OpenChineseDarkDesktop: Story = makeStory('open', 'zh-Hans', 'dark', 'desktop1280');
export const ResolvedEnglishLightPhone: Story = makeStory('resolved', 'en', 'light', 'phone390');
export const ResolvedEnglishLightDesktop: Story = makeStory('resolved', 'en', 'light', 'desktop1280');
export const ResolvedEnglishDarkPhone: Story = makeStory('resolved', 'en', 'dark', 'phone390');
export const ResolvedEnglishDarkDesktop: Story = makeStory('resolved', 'en', 'dark', 'desktop1280');
export const ResolvedChineseLightPhone: Story = makeStory('resolved', 'zh-Hans', 'light', 'phone390');
export const ResolvedChineseLightDesktop: Story = makeStory('resolved', 'zh-Hans', 'light', 'desktop1280');
export const ResolvedChineseDarkPhone: Story = makeStory('resolved', 'zh-Hans', 'dark', 'phone390');
export const ResolvedChineseDarkDesktop: Story = makeStory('resolved', 'zh-Hans', 'dark', 'desktop1280');
