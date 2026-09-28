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

/**
 * A report shows what each reporter wrote. A keeps its content (no reason
 * needed); R removes it, with a reason the reporter and the author see.
 */
export const KeepOrRemoveReport: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/the text is the 1894 illustrated one/)).toBeVisible();
    await expect(canvas.getAllByText('2 reports')[0]).toBeVisible();
    await expect(canvas.getAllByText('No details given.')[0]).toBeVisible();
    // Each action shows the key that does the same, readable on its filled button.
    const actions = within((await canvas.findAllByRole('group', { name: 'Decision' }))
      .find(group => group.checkVisibility())!);
    for (const [name, key] of [['Keep', 'A'], ['Remove', 'R']] as const) {
      const hint = actions.getByRole('button', { name: new RegExp(`^${name}`) }).querySelector('kbd')!;
      await expect(hint).toHaveTextContent(key);
      await expect(getComputedStyle(hint).color).toBe(getComputedStyle(hint.parentElement!).color);
    }
    // Works show their covers, never a monogram.
    const rows = list(canvas);
    await expect(rows.querySelectorAll('[data-slot="work-cover"]').length).toBeGreaterThan(0);
    await expect(within(rows).queryByText('PP')).toBeNull();
    await userEvent.keyboard('a');
    await expect(canvas.getByRole('status', { name: 'Decisions you can still undo' })).toHaveTextContent('Kept “Pride and Prejudice”');
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ id: queue[0]!.id, action: 'keep',
      reason: null })]));
    await userEvent.click(within(list(canvas)).getByRole('button', { name: /Little Women/ }));
    await expect((await canvas.findAllByText('The subtitle gives away the ending.'))[0]).toBeInTheDocument();
    await userEvent.keyboard('r');
    const dialog = within(await within(document.body).findByRole('dialog', { name: 'Remove reported content' }, { timeout: 5000 }));
    await expect(dialog.queryByRole('textbox', { name: 'Private note for moderators' })).toBeNull();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Why it’s removed' }), 'Rule 1: no spoilers in titles.');
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'keep' }),
      expect.objectContaining({ id: queue[5]!.id, action: 'remove', reason: 'Rule 1: no spoilers in titles.' })]));
  },
};

/** A moderator can hand a report to the owners with a note for them. */
export const EscalateReport: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.keyboard('e');
    const dialog = within(await within(document.body).findByRole('dialog', { name: 'Escalate to the Realm owners' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'What should the owners look at?' }),
      'Edition question needs an owner decision.');
    await userEvent.click(dialog.getByRole('button', { name: 'Escalate' }));
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ id: queue[0]!.id, action: 'escalate' })]));
  },
};

/** An owner is who escalations reach, so an owner decides instead. */
export const OwnerDecides: Story = {
  args: { authority: { decideReports: true, escalate: false } },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    const decision = await canvas.findAllByRole('group', { name: 'Decision' });
    const visible = decision.find(group => group.checkVisibility())!;
    await expect(within(visible).getByRole('button', { name: /Keep/ })).toBeVisible();
    await expect(within(visible).queryByRole('button', { name: /Escalate/ })).toBeNull();
    await expect(canvas.queryByText(/Escalate it so the Realm owners see it/)).toBeNull();
    await userEvent.keyboard('e');
    await expect(canvas.getByText('“Escalate” isn’t available for this item.')).toBeVisible();
    await userEvent.click(within(list(canvas)).getByRole('button', { name: /Sherlock Holmes/ }));
    const rights = (await canvas.findAllByRole('group', { name: 'Decision' })).find(group => group.checkVisibility())!;
    await expect(within(rights).getByRole('button', { name: 'Interim restriction' })).toBeVisible();
    await expect(within(rights).getByRole('button', { name: 'Final restriction' })).toBeVisible();
  },
};

/**
 * Keeping or removing cites the Realm's rules. Until they are published,
 * neither is offered, and the note says what to do and who can do it.
 */
export const RulesNotPublished: Story = {
  args: { api: queueApi({ recorded, rules: false }), rulesHref: `/manage/r/${realm}/settings` },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/hasn’t published any yet/)).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Publish them in Settings & rules' }))
      .toHaveAttribute('href', `/en/manage/r/${realm}/settings`);
    await userEvent.keyboard('a');
    await expect(canvas.getByText('“Keep” isn’t available for this item.')).toBeVisible();
    await expect(recorded.commits).toEqual([]);
  },
};

/** `/manage/r/fiction` works like `/r/fiction`: the Zone's segment stays in every link. */
export const BySlug: Story = {
  args: { address: 'fiction' },
  parameters: { route: { pathname: '/en/manage/r/fiction' } },
  render: (args: ComponentProps<typeof QueueView>) => <RealmFrame realm={realm} address="fiction" header={header}
    agent={acting} locale={args.locale} messages={args.messages}><QueueView {...args} /></RealmFrame>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Decided' })).toHaveAttribute('href', '/en/manage/r/fiction?state=closed');
    await expect(canvas.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/en/manage/r/fiction/members');
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
