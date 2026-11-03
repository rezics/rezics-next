import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CreatorSalesPage } from '../checkout/creator-sales-page';
import { creatorSaleFixture, creatorSalesStoryPage, type CreatorSalesStory } from '../kernel/fake/creator-sales';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory, pageReady } from './page';

const meta = {
  title: 'Pages/Commerce/Creator Sales',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Named Sales outcomes are constructed presentation examples in the shared app shell. They do not admit native producer data, change actor identity or rewrite the current reader. ActualRoute mounts the served path; positive available-route provenance remains unmeasured until Commerce supplies an admitted producer-owned response.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(state: CreatorSalesStory) {
  return (
    <PatternStory visitor="Signed In" path="/creator/sales">
      <AppShell>
        <CreatorSalesPage
          page={creatorSalesStoryPage(state)}
          locale={getLocale()}
          {...(state === 'second-page' ? { cursor: 'story-signed-current' } : {})}
        />
      </AppShell>
    </PatternStory>
  );
}

async function salesMain(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole('main'));
}

export const History: Story = {
  render: () => render('history'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByRole('heading', { level: 1, name: m.creator_sales_heading() })).toBeVisible();
    await expect(view.getByText(m.creator_sales_paid(), { exact: true })).toBeVisible();
    await expect(view.getByRole('link', { name: m.statements_heading() })).toHaveAttribute(
      'href',
      `/${getLocale()}/creator/statements`,
    );
    await expect(view.getByRole('link', { name: m.creator_sales_next() })).toHaveAttribute(
      'href',
      expect.stringContaining('cursor=story-signed%2Bnext%2F%3D'),
    );
    await expect(canvasElement.querySelector('a[href*="/orders/"]')).toBeNull();
  },
};
export const SecondPage: Story = {
  render: () => render('second-page'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByRole('link', { name: m.creator_sales_restart() })).toHaveAttribute(
      'href',
      `/${getLocale()}/creator/sales`,
    );
    await expect(view.queryByRole('link', { name: m.creator_sales_next() })).toBeNull();
    await expect(canvasElement.querySelector('a[href*="/orders/"]')).toBeNull();
  },
};
export const Empty: Story = {
  render: () => render('empty'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByText(m.creator_sales_empty())).toBeVisible();
    await expect(view.queryByText(m.creator_sales_preparing())).toBeNull();
  },
};
export const Denied: Story = {
  render: () => render('denied'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByRole('heading', { level: 1, name: m.creator_sales_heading() })).toBeVisible();
    await expect(view.getByText(m.creator_sales_denied())).toBeVisible();
    await expect(view.getByRole('link', { name: m.statements_retry() })).toBeVisible();
  },
};
export const Unavailable: Story = { render: () => render('unavailable') };
export const Error: Story = { render: () => render('error') };
export const Stale: Story = { render: () => render('stale') };
export const Loading: Story = { render: () => render('loading') };
export const Preparing: Story = {
  render: () => render('preparing'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByText(m.creator_sales_preparing())).toBeVisible();
    await expect(view.queryByText(m.creator_sales_empty())).toBeNull();
  },
};
export const Incomplete: Story = {
  render: () => render('incomplete'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByText(m.creator_sales_preparing())).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: creatorSaleFixture.title })).toBeVisible();
    await expect(view.queryByText(m.creator_sales_empty())).toBeNull();
    await expect(view.getByRole('link', { name: m.creator_sales_next() })).toHaveAttribute(
      'href',
      expect.stringContaining('cursor=story-signed%2Bnext%2F%3D'),
    );
  },
};
export const UnknownUnit: Story = {
  render: () => render('unknown-unit'),
  play: async ({ canvasElement }) => {
    const view = await salesMain(canvasElement);
    await expect(view.getByText(m.statements_amount_unavailable())).toBeVisible();
    await expect(view.getByText(m.commerce_tax_unknown())).toBeVisible();
    await expect(canvasElement.querySelector('a[href*="/orders/"]')).toBeNull();
  },
};
export const LongTitle: Story = {
  render: () => render('long-title'),
  play: async ({ canvasElement }) => {
    const page = creatorSalesStoryPage('long-title');
    if (page.kind !== 'ready') throw new globalThis.Error('Expected illustrative sales');
    const view = await salesMain(canvasElement);
    await expect(view.getByRole('heading', { level: 1, name: m.creator_sales_heading() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: page.sales[0]!.title })).toBeVisible();
    await expect(canvasElement.querySelector('a[href*="/orders/"]')).toBeNull();
  },
};
export const OtherCreatorSameRoute: Story = { render: () => render('other-creator') };
export const OtherCreatorDenied: Story = { render: () => render('denied') };
export const ActualRoute: Story = {
  render: () => <PageStory visitor="Signed In" path="/creator/sales" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(m.creator_sales_unavailable())).toBeVisible();
  },
};
