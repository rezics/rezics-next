import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, decidedPage, header, now, queue, queueApi, queuePage, realm, type Recorded, agents, works } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { ManageFailure } from './parts.tsx';
import { RealmFrame } from './realm-frame.tsx';
import { QueueView } from './queue-view.tsx';

const recorded: Recorded = { commits: [] };
const reset = () => { recorded.commits.length = 0; };
const chinese = { ...messages, ...zhHans };

const meta = {
  title: 'Manage/Queue',
  component: QueueView,
  parameters: { route: { pathname: `/en/manage/r/${realm}` } },
  args: { realm, actingSubject: acting.iri, view: { state: 'open', type: null }, initial: queuePage, agents, works, now,
    locale: 'en', messages, api: queueApi({ recorded }), undoWindowMs: 400 },
  render: (args: ComponentProps<typeof QueueView>) => <RealmFrame realm={realm} header={header} agent={acting}
    locale={args.locale} messages={args.messages}><QueueView {...args} /></RealmFrame>,
} satisfies Meta<typeof QueueView>;
export default meta;
type Story = StoryObj<typeof meta>;

const list = (canvas: ReturnType<typeof within>) => canvas.getByRole('list', { name: 'Queue items' });
const detailTitle = (canvas: ReturnType<typeof within>) => canvas.getAllByRole('heading', { level: 3 })
  .find((heading: HTMLElement) => heading.id.startsWith('queue-detail-') && heading.checkVisibility())!;

/** j/k move through one list of reports, submissions and corrections; a approves with an undo window. */
export const KeyboardTriage: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('Classic Literature');
    await expect(canvas.getByRole('region', { name: 'Acting as' })).toHaveTextContent('Daniel Chen 陈丹尼');
    await expect(within(list(canvas)).getAllByRole('listitem')).toHaveLength(queue.length);
    await expect(detailTitle(canvas)).toHaveTextContent('Pride and Prejudice');
    await userEvent.keyboard('j');
    await expect(detailTitle(canvas)).toHaveTextContent('西游记');
    await expect(document.activeElement).toHaveAttribute('aria-current', 'true');
    await expect(await canvas.findByText(/话表美猴王得了姓名/)).toHaveAttribute('lang', 'zh-Hans');
    await userEvent.keyboard('a');
    const pending = canvas.getByRole('status', { name: 'Decisions you can still undo' });
    await expect(pending).toHaveTextContent('Approved “西游记”');
    await expect(within(list(canvas)).getAllByRole('listitem')).toHaveLength(queue.length - 1);
    await expect(detailTitle(canvas)).toHaveTextContent('Jane Eyre');
    // Undo inside the window: nothing reaches Main and the item comes back as current.
    await userEvent.keyboard('z');
    await expect(within(list(canvas)).getAllByRole('listitem')).toHaveLength(queue.length);
    await expect(detailTitle(canvas)).toHaveTextContent('西游记');
    await new Promise(done => setTimeout(done, 600));
    await expect(recorded.commits).toEqual([]);
    await userEvent.keyboard('a');
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ id: queue[1]!.id, action: 'approve',
      key: expect.stringMatching(new RegExp(`:${queue[1]!.id}$`)) })]));
    await waitFor(() => expect(canvas.queryByRole('status', { name: 'Decisions you can still undo' })).toBeNull());
  },
};

/** Rejection asks for the reason the author sees, then waits out the undo window. */
export const RejectWithReason: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(within(list(canvas)).getByRole('button', { name: /Frankenstein/ }));
    await userEvent.keyboard('r');
    const dialog = within(await within(document.body).findByRole('dialog', { name: 'Reject this submission' }, { timeout: 5000 }));
    await userEvent.click(dialog.getByRole('button', { name: 'Reject' }));
    await expect(dialog.getByText('Write a reason first.')).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason the author sees' }),
      'Please say which translation this chapter comes from.');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Private note for moderators' }), 'Third unattributed upload.');
    await userEvent.click(dialog.getByRole('button', { name: 'Reject' }));
    await expect(canvas.getByRole('status', { name: 'Decisions you can still undo' })).toHaveTextContent('Rejected');
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'reject',
      reason: 'Please say which translation this chapter comes from.' })]));
  },
};

/** Reports can be escalated; keeping or removing their content waits for Main's case basis. */
export const EscalateReport: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/can’t be done here yet/)).toBeVisible();
    await userEvent.keyboard('a');
    await expect(canvas.getByText('“Approve” isn’t available for this item.')).toBeVisible();
    await userEvent.keyboard('e');
    const dialog = within(await within(document.body).findByRole('dialog', { name: 'Escalate to the Realm owners' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'What should the owners look at?' }),
      'Edition question needs an owner decision.');
    await userEvent.click(dialog.getByRole('button', { name: 'Escalate' }));
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ id: queue[0]!.id, action: 'escalate' })]));
  },
};

/** Selecting several submissions applies one decision to each, with its own key. */
export const BulkApprove: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select 西游记' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /Select Frankenstein/ }));
    const bulk = canvas.getByRole('group', { name: 'Selected items' });
    await expect(bulk).toHaveTextContent('2 selected');
    await userEvent.click(within(bulk).getByRole('button', { name: 'Approve' }));
    await expect(canvas.getByRole('status', { name: 'Decisions you can still undo' })).toHaveTextContent('Approved 2 items');
    await waitFor(() => expect(recorded.commits).toHaveLength(2));
    await expect(new Set(recorded.commits.map(commit => commit.key)).size).toBe(2);
  },
};

/** Another moderator decided first: the refusal is not an error, it says what happened. */
export const AnotherModeratorFirst: Story = {
  args: { api: queueApi({ recorded, stale: [queue[1]!.id], reload: queue.filter(item => item !== queue[1]) }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.keyboard('ja');
    await expect(await canvas.findByText('Another moderator already decided “西游记”.', {}, { timeout: 3000 })).toBeVisible();
    await expect(within(list(canvas)).queryByRole('button', { name: /西游记/ })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    await expect(canvas.queryByText(/already decided/)).toBeNull();
  },
};

export const KeyboardHelp: Story = {
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: /Keyboard shortcuts/ }))
      .toHaveAttribute('aria-keyshortcuts', '?');
    await userEvent.keyboard('?');
    const dialog = within(await within(document.body).findByRole('dialog', { name: 'Keyboard shortcuts' }, { timeout: 5000 }));
    await expect(dialog.getByText('Undo the last decision')).toBeInTheDocument();
  },
};

export const AllCaughtUp: Story = {
  args: { initial: { ...queuePage, items: [] } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'All caught up' })).toBeVisible();
  },
};

export const Decided: Story = {
  args: { view: { state: 'closed', type: null }, initial: decidedPage },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Decided' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.queryByRole('checkbox')).toBeNull();
    await expect(within(list(canvas)).getAllByRole('listitem')[0]).toHaveTextContent('Accepted');
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: chinese },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}` } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: '领域管理' })).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: '待办' })).toHaveAttribute('href', `/zh-Hans/manage/r/${realm}`);
    await expect(canvas.getByText(/7 项待处理/)).toBeInTheDocument();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(within(list(canvas)).getByRole('button', { name: /西游记/ }));
    await expect(within(list(canvas)).getByRole('group', { name: 'Decision' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NotAModerator: Story = {
  render: args => <RealmFrame realm={realm} header={header} agent={acting} locale={args.locale} messages={args.messages}>
    <ManageFailure failure="denied" locale={args.locale} messages={args.messages} /></RealmFrame>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'You can’t manage this part of the Realm' })).toBeVisible();
  },
};
