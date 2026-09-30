import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { agents, headerNow, ids, now, proposalApi, staleBase, target, views } from './fixtures.ts';
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
    // The API tells a proposer they cannot review their own correction; the page only shows it.
    await expect(canvas.getByText('You proposed this, so someone else has to review it.')).toBeVisible();
    await expect(canvas.getAllByRole('button').map(button => button.getAttribute('data-action')))
      .toEqual(['revise', 'withdraw']);
    await userEvent.click(canvas.getByRole('button', { name: 'Revise' }));
    const submit = await within(document.body).findByRole('button', { name: 'Submit revision' });
    await waitFor(() => expect(submit).toBeVisible());
  },
};

/** After an apply found the fact moved, a read says a revision is required; `stale_base` never appears on a read. */
export const RevisionRequired: Story = {
  args: { initial: views.revisionRequired, actingSubject: ids.member, api: proposalApi(views.revisionRequired) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Revise the correction first.')).toBeVisible();
    await expect(canvas.getByText(/Applying it found the fact had changed/)).toBeVisible();
    await expect(canvas.getByText('You proposed this, so someone else has to review it.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Revise' })).toBeVisible();
  },
};

/**
 * The owner refuses a revision written against a header that has moved. The page reads the header again and
 * carries only what this person changed onto it: the other language and the title someone else changed stay.
 */
export const RebasesOnRefusal: Story = {
  args: { initial: views.proposer, actingSubject: ids.member,
    api: proposalApi(views.proposer, { revise: [staleBase, { ok: true, data: { profile: 'editorial-command-v1',
      proposal: ids.proposal, revision: 3, outcome: 'revised', replayed: false } }],
    header: { state: headerNow, head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000402' }, next: views.revised }) },
  async play({ canvasElement, args }) {
    const api = args.api as ReturnType<typeof proposalApi>;
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Revise' }));
    const dialog = within(document.body);
    const synopsis = await dialog.findByRole('textbox', { name: 'Synopsis' });
    await userEvent.clear(synopsis);
    await userEvent.type(synopsis, '一間只在雨夜開門的書店。');
    await expect(synopsis).toHaveValue('一間只在雨夜開門的書店。');
    await userEvent.click(dialog.getByRole('button', { name: 'Submit revision' }));
    await expect(await dialog.findByText(/The fact changed since you started/)).toBeInTheDocument();
    // The title someone else changed is kept; this person's synopsis stands.
    await waitFor(() => expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('雨夜書店（修訂版）'));
    await expect(dialog.getByRole('textbox', { name: 'Synopsis' })).toHaveValue('一間只在雨夜開門的書店。');
    await userEvent.click(dialog.getByRole('button', { name: 'Submit revision' }));
    await waitFor(() => expect(api.revised).toHaveLength(2));
    const [first, second] = api.revised;
    await expect(first!.baseHeads[0]!.head).toBe('https://rezics.com/id/00000000-0000-4000-8000-000000000401');
    await expect(second!.baseHeads[0]!.head).toBe('https://rezics.com/id/00000000-0000-4000-8000-000000000402');
    const sent = JSON.stringify(second!.candidate);
    await expect(sent).toContain('A bookshop that opens only on rainy nights.');
    await expect(sent).not.toContain('A bookshop opens only when it rains.');
    await expect(sent).toContain('雨夜書店（修訂版）');
    await expect(sent).toContain('一間只在雨夜開門的書店。');
  },
};

/** The proposal is revised while a reviewer has the dialog open: nothing is sent for the revision they did not see. */
export const RevisedWhileOpen: Story = {
  args: { api: proposalApi(views.open, { reply: { ok: false, failure: 'stale', blocker: { code: 'stale_revision',
    latestRevision: 3 } }, afterRefusal: views.revised }) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Review' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Send' }));
    await expect(await canvas.findByText(/This correction was revised while you were looking/)).toBeInTheDocument();
    await expect(canvas.getByText('Revision 3, the latest')).toBeVisible();
    await waitFor(() => expect(within(document.body).queryByRole('button', { name: 'Send' })).toBeNull());
    await expect((args.api as ReturnType<typeof proposalApi>).sent.map(request => 'revision' in request && request.revision))
      .toEqual([2]);
  },
};

/** A refusal for lost authority reads the proposal again: the revoked controls disappear and the dialog closes. */
export const AuthorityRevoked: Story = {
  args: { api: proposalApi(views.open, { reply: { ok: false, failure: 'denied' }, afterRefusal: views.forbidden }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Reject' }));
    await userEvent.click(await within(document.body).findByRole('button', { name: 'Reject' }));
    await expect(await canvas.findByText(/You can’t do that here/)).toBeInTheDocument();
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-action]')).toHaveLength(0));
    await expect(canvas.getByText(/Only reviewers of this Work can review/)).toBeVisible();
  },
};

/** A revision replaces approvals of the one before it: Main counts them stale. */
export const StaleApproval: Story = {
  args: { initial: views.staleApproval, api: proposalApi(views.staleApproval) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('1 earlier approval no longer counts because the correction was revised.')).toBeVisible();
    await expect(canvas.getByText('This revision needs 1 approval. It has 0 so far.')).toBeVisible();
  },
};

/** After it is applied anyone with authority can revert, which opens a compensating proposal. */
export const Applied: Story = {
  args: { initial: views.applied, api: proposalApi(views.applied, { next: views.applied }) },
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
