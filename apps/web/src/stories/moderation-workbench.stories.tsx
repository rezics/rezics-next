import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';
import { m } from '../paraglide/messages.js';
import { workbenchSearch } from '../moderation/workbench-queue/scope';
import type { Appeal } from '../moderation/appeals-read';
import { WorkbenchPreparing, WorkbenchView, type WorkbenchViewProps } from '../moderation/workbench-queue/view';

const search = workbenchSearch({ board: 'community', queue: 'reports' });
const emptyPage = {
  state: 'ready' as const,
  search,
  realms: [],
  realmsNext: null,
  boards: [],
  boardsNext: null,
  cases: [],
  next: null,
};

const meta = {
  title: 'Moderation/Workbench queue',
  id: 'pages-moderation-workbench-queue',
  component: WorkbenchView,
  parameters: { layout: 'fullscreen', viewport: { options: queueViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/moderation/workbench">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    page: emptyPage,
    onSearch: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof WorkbenchView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Preparation: Story = {
  render: () => <WorkbenchPreparing />,
};

export const Empty: Story = {};

export const Denied: Story = {
  args: { page: { ...emptyPage, state: 'denied' } },
};

export const Unavailable: Story = {
  args: { page: { ...emptyPage, state: 'unavailable' } },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry() }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const Recovery: Story = {
  args: { page: { ...emptyPage, state: 'stale' } },
  play: async ({ canvasElement, args }: { canvasElement: HTMLElement; args: WorkbenchViewProps }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_restart() }));
    await expect(args.onSearch).toHaveBeenCalled();
  },
};

const laterWindowSearch = workbenchSearch({
  board: 'community',
  queue: 'reports',
  targetKind: 'post',
  order: 'newest',
  cursor: 'native-window-cursor',
});

export const LaterWindowCaseReturn: Story = {
  args: {
    page: {
      ...emptyPage,
      search: laterWindowSearch,
      boards: [{ id: 'community', title: 'Community help and discussion' }],
      cases: [
        {
          kind: 'report',
          id: '0192f3a0-6c1e-7b2a-9d4e-000000000901',
          createdAt: '2026-11-01T10:00:00.000Z',
          outcome: null,
          reason: 'other',
          evidence: 'Repeated private messages were posted after the author asked for them to stop.',
          statement: null,
          decisionId: null,
          target: { kind: 'post', id: 'post-later-window' },
        },
      ],
      next: 'native-next-window-cursor',
    },
    queueWindow: { previous: true, refresh: true, first: true },
    onWindowMove: fn(),
    onRefresh: fn(async () => {}),
    onOpenCase: fn(),
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText('Community help and discussion')).toBeVisible();
    await expect(view.getByText(m.moderation_admission_current())).toBeVisible();
    const row = within(view.getByRole('listitem'));
    await expect(
      row.getByText('Repeated private messages were posted after the author asked for them to stop.'),
    ).toBeVisible();
    const link = row.getByRole('link', {
      name: m.moderation_workbench_open_case({ id: '0192f3a0-6c1e-7b2a-9d4e-000000000901' }),
    });
    await expect(link).toHaveTextContent(m.moderation_case_open());
    const destination = new URL(link.getAttribute('href')!, window.location.origin);
    await expect(destination.searchParams.get('cursor')).toBe('native-window-cursor');
    await expect(destination.searchParams.get('boardId')).toBe('community');
    await expect(destination.searchParams.get('targetKind')).toBe('post');
    link.focus();
    await expect(link).toHaveFocus();
  },
};

// Selected native inspection is supplied independently of the pending queue window.
const selectedAppeal: Appeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000911',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000912',
  appellantId: 'private-fixture-appellant',
  appellantIdentity: {
    state: 'available',
    kind: 'actor',
    displayName: 'River Chen',
    handle: 'river',
    automated: false,
  },
  createdAt: '2026-11-02T08:30:00.000Z',
  statement:
    'The contact details are the organization’s public event enquiry address. Please review the original context.',
  decision: {
    statement: 'The reported revision appeared to disclose a private contact address.',
    target: { kind: 'post', id: 'original-reported-post' },
  },
  targetContext: { state: 'concealed' },
  resolution: null,
  canResolve: true,
};

export const SelectedAppeal: Story = {
  args: {
    page: {
      ...emptyPage,
      boards: [{ id: 'community', title: 'Community help and discussion' }],
      search: workbenchSearch({
        board: 'community',
        queue: 'appeals',
        case: selectedAppeal.id,
        cursor: 'native-appeal-window',
      }),
      appeals: [],
      selectedAppeal,
      nativeSession: 'private-illustrative-appeal-session',
    },
    isCurrent: () => true,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText('River Chen · @river')).toBeVisible();
    await expect(view.getByText(selectedAppeal.statement)).toBeVisible();
    await expect(view.getByText(selectedAppeal.decision.statement)).toBeVisible();
    await expect(view.getByText(m.moderation_appeal_context_concealed())).toBeVisible();
    await expect(view.getByText('original-reported-post', { exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: m.moderation_appeal_uphold_action() })).toBeVisible();
    await expect(view.getByRole('button', { name: m.moderation_appeal_reverse_action() })).toBeVisible();
    const back = view.getByRole('link', { name: m.moderation_workbench_history_return() });
    const destination = new URL(back.getAttribute('href')!, window.location.origin);
    await expect(destination.searchParams.get('cursor')).toBe('native-appeal-window');
    await expect(destination.searchParams.has('case')).toBe(false);
    await expect(canvasElement.innerHTML).not.toContain(selectedAppeal.appellantId);
    await expect(canvasElement.innerHTML).not.toContain('private-illustrative-appeal-session');
  },
};
