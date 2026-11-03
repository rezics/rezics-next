import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreatorStatementPage } from '../checkout/creator-statement-page';
import {
  creatorLineFixture,
  creatorStatementFixture,
  historicalCreatorStatementFixture,
  paidCreatorStatementFixture,
  selectCreatorStatementStory,
  type CreatorStatementStory,
} from '../kernel/fake/creator-statements';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory, pageReady } from './page';

const meta = {
  title: 'Pages/Commerce/Creator Statement',
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
        component:
          'Shared item frames retain full ledger definition lists and independent source disclosures. Route stories use the existing illustrative transport; Narrow long text supplies the same page with long retained references. All cases are UNRUN for this slice; native, browser and visual acceptance remain deferred.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(state: CreatorStatementStory, id = creatorStatementFixture.id, search = '') {
  selectCreatorStatementStory(state);
  return <PageStory visitor="Signed In" path={`/creator/statements/${id}${search}`} />;
}

const laterLineSearch = '?cursor=story-lines-next&from=story-statements-next';

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

const longTransaction =
  'txn_creatorCharge_retained_provider_reference_with_a_long_unbroken_source_identifier_20260930233000';
const longPaymentReference =
  'External bank reference for the September royalty statement / retained-reference-202609-USD-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export const NarrowLongText: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => (
    <PatternStory visitor="Signed In" path={`/creator/statements/${paidCreatorStatementFixture.id}`}>
      <AppShell>
        <CreatorStatementPage
          id={paidCreatorStatementFixture.id}
          locale={getLocale()}
          cursor="story-lines-current+/="
          from="story-statements-from+/="
          page={{
            kind: 'ready',
            statement: { ...paidCreatorStatementFixture, paidReference: longPaymentReference },
            lines: {
              kind: 'ready',
              lines: [
                {
                  ...creatorLineFixture,
                  statementId: paidCreatorStatementFixture.id,
                  period: paidCreatorStatementFixture.period,
                  recordedAt: '2026-09-30T23:31:00Z',
                  balanceTransactionId: longTransaction,
                },
                {
                  ...creatorLineFixture,
                  statementId: paidCreatorStatementFixture.id,
                  period: paidCreatorStatementFixture.period,
                  recordedAt: '2026-09-30T23:31:00Z',
                  balanceTransactionId: 'txn_creatorRefund',
                  kind: 'refund',
                  grossMinor: -1200,
                  taxMinor: -100,
                  feeMinor: 0,
                  netReceiptsMinor: -1100,
                },
              ],
              next: 'story-lines-next+/=',
            },
          }}
        />
      </AppShell>
    </PatternStory>
  ),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(view.getByText(longPaymentReference, { exact: true })).toBeVisible();
    await expect(view.getByRole('heading', { name: m.statements_charge() })).toBeVisible();
    await expect(view.getByRole('heading', { name: m.statements_refund() })).toBeVisible();
    const sources = view.getAllByRole('button', { name: m.statements_line_source_details() });
    sources[0]!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.getByText(longTransaction, { exact: true })).toBeVisible();
    await userEvent.click(sources[1]!);
    await expect(sources[0]!).toHaveAttribute('aria-expanded', 'true');
    await expect(sources[1]!).toHaveAttribute('aria-expanded', 'true');
    await expect(view.getByText('txn_creatorRefund', { exact: true })).toBeVisible();
    await expect(view.getByRole('link', { name: m.statements_restart_lines() })).toBeVisible();
    await expect(view.getByRole('link', { name: m.statements_next_lines() })).toBeVisible();
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
export const UnknownHistoricalMoneyPhone: Story = {
  ...UnknownHistoricalMoney,
  globals: { viewport: { value: 'phone390', isRotated: false } },
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
export const Error: Story = { render: () => render('error'), play: stateReady(m.statements_error) };
export const LinesUnavailable: Story = {
  render: () => render('lines-unavailable'),
  play: stateReady(m.statements_unavailable),
};
export const Stale: Story = { render: () => render('stale'), play: stateReady(m.statements_stale) };
export const LaterStaleLines: Story = {
  render: () => render('later-stale-lines', paidCreatorStatementFixture.id, laterLineSearch),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(await view.findByText(paidCreatorStatementFixture.paidReference!)).toBeVisible();
    await expect(view.getByText(m.statements_stale())).toBeVisible();
    await expect(
      view.getByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(6.75)),
    ).toBeVisible();
    const disclosure = view.getByText(m.statements_provenance(), { exact: true });
    disclosure.focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.getByText(paidCreatorStatementFixture.id, { exact: true })).toBeVisible();
    await userEvent.click(view.getByRole('link', { name: m.statements_restart_lines() }));
    await view.findByText('txn_creatorCharge');
    await expect(view.getByText(paidCreatorStatementFixture.paidReference!)).toBeVisible();
    await expect(view.queryByText(m.statements_stale())).not.toBeInTheDocument();
  },
};
export const LaterEmptyLines: Story = {
  render: () => render('later-empty-lines', paidCreatorStatementFixture.id, laterLineSearch),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(await view.findByText(paidCreatorStatementFixture.paidReference!)).toBeVisible();
    await expect(view.getByRole('heading', { name: m.statement_line_page_reader_page_empty() })).toBeVisible();
    await expect(view.getByRole('status')).toHaveTextContent(m.statements_lines_empty());
    await expect(
      view.queryByRole('heading', { name: m.statement_line_page_reader_first_empty() }),
    ).not.toBeInTheDocument();
    await expect(
      view.getByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(6.75)),
    ).toBeVisible();
    await userEvent.click(view.getByRole('link', { name: m.statements_restart_lines() }));
    await view.findByText('txn_creatorCharge');
    await expect(view.getByText(paidCreatorStatementFixture.paidReference!)).toBeVisible();
  },
};
