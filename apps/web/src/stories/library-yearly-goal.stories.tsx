import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { createYearlyGoalVisit } from '../library/yearly-goal-current';
import { readYearlyGoal, writeYearlyGoal } from '../library/yearly-goal-native';
import { YearlyGoalPage, type YearlyGoalSnapshot } from '../library/yearly-goal-page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Library/Yearly completion goal',
  id: 'pages-library-yearly-completion-goal',
  component: YearlyGoalPage,
  parameters: { layout: 'fullscreen' },
  args: { year: 2026, sessionState: 'signed-in', viewerSubject: 'storybook-owner' },
} satisfies Meta<typeof YearlyGoalPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function snapshot(year: number, target: YearlyGoalSnapshot['target'], unavailable: boolean): YearlyGoalSnapshot {
  const bucket = (count = '0') => ({
    completedOccurrences: count,
    distinctCompletedSubjects: count === '0' ? '0' : '1',
    repeatOccurrences: count === '0' ? '0' : '1',
    completedOccurrencesWithUnknownProfile: '0',
    finishPrecision: { year: '0', month: '0', day: count },
  });
  return {
    year,
    metric: 'completed_consumption_occurrences',
    viewer: {
      state: 'owner',
      actions: {
        editTarget: { allowed: true },
        clearTarget: target.state === 'set' ? { allowed: true } : { allowed: false, reason: 'no_target' },
        navigateYear: { allowed: true },
      },
    },
    target,
    progress: unavailable
      ? { state: 'unavailable', reason: 'summary_unavailable' }
      : {
          state: 'available',
          summary: {
            ...bucket('2'),
            year,
            scope: 'retained_native_sessions',
            calendar: 'gregorian',
            dateSource: 'explicitly_reported_journal_finish',
            months: Array.from({ length: 12 }, (_, index) => ({
              ...bucket(index === 1 ? '2' : '0'),
              month: index + 1,
            })),
            monthUnallocated: bucket(),
            coverage: {
              nativeSessions: 'complete',
              initializedSessions: '3',
              retainedSessions: '3',
              completedOccurrencesWithMissingFinish: '0',
              completedOccurrencesWithUnsupportedFinish: '0',
              otherHistory: 'unavailable',
              unitMeaning: 'not_evaluated',
            },
            currentness: { state: 'snapshot', revision: 'summary-generation' },
          },
        },
  };
}

type Scenario = {
  progressUnavailable?: boolean;
  firstWrite?: 'stale' | 'uncertain';
  readbackFails?: boolean;
  target?: number;
};

/** Contract-shaped HTTP responses enter the installed generated client, including command receipt replay. */
function receiver(scenario: Scenario = {}) {
  let active = true;
  let target: YearlyGoalSnapshot['target'] =
    scenario.target === undefined
      ? { state: 'none', revision: null }
      : { state: 'set', target: scenario.target, revision: '3' };
  let first = true;
  let failReadback = false;
  const receipts = new Map<
    string,
    { body: string; value: { year: number; metric: string; target: number | null; revision: string } }
  >();
  const client = createKernelClient('https://yearly-goal.story', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') {
        if (failReadback) {
          failReadback = false;
          throw new TypeError('Readback unavailable');
        }
        return Response.json(
          snapshot(Number(new URL(request.url).searchParams.get('year')), target, !!scenario.progressUnavailable),
        );
      }
      const body = await request.text();
      const command = JSON.parse(body);
      const key = request.headers.get('idempotency-key')!;
      const receipt = receipts.get(key);
      if (receipt)
        return receipt.body === body
          ? Response.json(receipt.value)
          : Response.json({ code: 'idempotency_conflict', effect_status: 'not_applied' }, { status: 422 });
      if (first && scenario.firstWrite === 'stale') {
        first = false;
        target = { state: 'set', target: 4, revision: '8' };
        return Response.json({ code: 'conflict', effect_status: 'not_applied' }, { status: 409 });
      }
      const revision = target.state === 'unavailable' ? null : target.revision;
      if (command.expectedRevision !== revision)
        return Response.json({ code: 'conflict', effect_status: 'not_applied' }, { status: 409 });
      const next = revision === null ? '1' : (BigInt(revision) + 1n).toString();
      target =
        command.target === null
          ? { state: 'none', revision: next }
          : { state: 'set', target: command.target, revision: next };
      const value = { year: command.year, metric: command.metric, target: command.target, revision: next };
      receipts.set(key, { body, value });
      failReadback = !!scenario.readbackFails;
      if (first && scenario.firstWrite === 'uncertain') {
        first = false;
        throw new TypeError('Response lost after commit');
      }
      first = false;
      return Response.json(value);
    }) as typeof fetch,
  });
  const visit = createYearlyGoalVisit({
    year: 2026,
    viewer: 'storybook-owner',
    csrfToken: 'storybook-csrf',
    current: () => active,
    read: ({ year }, signal) => readYearlyGoal(client, 'Bearer story-owner', year, signal),
    sender: {
      prepare: async () => ({ state: 'ready', credential: 'sealed-story-credential' }),
      write: ({ command }, signal) => writeYearlyGoal(client, 'Bearer story-owner', command, signal),
    },
  });
  return {
    api: visit.api,
    retire: () => {
      active = false;
      visit.retire();
    },
  };
}

function NativePage({ scenario }: { scenario: Scenario }) {
  const native = useMemo(() => receiver(scenario), [scenario]);
  useEffect(() => () => native.retire(), [native]);
  return <YearlyGoalPage year={2026} sessionState="signed-in" viewerSubject="storybook-owner" api={native.api} />;
}
const available: Scenario = {};
const unavailableProgress: Scenario = { progressUnavailable: true, target: 18 };
const uncertain: Scenario = { firstWrite: 'uncertain' };
const stale: Scenario = { firstWrite: 'stale' };
const failedReadback: Scenario = { readbackFails: true };

export const Unavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('status')[0]).toHaveTextContent(m.library_yearly_goal_unavailable());
    await expect(canvas.queryByRole('progressbar')).toBeNull();
    await expect(canvas.getByRole('link', { name: m.library_diary_nav() })).toHaveAttribute(
      'href',
      expect.stringContaining('/library/history?year=2026'),
    );
  },
};
export const SignedOut: Story = {
  args: { sessionState: 'signed-out' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_yearly_goal_signed_out())).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: m.account_sign_in() })).toHaveAttribute(
      'href',
      expect.stringContaining(encodeURIComponent('/library/goals?year=2026')),
    );
  },
};
export const CheckingAccount: Story = { args: { sessionState: 'unknown' } };
export const AccountUnavailable: Story = { args: { sessionState: 'unavailable' } };

export const InstalledReceiver: Story = {
  render: () => <NativePage scenario={available} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_yearly_goal_target_none())).toBeInTheDocument();
    await expect(canvasElement.querySelectorAll('a[href*="month="]')).toHaveLength(13);
    await expect(canvas.getByRole('button', { name: m.library_yearly_goal_edit() })).toHaveClass('min-h-11');
  },
};
export const TargetEditAndClear: Story = {
  render: () => <NativePage scenario={available} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() }), '12');
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: m.library_yearly_goal_save() })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(m.library_yearly_goal_target_revision({ revision: '1' }))).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_clear() }));
    const confirm = canvas.getByRole('button', { name: m.library_yearly_goal_clear() });
    confirm.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(m.library_yearly_goal_target_revision({ revision: '2' }))).toBeInTheDocument();
    await expect(canvas.getByText(m.library_yearly_goal_target_none())).toBeInTheDocument();
  },
};
export const ProgressUnavailableTargetEditable: Story = {
  render: () => <NativePage scenario={unavailableProgress} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_diary_year_unavailable())).toBeInTheDocument();
    await expect(canvas.getByText('18')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_edit() }));
    await expect(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() })).toHaveValue('18');
  },
};
export const UncertainDelivery: Story = {
  render: () => <NativePage scenario={uncertain} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() }), '8');
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_save() }));
    await expect(await canvas.findByText(m.library_yearly_goal_uncertain())).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_retry_exact() }));
    await expect(await canvas.findByText(m.library_yearly_goal_target_revision({ revision: '1' }))).toBeInTheDocument();
  },
};
export const StaleRevisionReview: Story = {
  render: () => <NativePage scenario={stale} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() }), '7');
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_save() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_refresh() }));
    await expect(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() })).toHaveValue('7');
    await expect(await canvas.findByText(m.library_yearly_goal_review())).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_save() }));
    await expect(await canvas.findByText(m.library_yearly_goal_target_revision({ revision: '9' }))).toBeInTheDocument();
  },
};
export const AcknowledgedWithReadbackFailure: Story = {
  render: () => <NativePage scenario={failedReadback} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    await userEvent.type(canvas.getByRole('textbox', { name: m.library_yearly_goal_target() }), '8');
    await userEvent.click(canvas.getByRole('button', { name: m.library_yearly_goal_save() }));
    await expect(await canvas.findByText(m.library_yearly_goal_saved())).toBeInTheDocument();
    await expect(canvas.queryByText(m.library_yearly_goal_uncertain())).toBeNull();
    await userEvent.click(await canvas.findByRole('button', { name: m.library_selection_retry() }));
    await expect(await canvas.findByText(m.library_yearly_goal_target_revision({ revision: '1' }))).toBeInTheDocument();
  },
};

function ReplacedReader() {
  const [owner, setOwner] = useState('owner-a');
  const native = useMemo(() => receiver({ target: owner === 'owner-a' ? 11 : 18 }), [owner]);
  useEffect(() => () => native.retire(), [native]);
  return (
    <>
      <button
        type="button"
        className="min-h-11 min-w-11 border px-4"
        onClick={() => {
          native.retire();
          setOwner('owner-b');
        }}
      >
        Replace current reader
      </button>
      <YearlyGoalPage year={2026} sessionState="signed-in" viewerSubject={owner} api={native.api} />
    </>
  );
}
export const ReaderReplacement: Story = {
  render: () => <ReplacedReader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_yearly_goal_edit() }));
    const input = canvas.getByRole('textbox', { name: m.library_yearly_goal_target() });
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.click(canvas.getByRole('button', { name: 'Replace current reader' }));
    await expect(await canvas.findByText('18')).toBeInTheDocument();
    await expect(canvas.queryByRole('textbox', { name: m.library_yearly_goal_target() })).toBeNull();
    await expect(canvas.queryByText('11')).toBeNull();
  },
};
