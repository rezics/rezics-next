import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { CatalogueReport } from '../moderation/catalogue-reports-read';
import type { CatalogueReportsPageState } from '../moderation/catalogue-reports-journey';
import { CatalogueReportsView, type CatalogueReportsViewProps } from '../moderation/catalogue-reports-page';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';
import { m } from '../paraglide/messages.js';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const otherSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000302';
const reports: CatalogueReport[] = [
  {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000401',
    target: { kind: 'subject', id: subjectId },
    revisionId: null,
    reason: 'other',
    evidence: 'The catalogue entry exposes a personal address.',
    createdAt: '2026-10-28T10:00:00.000Z',
    outcome: null,
    resolvedAt: null,
  },
  {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000402',
    target: { kind: 'subject', id: otherSubjectId },
    revisionId: null,
    reason: 'spam',
    evidence: 'Repeated promotional content.',
    createdAt: '2026-10-27T09:30:00.000Z',
    outcome: 'actioned',
    resolvedAt: '2026-10-28T09:00:00.000Z',
  },
];
const loaded: CatalogueReportsPageState = {
  state: 'loaded',
  reports,
  next: 'native-catalogue-cursor-next',
  selectedId: reports[0]!.id,
  subject: { state: 'loaded', subject: { id: subjectId, title: 'Reported catalogue entry', type: 'schema:Thing' } },
  reason: '',
  action: { state: 'idle' },
};

function LoadedStory({ args }: { args: CatalogueReportsViewProps }) {
  const [page, setPage] = useState<CatalogueReportsPageState>(loaded);
  return (
    <CatalogueReportsView
      {...args}
      page={page}
      onSelect={(selectedId) => {
        args.onSelect(selectedId);
        const report = reports.find((item) => item.id === selectedId)!;
        setPage((previous) =>
          previous.state !== 'loaded'
            ? previous
            : {
                ...previous,
                selectedId,
                subject: { state: 'loaded', subject: { id: report.target.id, title: 'Selected current Subject', type: 'schema:Thing' } },
                action: { state: 'idle' },
              },
        );
      }}
      onReason={(reason) => {
        args.onReason(reason);
        setPage((previous) => (previous.state === 'loaded' ? { ...previous, reason } : previous));
      }}
      onAct={(action) => {
        args.onAct(action);
        const report = page.reports.find((item) => item.id === page.selectedId)!;
        setPage((previous) =>
          previous.state !== 'loaded'
            ? previous
            : action === 'dismiss'
              ? {
                  ...previous,
                  reports: previous.reports.map((item) => (item.id === report.id ? { ...item, outcome: 'dismissed' } : item)),
                  action: { state: 'confirmed', result: { kind: 'dismissed', reportId: report.id, outcome: 'dismissed' } },
                }
              : {
                  ...previous,
                  subject: { state: 'changed', visibility: action === 'hide' ? 'hidden' : 'visible' },
                  action: {
                    state: 'confirmed',
                    result: { kind: 'visibility', subjectId: report.target.id, visibility: action === 'hide' ? 'hidden' : 'visible' },
                  },
                },
        );
      }}
    />
  );
}

const meta = {
  title: 'Pages/Moderation/Catalogue reports',
  component: CatalogueReportsView,
  parameters: { layout: 'fullscreen', viewport: { options: queueViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/moderation/catalogue">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    page: loaded,
    onSelect: fn(),
    onReason: fn(),
    onAct: fn(),
    onRetryAction: fn(),
    onRetryPage: fn(),
    onRetrySubject: fn(),
    onRefresh: fn(),
    onNext: fn(),
    onRestart: fn(),
  },
} satisfies Meta<typeof CatalogueReportsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loaded: Story = {
  render: (args) => <LoadedStory args={args} />,
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const selection = view.getByRole('button', { name: new RegExp(otherSubjectId) });
    await userEvent.click(selection);
    await expect(view.getByText('Repeated promotional content.')).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: new RegExp(subjectId) }));
    await userEvent.click(view.getByRole('button', { name: m.moderation_dismiss() }));
    await expect(view.getByRole('status')).toHaveTextContent(m.moderation_dismissed());
    await expect(args.onSelect).toHaveBeenCalledWith(reports[1]!.id);
    await expect(args.onSelect).toHaveBeenCalledWith(reports[0]!.id);
    await expect(args.onAct).toHaveBeenCalledWith('dismiss');
  },
};

export const Empty: Story = {
  args: { page: { state: 'loaded', reports: [], next: null, selectedId: null, subject: { state: 'idle' }, reason: '', action: { state: 'idle' } } },
};

export const Denied: Story = {
  args: { page: { state: 'denied', reports: [], next: null } },
};

export const Retry: Story = {
  args: { page: { state: 'error', reports: [], next: null } },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry() }));
    await expect(args.onRetryPage).toHaveBeenCalledTimes(1);
  },
};
