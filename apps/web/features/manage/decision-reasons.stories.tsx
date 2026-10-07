import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, basisFor, header, names, now, publishedRules, queueApi, queuePage, realm, type Recorded } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { reasonMemoryKey, type ReportAction } from './reason-presets.ts';
import { QueueView } from './queue-view.tsx';
import { RealmFrame } from './realm-frame.tsx';

// Every report decision asks for a structured reason, keep included: the
// reasons on offer, the statement the affected people will read, and the keys
// that send it. Each decision is shown at phone and desktop width.

const recorded: Recorded = { commits: [] };
const reset = () => {
  recorded.commits.length = 0;
  for (const action of ['keep', 'remove', 'interim-restrict', 'final-restrict'] as const) {
    localStorage.removeItem(reasonMemoryKey(realm, action));
  }
};

const meta = {
  title: 'Manage/Decision reasons',
  component: QueueView,
  parameters: { route: { pathname: `/en/manage/r/${realm}` } },
  args: { realm, actingSubject: acting.iri, view: { state: 'open', type: null }, initial: queuePage, names, now,
    realmRules: publishedRules(), locale: 'en', messages, api: queueApi({ recorded }), undoWindowMs: 400 },
  render: (args: ComponentProps<typeof QueueView>) => <RealmFrame realm={realm} header={header} agent={acting}
    locale={args.locale} messages={args.messages}><QueueView {...args} /></RealmFrame>,
} satisfies Meta<typeof QueueView>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = () => within(document.body);
const list = (canvas: ReturnType<typeof within>) => canvas.getByRole('list', { name: 'Queue items' });
const dialogNamed = async (name: string) => within(await body().findByRole('dialog', { name }, { timeout: 5000 }));

/** Dialog text is not visible until its open animation has run. */
const visible = (find: () => HTMLElement) => waitFor(() => expect(find()).toBeVisible());

/** The dialog hands focus to the reasons, so a number key picks one. */
async function reasonsFocused(dialog: ReturnType<typeof within>) {
  await waitFor(() => expect(dialog.getByRole('radiogroup').contains(document.activeElement)).toBe(true));
}

const phone = { viewport: { value: 'phone' } } as const;
const desktop = { viewport: { value: 'desktop' } } as const;

/** One decision's dialog: its reasons, the statement for the first, and what sending records. */
function decision(options: { title: string; row?: RegExp; key: string; action: ReportAction; about: string;
  first: string; facts: string; scope: string; duration: string; outcome: string }): Pick<Story, 'play'> {
  return {
    async play({ canvasElement }) {
      reset();
      const canvas = within(canvasElement);
      if (options.row) await userEvent.click(within(list(canvas)).getByRole('button', { name: options.row }));
      await userEvent.keyboard(options.key);
      const dialog = await dialogNamed(options.title);
      await reasonsFocused(dialog);
      await expect(dialog.getByRole('radio', { name: new RegExp(options.first) })).toBeChecked();
      const preview = within(dialog.getByRole('region', { name: 'As the affected person will read it' }));
      for (const words of [options.facts, options.scope, options.duration, 'Written in English', `About: ${options.about}`,
        `Decided under the Realm’s published rules (urn:rezics:realm-rules:${realm}, revision 3).`,
        'No automation was involved']) {
        await visible(() => preview.getByText(words));
      }
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      await userEvent.keyboard('{Enter}');
      await expect(canvas.getByRole('status', { name: 'Decisions you can still undo' })).toHaveTextContent(options.outcome);
      await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: options.action,
        note: null, reasons: { facts: options.facts, scope: options.scope, duration: options.duration, automation: false,
          appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' } })]));
    },
  };
}

const keep = decision({ title: 'Keep reported content', key: 'a', action: 'keep', about: 'Pride and Prejudice · Title', first: 'It follows the rules',
  facts: 'We reviewed the report and found that this content follows the Realm’s rules.',
  scope: 'Nothing was changed. The content stays as it is.', duration: 'Not applicable. No restriction applies.',
  outcome: 'Kept' });
const remove = decision({ title: 'Remove reported content', row: /第一章 雨夜/, key: 'r', action: 'remove', about: '第一章 雨夜 · 雨夜书店 · 连载小说 · Text',
  first: 'Spam or advertising', facts: 'This content is spam or advertising that does not belong in this Realm. Rule 1: “Mark spoilers”.',
  scope: 'The reported part of the content is hidden from readers.',
  duration: 'Until an authorized moderator changes or reverses this decision.', outcome: 'Removed' });
const interim = decision({ title: 'Restrict content while the complaint is open', row: /Sherlock Holmes/, key: 'i',
  action: 'interim-restrict', about: 'The Adventures of Sherlock Holmes · Title', first: 'Credible rights claim',
  facts: 'A rights complaint about this content looks credible, so the content is restricted as a precaution while the complaint is reviewed.',
  scope: 'The reported content is hidden from readers as a temporary precaution while the complaint is reviewed.',
  duration: 'Until an authorized moderator changes or reverses this decision.', outcome: 'Restricted' });
const final = decision({ title: 'Restrict content after the complaint', row: /Sherlock Holmes/, key: 'f',
  action: 'final-restrict', about: 'The Adventures of Sherlock Holmes · Title', first: 'Claim upheld', facts: 'The rights complaint was reviewed and upheld.',
  scope: 'The reported content is hidden from readers.',
  duration: 'Until an authorized moderator changes or reverses this decision.', outcome: 'Restricted' });

/** A then Enter keeps a report with the first reason: two keystrokes. */
export const KeepDesktop: Story = { ...keep, globals: desktop };
export const KeepPhone: Story = { ...keep, globals: phone };
/** The report names a Realm rule, so the statement cites it. */
export const RemoveDesktop: Story = { ...remove, globals: desktop };
export const RemovePhone: Story = { ...remove, globals: phone };
export const InterimRestrictDesktop: Story = { ...interim, globals: desktop };
export const InterimRestrictPhone: Story = { ...interim, globals: phone };
export const FinalRestrictDesktop: Story = { ...final, globals: desktop };
export const FinalRestrictPhone: Story = { ...final, globals: phone };

/** A reason's number picks it, the private note stays off the statement, and the next decision starts from the same reason. */
export const NumberKeyNoteAndMemory: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.keyboard('a');
    let dialog = await dialogNamed('Keep reported content');
    await reasonsFocused(dialog);
    await userEvent.keyboard('2');
    await expect(dialog.getByRole('radio', { name: /Not enough to act on/ })).toBeChecked();
    await visible(() => dialog.getByText(/did not give enough information/));
    const note = dialog.getByRole('textbox', { name: 'Private note for moderators' });
    await userEvent.type(note, 'Reporter gave no edition.{Control>}{Enter}{/Control}');
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'keep',
      note: 'Reporter gave no edition.', details: null })]));
    await waitFor(() => expect(canvas.queryByRole('status', { name: 'Decisions you can still undo' })).toBeNull());
    await userEvent.click(within(list(canvas)).getByRole('button', { name: /Little Women/ }));
    await userEvent.keyboard('a');
    dialog = await dialogNamed('Keep reported content');
    await expect(dialog.getByRole('radio', { name: /Not enough to act on/ })).toBeChecked();
    await expect(dialog.getByText(/Picked as last time/)).toBeInTheDocument();
  },
};

/** What no preset says is the moderator's own words, sent as the facts; empty is refused. */
export const OwnExplanation: Story = {
  globals: desktop,
  async play() {
    reset();
    await userEvent.keyboard('r');
    const dialog = await dialogNamed('Remove reported content');
    await reasonsFocused(dialog);
    await userEvent.keyboard('6');
    await expect(dialog.getByRole('radio', { name: 'Something else' })).toBeChecked();
    const own = await dialog.findByRole('textbox', { name: 'Your explanation' });
    await waitFor(() => expect(own).toHaveFocus());
    await expect(dialog.getAllByText('Nothing yet.')).toHaveLength(3);
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await visible(() => dialog.getByText('Write your explanation first.'));
    await expect(recorded.commits).toEqual([]);
    await userEvent.type(own, 'The upload reproduces a paid translation.');
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'remove',
      details: 'The upload reproduces a paid translation.', note: null,
      reasons: expect.objectContaining({ facts: 'The upload reproduces a paid translation.',
        scope: 'The reported part of the content is hidden from readers.' }) })]));
  },
};

/** A preset takes the moderator's case-specific facts after it; the generic rule-breach reason needs them. */
export const DetailsAfterReason: Story = {
  globals: desktop,
  async play() {
    reset();
    await userEvent.keyboard('r');
    const dialog = await dialogNamed('Remove reported content');
    await reasonsFocused(dialog);
    await userEvent.keyboard('5');
    await expect(dialog.getByRole('radio', { name: 'Breaks a Realm rule' })).toBeChecked();
    const details = await dialog.findByRole('textbox', { name: 'Details for the affected people' });
    await waitFor(() => expect(details).toHaveFocus());
    await visible(() => dialog.getByText(/Required for this reason/));
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await visible(() => dialog.getByText('Add the details for this reason first.'));
    await expect(recorded.commits).toEqual([]);
    await userEvent.type(details, 'The second paragraph copies a paid translation.');
    await visible(() => dialog.getByText(/This content breaks one of the Realm’s rules\. The second paragraph copies a paid translation\./));
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'remove',
      details: 'The second paragraph copies a paid translation.', note: null,
      reasons: expect.objectContaining({
        facts: 'This content breaks one of the Realm’s rules. The second paragraph copies a paid translation.' }) })]));
  },
};

/** Details are optional on a specific reason, and the preview shows exactly what will be sent. */
export const OptionalDetails: Story = {
  globals: phone,
  async play() {
    reset();
    await userEvent.keyboard('a');
    const dialog = await dialogNamed('Keep reported content');
    await reasonsFocused(dialog);
    await visible(() => dialog.getByText(/Optional\. Add what applies in this case/));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Details for the affected people' }),
      'The 1894 text is a recognised edition.');
    await visible(() => dialog.getByText('We reviewed the report and found that this content follows the Realm’s rules. The 1894 text is a recognised edition.'));
    await userEvent.click(dialog.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'keep',
      details: 'The 1894 text is a recognised edition.', note: null,
      reasons: expect.objectContaining({
        facts: 'We reviewed the report and found that this content follows the Realm’s rules. The 1894 text is a recognised edition.' }) })]));
  },
};

/** Evidence that records automation is shown as it is, and the statement sent says so. */
export const AutomationInvolved: Story = {
  globals: desktop,
  args: { api: { ...queueApi({ recorded }), basis: async item => {
    const basis = basisFor(item);
    return { ok: true, data: { ...basis, reports: basis.reports.map(report => ({ ...report,
      evidence: report.evidence.map(entry => ({ ...entry, provenance: { automation: 'local-image-screen' } })) })) } };
  } } },
  async play() {
    reset();
    await userEvent.keyboard('a');
    const dialog = await dialogNamed('Keep reported content');
    await reasonsFocused(dialog);
    await visible(() => dialog.getByText('Automation was involved'));
    await expect(dialog.queryByText('No automation was involved')).toBeNull();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'keep',
      reasons: expect.objectContaining({ automation: true }) })]));
  },
};

/** Several items: automation and published rules are checked per case when sent, and the preview says so. */
export const SeveralCases: Story = {
  globals: desktop,
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: /Select Pride and Prejudice/ }));
    await userEvent.click(canvas.getByRole('checkbox', { name: /Select Little Women/ }));
    const bulk = canvas.getByRole('group', { name: 'Selected items' });
    await userEvent.click(within(bulk).getByRole('button', { name: 'Keep' }));
    const dialog = await dialogNamed('Keep content from 2 reports');
    await visible(() => dialog.getByText('Each case’s statement says, as it is sent, whether that case’s evidence records automation.'));
    await expect(dialog.queryByText(/^About:/)).toBeNull();
  },
};

/** The statement is written in the moderator's language, and says so. */
export const SimplifiedChinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { ...desktop, locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}` } },
  async play() {
    reset();
    await userEvent.keyboard('a');
    const dialog = await dialogNamed('保留 1 条举报中的内容');
    await reasonsFocused(dialog);
    await visible(() => dialog.getByText('我们审核了这条举报，认为该内容符合领域规则。'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(recorded.commits).toEqual([expect.objectContaining({ action: 'keep',
      reasons: expect.objectContaining({ contentLanguage: 'zh-Hans', facts: '我们审核了这条举报，认为该内容符合领域规则。' }) })]));
  },
};
