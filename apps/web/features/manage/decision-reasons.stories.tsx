import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, header, names, now, publishedRules, queueApi, queuePage, realm, type Recorded } from './fixtures.ts';
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
function decision(options: { title: string; row?: RegExp; key: string; action: ReportAction;
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
      for (const words of [options.facts, options.scope, options.duration, 'Written in English']) {
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

const keep = decision({ title: 'Keep reported content', key: 'a', action: 'keep', first: 'It follows the rules',
  facts: 'We reviewed the report and found that this content follows the Realm’s rules.',
  scope: 'Nothing was changed. The content stays as it is.', duration: 'Not applicable. No restriction applies.',
  outcome: 'Kept' });
const remove = decision({ title: 'Remove reported content', row: /第一章 雨夜/, key: 'r', action: 'remove',
  first: 'Spam or advertising', facts: 'This content is spam or advertising that does not belong in this Realm. Rule 1: “Mark spoilers”.',
  scope: 'The reported part of the content is hidden from readers.',
  duration: 'Until the author fixes the content or a moderator restores it.', outcome: 'Removed' });
const interim = decision({ title: 'Restrict content while the complaint is open', row: /Sherlock Holmes/, key: 'i',
  action: 'interim-restrict', first: 'Credible rights claim',
  facts: 'A rights complaint about this content looks credible, so the content is restricted while the complaint is reviewed.',
  scope: 'The reported content is hidden from readers while the complaint is open.',
  duration: 'Until the complaint is decided.', outcome: 'Restricted' });
const final = decision({ title: 'Restrict content after the complaint', row: /Sherlock Holmes/, key: 'f',
  action: 'final-restrict', first: 'Claim upheld', facts: 'The rights complaint was reviewed and upheld.',
  scope: 'The reported content is hidden from readers.',
  duration: 'Until the complaint is withdrawn or a moderator restores it.', outcome: 'Restricted' });

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

/** A reason's number picks it, the private note goes to the rationale, and the next decision starts from the same reason. */
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
      note: 'Reporter gave no edition.' })]));
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
      reasons: expect.objectContaining({ facts: 'The upload reproduces a paid translation.',
        scope: 'The reported part of the content is hidden from readers.' }) })]));
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
