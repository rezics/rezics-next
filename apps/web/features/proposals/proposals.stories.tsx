import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { agents, ids, now, proposalApi, target, views } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHant from './messages/zh-Hant.ts';
import { ProposalPage } from './proposal-page.tsx';

const meta = {
  title: 'Proposals/Proposal',
  component: ProposalPage,
  parameters: { route: { pathname: `/en/proposals/${ids.proposal}` } },
  args: { initial: views.open, target, agents, actingSubject: ids.steward, now, locale: 'en', messages,
    api: proposalApi(views.open) },
  render: args => <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6"><ProposalPage {...args} /></div>,
} satisfies Meta<typeof ProposalPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A steward sees before and after, the evidence, the history and only the actions Main allows. */
export const Open: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '雨夜书店' })).toBeVisible();
    await expect(canvas.getByText('Open')).toBeVisible();
    await expect(canvas.getByText('一間只在下雨時開門的書店。')).toBeVisible();
    await expect(canvas.getByText('一間只在雨夜開門的書店，店主收集人們沒寄出的信。')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /example\.com\/books\/rainy-night/ })).toBeVisible();
    await expect(canvas.getByText('Please cite where the synopsis was printed.')).toBeVisible();
    // Exactly the allowed actions, and nothing else.
    const buttons = canvas.getAllByRole('button').map(button => button.getAttribute('data-action'));
    await expect(buttons).toEqual(['approve-and-apply', 'review', 'reject']);
  },
};

/** Requesting changes is one review, with a stance and the words the proposer will read. */
export const RequestChanges: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Review' }));
    const dialog = within(document.body);
    await userEvent.click(await dialog.findByRole('radio', { name: /Request changes/ }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Message' }), 'Add the page number.');
    await userEvent.click(dialog.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect((args.api as ReturnType<typeof proposalApi>).sent).toEqual([
      { kind: 'review', revision: 2, outcome: 'request_changes', message: 'Add the page number.' }]));
  },
};

/** The proposer revises or withdraws; the page offers nothing else. */
export const ChangesRequested: Story = {
  args: { initial: views.proposer, actingSubject: ids.member, api: proposalApi(views.proposer) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Changes requested')).toBeVisible();
    await expect(canvas.getAllByRole('button').map(button => button.getAttribute('data-action')))
      .toEqual(['revise', 'withdraw']);
    await userEvent.click(canvas.getByRole('button', { name: 'Revise' }));
    const submit = await within(document.body).findByRole('button', { name: 'Submit revision' });
    await waitFor(() => expect(submit).toBeVisible());
  },
};

/** The fact moved after the proposal was written: Main names it and the proposer rebases. */
export const StaleBase: Story = {
  args: { initial: views.staleBase, actingSubject: ids.member, api: proposalApi(views.staleBase) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/The fact changed after this was written/)).toBeVisible();
  },
};

/** A revision replaces approvals of the one before it: Main counts them stale. */
export const StaleApproval: Story = {
  args: { initial: views.staleApproval, api: proposalApi(views.staleApproval) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/1 earlier approvals no longer count/)).toBeVisible();
    await expect(canvas.getByText(/Needs 1 approvals of this revision; it has 0/)).toBeVisible();
  },
};

/** After it is applied anyone with authority can revert, which opens a compensating proposal. */
export const Applied: Story = {
  args: { initial: views.applied, api: proposalApi(views.applied, views.applied) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Applied', { selector: '[data-slot="badge"]' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Revert' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Open the reverting correction' }));
    await waitFor(() => expect((args.api as ReturnType<typeof proposalApi>).sent[0]?.kind).toBe('revert'));
    await expect(await canvas.findByRole('link', { name: 'Open it' })).toHaveAttribute('href',
      `/en/proposals/${ids.reverting}`);
  },
};

export const Reverted: Story = {
  args: { initial: views.reverted, api: proposalApi(views.reverted) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'an applied correction' })).toHaveAttribute('href',
      `/en/proposals/${ids.proposal}`);
    await expect(within(canvasElement).getByText('Nothing more is needed from you.')).toBeVisible();
  },
};

export const Withdrawn: Story = {
  args: { initial: views.withdrawn, actingSubject: ids.member, api: proposalApi(views.withdrawn) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Withdrawn', { selector: '[data-slot="badge"]' })).toBeVisible();
    await expect(within(canvasElement).queryAllByRole('button')).toHaveLength(0);
  },
};

/** A viewer without review authority sees why, and no control. */
export const Forbidden: Story = {
  args: { initial: views.forbidden, actingSubject: ids.other, api: proposalApi(views.forbidden) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/Only reviewers of this Work can review/)).toBeVisible();
    await expect(within(canvasElement).queryAllByRole('button')).toHaveLength(0);
  },
};

export const ApplyPending: Story = {
  args: { initial: views.pending, api: proposalApi(views.pending) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Check status' })).toBeVisible();
  },
};

/** A link names a revision that a later one replaced. */
export const OlderRevisionLink: Story = {
  args: { linkedRevision: 1 },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/This link names revision 1/)).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hant', messages: { ...messages, ...zhHant }, initial: views.proposer, actingSubject: ids.member,
    api: proposalApi(views.proposer) },
  globals: { locale: 'zh-Hant' },
  parameters: { route: { pathname: `/zh-Hant/proposals/${ids.proposal}` } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('需要修改', { selector: '[data-slot="badge"]' })).toBeVisible();
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const ChineseDarkPhone: Story = {
  args: Chinese.args,
  globals: { theme: 'dark', locale: 'zh-Hant', viewport: { value: 'phone' } },
  parameters: Chinese.parameters,
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
