import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { useState, useSyncExternalStore } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReporterStatusResult } from '../../moderation/reporter-status-read-model';
import {
  ReporterStatusFailure,
  ReporterStatusReadState,
  ReporterStatusResultPage,
  ReporterStatusView,
} from '../../moderation/reporter-status-view';
import { reporterStatusViewports, submittedReport } from './fixture';
import { m } from '../../paraglide/messages.js';

const evidence = submittedReport.evidence;
const revisionId = submittedReport.revisionId;
if (!evidence || !revisionId) throw new Error('The report story requires submitted evidence and a revision reference');
const fullEvidence = Array.from(
  { length: 12 },
  (_, index) =>
    `Evidence paragraph ${index + 1}: I submitted the original report because repeated unsolicited advertising disrupted the discussion. The complete account records where I saw it and why I believed it needed review.`,
).join('\n\n');
const fullEvidenceReport = {
  ...submittedReport,
  evidence: fullEvidence,
  targetAvailability: 'available' as const,
  outcome: 'dismissed' as const,
  resolvedAt: '2026-10-31T10:00:00.000Z',
};

const meta = {
  title: 'Moderation/Reporter status Workflow',
  id: 'patterns-reporter-status',
  component: ReporterStatusView,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The reporter’s receipt, submitted reason and evidence, native timeline and current disposition. Reference details expand for copying; availability never grants a target read or link. The served page reuses this presenter. Review the same IDs at phone390 and desktop1280 using globals; native acceptance and visual review remain pending.',
      },
    },
    viewport: { options: reporterStatusViewports },
  },
  args: { report: submittedReport },
  render: (args) => (
    <div className="mx-auto max-w-3xl">
      <ReporterStatusView {...args} />
    </div>
  ),
} satisfies Meta<typeof ReporterStatusView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expect(canvas.getByRole('heading', { level: 2, name: m.reporter_status_timeline() })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: m.reporter_status_submission() })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: m.reporter_status_target() })).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_pending())).toBeVisible();
    await expect(canvas.getByText(evidence)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
export const Actioned: Story = {
  args: { report: { ...submittedReport, outcome: 'actioned', resolvedAt: '2026-10-31T09:00:00.000Z' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.moderation_actioned(), { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_actioned_explanation())).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_reviewed())).toBeVisible();
  },
};
export const Dismissed: Story = {
  args: { report: { ...submittedReport, outcome: 'dismissed', resolvedAt: '2026-10-31T09:00:00.000Z' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.moderation_dismissed())).toBeVisible();
  },
};
export const TargetUnavailable: Story = {
  args: {
    report: {
      ...submittedReport,
      targetAvailability: 'unavailable',
      outcome: 'actioned',
      resolvedAt: '2026-10-31T09:00:00.000Z',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(canvas.getByText(evidence)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
    await userEvent.click(canvas.getByText(m.reporter_status_reference(), { exact: true }));
    await expect(canvas.getByText(`post ${submittedReport.target.id}`)).toBeVisible();
    await expect(canvas.getByText(revisionId)).toBeVisible();
  },
};
export const FullEvidence: Story = {
  args: { report: fullEvidenceReport },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(fullEvidence)).toBeVisible();
    await expect(canvas.getByText(m.report_spam(), { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_available())).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_dismissed_explanation())).toBeVisible();
    await expect(canvasElement.querySelector('time[datetime="2026-10-30T10:00:00.000Z"]')).not.toBeNull();
    await expect(canvasElement.querySelector('time[datetime="2026-10-31T10:00:00.000Z"]')).not.toBeNull();
    await expect(canvasElement.textContent).toContain('UTC');
    await expect(canvas.queryByRole('link')).toBeNull();
    await userEvent.click(canvas.getByText(m.reporter_status_reference(), { exact: true }));
    await expect(canvas.getByText(m.reporter_status_report_id(), { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_revision(), { exact: true })).toBeVisible();
    await expect(canvas.getByText(submittedReport.id, { exact: true })).toBeVisible();
    await expect(
      canvas.getByText(`${submittedReport.target.kind} ${submittedReport.target.id}`, { exact: true }),
    ).toBeVisible();
    await expect(canvas.getByText(revisionId, { exact: true })).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
export const SubmittedDetails: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText(submittedReport.id)).toBeVisible();
    await expect(canvas.getByText(revisionId)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.reporter_status_copy() }));
    await waitFor(() =>
      expect([m.reporter_status_copied(), m.reporter_status_copy_failed()]).toContain(
        canvas.getByRole('status').textContent?.trim(),
      ),
    );
    await expect(canvas.getByText(evidence)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
const retry = fn(async () => {
  throw new Error('Report status unavailable');
});
export const NativeError: Story = {
  render: () => <ReporterStatusFailure onRetry={retry} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.reporter_status_unavailable());
    await expect(canvas.getByRole('button', { name: m.sources_retry() })).toBeEnabled();
    await expect(canvas.queryByText(m.reporter_status_pending())).toBeNull();
    await expect(canvas.queryByText(evidence)).toBeNull();
  },
};
export const Retry: Story = {
  render: () => <ReporterStatusFailure onRetry={retry} />,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: m.sources_retry() });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(retry).toHaveBeenCalled();
    await waitFor(() => expect(button).toBeEnabled());
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(m.reporter_status_unavailable());
  },
};

export const Loading: Story = {
  render: () => <ReporterStatusReadState state="loading" />,
};
export const Concealed: Story = {
  render: () => <ReporterStatusReadState state="concealed" />,
};
export const PlatformClosed: Story = {
  render: () => <ReporterStatusReadState state="closed" />,
};

function RecoveryExample() {
  const [result, setResult] = useState<ReporterStatusResult>({ state: 'unavailable' });
  return (
    <ReporterStatusResultPage
      result={result}
      onRetry={async () => {
        setResult({ state: 'loading' });
        await new Promise((resolve) => setTimeout(resolve, 250));
        setResult({ state: 'loaded', report: { ...submittedReport, targetAvailability: 'unavailable' } });
      }}
    />
  );
}
export const Recovery: Story = {
  render: () => <RecoveryExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(evidence)).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.sources_retry() }));
    await expect(await canvas.findByText(evidence)).toBeVisible();
    await expect(canvas.getByText(m.moderation_target_unavailable())).toBeVisible();
  },
};

/** Separate presenter fixture. Production preparation/admission is exercised by connected tests, not this story. */
function SessionRetirementExample() {
  const [cache] = useState(() => {
    const client = new QueryClient();
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reporter', csrfToken: 'fixture-session' });
    return client;
  });
  const [original] = useState(() => cache.getQueryData(['session']));
  const session = useSyncExternalStore(
    (listener) => cache.getQueryCache().subscribe(listener),
    () => cache.getQueryData(['session']),
    () => original,
  );
  const [retired, setRetired] = useState(false);
  if (!retired && session !== original) setRetired(true);
  return (
    <QueryClientProvider client={cache}>
      <button
        type="button"
        onClick={() =>
          cache.setQueryData(['session'], {
            state: 'signed-in',
            subject: 'reporter',
            csrfToken: 'replacement-fixture-session',
          })
        }
      >
        Replace browser session
      </button>
      <ReporterStatusResultPage
        result={
          retired
            ? { state: 'concealed' }
            : {
                state: 'loaded',
                report: { ...submittedReport, targetAvailability: 'unavailable' },
              }
        }
        onRetry={() => {}}
      />
    </QueryClientProvider>
  );
}
export const SessionRetirement: Story = {
  render: () => <SessionRetirementExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(evidence)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Replace browser session' }));
    await expect(await canvas.findByText(m.reporter_status_read_concealed())).toBeVisible();
    await expect(canvas.queryByText(evidence)).toBeNull();
  },
};
