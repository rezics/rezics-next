import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback } from 'react';
import { expect, within } from 'storybook/test';
import { ErasureProgressView } from '../../accounts/erasure-progress/view';
import { AccountErasurePage } from '../../accounts/erasure-progress/page';
import type { ErasureStatus, Page } from '../../accounts/erasure-progress/data';
import type { ErasureOperation, ErasureRead } from '../../threads/author-erasure';
import { AuthorErasureOperationPage } from '../../threads/author-erasure-operation';
import { m } from '../../paraglide/messages.js';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';
import { erasureStoryOperation } from '../patterns/author-erasure/author-erasure-preview';

const meta = {
  title: 'Account/Erasure progress',
  id: 'pages-account-erasure-progress',
  component: ErasureProgressView,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component: 'Illustrative consumer states only. These stories provide no native erasure or participant proof.',
      },
    },
  },
  render: (args) => (
    <PatternStory
      visitor={args.page.status === 'signed-out' ? 'Signed Out' : 'Signed In'}
      path={`/platform/accounts/${value.accountId}/erasure`}
    >
      <AppShell>
        <ErasureProgressView {...args} />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement, args, step }) => {
    await step(
      'Erasure progress page stories expose one main without turning illustrative complete or missing participant evidence into native erasure proof',
      async () => {
        const canvas = within(canvasElement);
        const main = within(await canvas.findByRole('main'));
        await expect(canvas.getAllByRole('main')).toHaveLength(1);
        await expect(main.getByRole('heading', { level: 1, name: m.erasure_title() })).toBeVisible();
        if (args.page.status !== 'ready') {
          await expect(main.getByRole('status')).toBeVisible();
          return;
        }
        const { state, pendingParticipants } = args.page.value;
        const heading = {
          pending: m.erasure_pending,
          'retention-outstanding': m.erasure_retention,
          complete: m.erasure_complete,
        }[state]();
        await expect(main.getByRole('heading', { level: 2, name: heading })).toBeVisible();
        if (state === 'complete') {
          await expect(main.getByText(m.erasure_complete_help())).toBeVisible();
        } else {
          await expect(main.queryByRole('heading', { level: 2, name: m.erasure_complete() })).not.toBeInTheDocument();
          if (state === 'pending' && pendingParticipants.length === 0) {
            await expect(main.getByText(m.erasure_no_pending_names())).toBeVisible();
            await expect(main.getByText(m.erasure_pending_help())).toBeVisible();
          }
        }
      },
    );
  },
} satisfies Meta<typeof ErasureProgressView>;
export default meta;
type Story = StoryObj<typeof meta>;
const value: ErasureStatus = {
  accountId: '019a0000-0000-7000-8000-000000000001',
  state: 'pending',
  at: '2026-10-01T10:00:00.000Z',
  completedAt: null,
  pendingParticipants: ['auth', 'shared-history'],
  retentionOutstanding: false,
  lateItems: true,
  effectsFrontier: true,
};
const ready = (value: ErasureStatus): Page => ({
  status: 'ready',
  viewerId: '019a0000-0000-7000-8000-000000000002',
  value,
});
export const Pending: Story = { args: { page: ready(value) } };
export const MissingParticipantProof: Story = {
  args: { page: ready({ ...value, pendingParticipants: [], lateItems: false, effectsFrontier: false }) },
};
export const RetentionOutstanding: Story = {
  args: {
    page: ready({
      ...value,
      state: 'retention-outstanding',
      completedAt: '2026-10-02T10:00:00.000Z',
      pendingParticipants: [],
      retentionOutstanding: true,
      lateItems: false,
      effectsFrontier: false,
    }),
  },
};
export const Complete: Story = {
  args: {
    page: ready({
      ...value,
      state: 'complete',
      completedAt: '2026-10-02T10:00:00.000Z',
      pendingParticipants: [],
      lateItems: false,
      effectsFrontier: false,
    }),
  },
};
export const Missing: Story = { args: { page: { status: 'missing' } } };
export const Denied: Story = { args: { page: { status: 'denied' } } };
export const SignedOut: Story = {
  args: { page: { status: 'signed-out' } },
  render: () => (
    <PatternStory visitor="Signed Out" path={`/platform/accounts/${value.accountId}/erasure`}>
      <AppShell>
        <AccountErasurePage accountId={value.accountId} />
      </AppShell>
    </PatternStory>
  ),
};
export const Unavailable: Story = { args: { page: { status: 'unavailable' } } };
export const Loading: Story = { args: { page: { status: 'loading' } } };

export const SessionUnavailable: Story = {
  args: { page: { status: 'unavailable' } },
  parameters: {
    docs: {
      description: {
        story:
          'The existing illustrative session has no valid current account subject. The default page offers a real session read retry without reading erasure data.',
      },
    },
  },
  render: () => (
    <PatternStory visitor="Signed In" path={`/platform/accounts/${value.accountId}/erasure`}>
      <AppShell>
        <AccountErasurePage accountId={value.accountId} />
      </AppShell>
    </PatternStory>
  ),
};

const authorOperationId = erasureStoryOperation('running').name.slice('operations/'.length);
const authorRunning = erasureStoryOperation('running');
const authorUnavailable: ErasureRead = { kind: 'unavailable' };

function AuthorOperationProgressFixture({
  initial,
  visitor = 'Signed In',
  holdRead = false,
}: {
  initial: ErasureRead;
  visitor?: 'Signed In' | 'Signed Out';
  holdRead?: boolean;
}) {
  const read = useCallback(
    () => (holdRead ? new Promise<ErasureRead>(() => {}) : Promise.resolve(initial)),
    [holdRead, initial],
  );
  const operationId =
    initial.kind === 'available' ? initial.operation.name.slice('operations/'.length) : authorOperationId;
  return (
    <PatternStory visitor={visitor} path={`/operations/${operationId}`}>
      <AppShell>
        <AuthorErasureOperationPage initial={initial} operationId={operationId} read={read} />
      </AppShell>
    </PatternStory>
  );
}

function terminalOperation(code: number): ErasureRead {
  const operation: ErasureOperation = {
    name: authorRunning.name,
    done: true,
    metadata: authorRunning.metadata,
    error: { code, message: 'Illustrative operation result' },
  };
  return { kind: 'available', operation };
}

function authorProgressStory(
  initial: ErasureRead,
  heading: string,
  options: {
    visitor?: 'Signed In' | 'Signed Out';
    holdRead?: boolean;
  } = {},
): Story {
  return {
    args: { page: { status: 'loading' } },
    render: () => (
      <AuthorOperationProgressFixture
        initial={initial}
        {...(options.visitor !== undefined ? { visitor: options.visitor } : {})}
        {...(options.holdRead !== undefined ? { holdRead: options.holdRead } : {})}
      />
    ),
    parameters: {
      docs: {
        description: {
          story:
            'Illustrative operation result rendered by the production author-erasure page. It is not native authorization or physical-cleanup proof.',
        },
      },
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await expect(await canvas.findByRole('heading', { level: 2, name: heading })).toBeVisible();
    },
  };
}

export const AuthorQueued: Story = authorProgressStory(
  { kind: 'available', operation: erasureStoryOperation('queued') },
  m.author_erasure_queued(),
);
export const AuthorRunning: Story = authorProgressStory(
  { kind: 'available', operation: authorRunning },
  m.author_erasure_running(),
);
export const AuthorCompleted: Story = authorProgressStory(
  { kind: 'available', operation: erasureStoryOperation('completed') },
  m.author_erasure_completed(),
);
export const AuthorFailed: Story = authorProgressStory(terminalOperation(13), m.author_erasure_failed());
export const AuthorPermissionStopped: Story = authorProgressStory(terminalOperation(7), m.author_erasure_failed());
export const AuthorChangedSource: Story = authorProgressStory(terminalOperation(9), m.author_erasure_failed());
export const AuthorDependencyUnavailable: Story = authorProgressStory(terminalOperation(14), m.author_erasure_failed());
export const AuthorStatusUnavailable: Story = authorProgressStory(
  authorUnavailable,
  m.author_erasure_status_unavailable(),
);
export const AuthorSignedOut: Story = authorProgressStory(
  { kind: 'signed-out' },
  m.author_erasure_status_unavailable(),
  { visitor: 'Signed Out' },
);
export const AuthorPermissionRefused: Story = authorProgressStory(
  { kind: 'forbidden' },
  m.author_erasure_status_unavailable(),
);
export const AuthorNotFound: Story = authorProgressStory({ kind: 'not-found' }, m.author_erasure_status_unavailable());
export const AuthorConflict: Story = authorProgressStory({ kind: 'conflict' }, m.author_erasure_status_unavailable());
export const AuthorStatusCheckPending: Story = {
  ...authorProgressStory(authorUnavailable, m.author_erasure_status_unavailable(), { holdRead: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: m.author_erasure_check_again() })).toBeEnabled();
    await canvas.getByRole('button', { name: m.author_erasure_check_again() }).click();
    await expect(await canvas.findByRole('button', { name: m.author_erasure_checking() })).toBeDisabled();
  },
};
