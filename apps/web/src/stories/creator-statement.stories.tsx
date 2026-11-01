import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  creatorStatementFixture,
  historicalCreatorStatementFixture,
  paidCreatorStatementFixture,
  selectCreatorStatementStory,
  type CreatorStatementStory,
} from '../kernel/fake/creator-statements';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Commerce/Creator Statement',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(state: CreatorStatementStory, id = creatorStatementFixture.id) {
  selectCreatorStatementStory(state);
  return <PageStory visitor="Signed In" path={`/creator/statements/${id}`} />;
}

export const Creator: Story = {
  render: () => render('creator'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(view.getByRole('button', { name: m.statements_line_source_details() }));
    await expect(await view.findByText('txn_creatorCharge')).toBeVisible();
    await expect(
      view.getByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(-3.15)),
    ).toBeVisible();
    const disclosure = view.getByText(m.statements_provenance(), { exact: true });
    disclosure.focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.getByText(creatorStatementFixture.weightedNetMinor, { exact: true })).toBeVisible();
  },
};
export const NegativeAdjustment: Story = {
  render: () => render('creator'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(await view.findByRole('link', { name: m.statements_next_lines() }));
    await view.findByText('txn_creatorRefund');
    await userEvent.click(view.getByRole('button', { name: m.statements_line_source_details() }));
    await expect(await view.findByText('txn_creatorRefund')).toBeVisible();
    await expect(view.getByRole('heading', { name: m.statements_refund() })).toBeVisible();
    await expect(
      view.getAllByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(-11))[0],
    ).toBeVisible();
    await userEvent.click(view.getByRole('link', { name: m.statements_restart_lines() }));
    await view.findByText('txn_creatorCharge');
    await userEvent.click(view.getByRole('button', { name: m.statements_line_source_details() }));
    await expect(await view.findByText('txn_creatorCharge')).toBeVisible();
  },
};
export const ExternalPayment: Story = {
  render: () => render('creator', paidCreatorStatementFixture.id),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(await view.findByText(paidCreatorStatementFixture.paidReference!)).toBeVisible();
    await expect(view.getByText(m.statements_payment_meaning())).toBeVisible();
  },
};
export const UnknownHistoricalMoney: Story = {
  render: () => render('unknown-unit', historicalCreatorStatementFixture.id),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect((await view.findAllByText(m.statements_amount_unavailable()))[0]).toBeVisible();
    await expect(view.getByText(historicalCreatorStatementFixture.paidReference!)).toBeVisible();
  },
};
function stateReady(label: () => string) {
  return async (context: { canvasElement: HTMLElement }) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(label(), { exact: true })).toBeVisible();
  };
}
export const Empty: Story = { render: () => render('empty'), play: stateReady(m.statements_lines_empty) };
export const Denied: Story = { render: () => render('denied'), play: stateReady(m.statements_denied) };
export const Unavailable: Story = { render: () => render('unavailable'), play: stateReady(m.statements_unavailable) };
export const LinesUnavailable: Story = {
  render: () => render('lines-unavailable'),
  play: stateReady(m.statements_unavailable),
};
export const Stale: Story = { render: () => render('stale'), play: stateReady(m.statements_stale) };
