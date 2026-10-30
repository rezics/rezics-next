import type { Meta, StoryObj } from '@storybook/react-vite';
import { ModerationReportsView } from '../moderation/reports-page';

const meta = {
  title: 'Pages/Community/Moderation reports',
  parameters: { layout: 'fullscreen' },
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
          version: 'rezics-document-v1',
          profile: 'blocks',
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'moderation-report-post' },
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
  locale: 'en' | 'zh-Hans' = 'en',
  theme: 'light' | 'dark' = 'light',
  regression = false,
) {
  const reports =
    state === 'open'
      ? [postReport, threadReport]
      : [
          { ...postReport, outcome: 'actioned' as const, resolvedAt: '2026-10-29T08:30:00.000Z' },
          { ...threadReport, outcome: 'dismissed' as const, resolvedAt: '2026-10-29T08:45:00.000Z' },
        ];
  return {
    globals: { locale, theme },
    ...(regression ? { tags: ['!dev'] } : {}),
    render: () => (
      <ModerationReportsView reports={reports} targets={targets} next={state === 'open' ? 'cursor-next' : null} />
    ),
  } satisfies Story;
}

export const OpenReports: Story = { name: 'Open reports', ...makeStory('open') };
export const OpenReportsDark: Story = {
  name: 'Open reports',
  tags: ['!dev'],
  ...makeStory('open', 'en', 'dark', true),
};
export const OpenReportsChinese: Story = {
  name: 'Open reports',
  tags: ['!dev'],
  ...makeStory('open', 'zh-Hans', 'light', true),
};
export const OpenReportsChineseDark: Story = {
  name: 'Open reports',
  tags: ['!dev'],
  ...makeStory('open', 'zh-Hans', 'dark', true),
};
export const ResolvedReports: Story = { name: 'Resolved reports', ...makeStory('resolved') };
export const ResolvedReportsDark: Story = {
  name: 'Resolved reports',
  tags: ['!dev'],
  ...makeStory('resolved', 'en', 'dark', true),
};
export const ResolvedReportsChinese: Story = {
  name: 'Resolved reports',
  tags: ['!dev'],
  ...makeStory('resolved', 'zh-Hans', 'light', true),
};
export const ResolvedReportsChineseDark: Story = {
  name: 'Resolved reports',
  tags: ['!dev'],
  ...makeStory('resolved', 'zh-Hans', 'dark', true),
};
