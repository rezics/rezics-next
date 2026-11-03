import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { selectCreatorStatementStory, type CreatorStatementStory } from '../kernel/fake/creator-statements';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Commerce/Creator Statements',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Constructed presentation responses for the actual creator statements route. They do not establish native authorization, payout, settlement or visual acceptance. Signed-in visitor, locale and theme remain the shared globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(state: CreatorStatementStory) {
  selectCreatorStatementStory(state);
  return <PageStory visitor="Signed In" path="/creator/statements" />;
}

export const Creator: Story = {
  render: () => render('creator'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(await view.findByRole('heading', { name: m.statements_heading() })).toBeVisible();
    await expect(
      await view.findByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(-3.15)),
    ).toBeVisible();
    await expect(
      view.getByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'EUR' }).format(6.75)),
    ).toBeVisible();
    await userEvent.click(view.getByRole('link', { name: m.statements_next() }));
    await expect(await view.findByText(m.statements_paid())).toBeVisible();
  },
};
export const InspectAndBack: Story = {
  render: () => render('creator'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(await view.findByRole('link', { name: m.statements_next() }));
    await userEvent.click(await view.findByRole('link', { name: /USD/ }));
    await expect(await view.findByRole('heading', { name: m.statements_detail_heading() })).toBeVisible();
    await userEvent.click(view.getByRole('link', { name: m.statements_back() }));
    await expect(await view.findByRole('heading', { name: m.statements_heading() })).toBeVisible();
    await expect(view.getByText(m.statements_paid())).toBeVisible();
  },
};
export const LaterEmpty: Story = {
  render: () => render('later-empty'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(await view.findByRole('heading', { name: m.statements_heading() })).toBeVisible();
    await expect(
      await view.findByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(-3.15)),
    ).toBeVisible();
    await expect(view.queryByText(m.statements_page_empty(), { exact: true })).toBeNull();
    await expect(view.queryByRole('link', { name: m.statements_restart() })).toBeNull();
    await userEvent.click(view.getByRole('link', { name: m.statements_next() }));
    await expect(await view.findByText(m.statements_page_empty(), { exact: true })).toBeVisible();
    await expect(view.queryByText(m.statements_empty(), { exact: true })).toBeNull();
    const restart = view.getByRole('link', { name: m.statements_restart() });
    await expect(restart).toHaveAttribute('href', `/${getLocale()}/creator/statements`);
    await expect(view.getByRole('link', { name: m.statements_next() })).toBeVisible();
    await userEvent.click(restart);
    await expect(
      await view.findByText(new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD' }).format(-3.15)),
    ).toBeVisible();
    await expect(view.queryByText(m.statements_page_empty(), { exact: true })).toBeNull();
    await expect(view.getByRole('link', { name: m.statements_next() })).toBeVisible();
  },
};
export const UnknownHistoricalMoney: Story = {
  render: () => render('unknown-unit'),
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(await view.findByText(m.statements_amount_unavailable())).toBeVisible();
    await expect(view.getByText(m.statements_paid())).toBeVisible();
  },
};
function stateReady(label: () => string) {
  return async (context: { canvasElement: HTMLElement }) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(label(), { exact: true })).toBeVisible();
  };
}
export const Empty: Story = { render: () => render('empty'), play: stateReady(m.statements_empty) };
export const Denied: Story = { render: () => render('denied'), play: stateReady(m.statements_denied) };
export const Unavailable: Story = { render: () => render('unavailable'), play: stateReady(m.statements_unavailable) };
export const Error: Story = { render: () => render('error'), play: stateReady(m.statements_error) };
export const Stale: Story = { render: () => render('stale'), play: stateReady(m.statements_stale) };
