import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CreatorSalesPage } from '../checkout/creator-sales-page';
import { creatorSalesStoryPage, type CreatorSalesStory } from '../kernel/fake/creator-sales';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = {
  title: 'Pages/Commerce/Creator Sales',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(state: CreatorSalesStory, width?: number) {
  return (
    <main className="min-h-screen min-w-0 bg-background p-4 sm:p-8" style={width ? { maxWidth: width } : undefined}>
      <CreatorSalesPage
        page={creatorSalesStoryPage(state)}
        locale={getLocale()}
        {...(state === 'second-page' ? { cursor: 'story-signed-current' } : {})}
      />
    </main>
  );
}

export const History: Story = {
  render: () => render('history'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.creator_sales_heading() })).toBeVisible();
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
export const SecondPage: Story = { render: () => render('second-page') };
export const Empty: Story = { render: () => render('empty') };
export const Denied: Story = { render: () => render('denied') };
export const Unavailable: Story = { render: () => render('unavailable') };
export const Error: Story = { render: () => render('error') };
export const Stale: Story = { render: () => render('stale') };
export const Loading: Story = { render: () => render('loading') };
export const Preparing: Story = {
  render: () => render('preparing'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.creator_sales_preparing())).toBeVisible();
    await expect(view.queryByText(m.creator_sales_empty())).toBeNull();
  },
};
export const Incomplete: Story = { render: () => render('incomplete') };
export const UnknownUnit: Story = { render: () => render('unknown-unit') };
export const LongTitle: Story = { render: () => render('long-title') };
export const OtherCreatorSameRoute: Story = { render: () => render('other-creator') };
export const OtherCreatorDenied: Story = { render: () => render('denied') };
export const Mobile390: Story = {
  render: () => render('long-title', 390),
  globals: { viewport: { value: 'phone390' } },
};
export const Desktop1280: Story = {
  render: () => render('history', 1280),
  globals: { viewport: { value: 'desktop1280' } },
};
// The real route deliberately stays unavailable until the native generated binding is delivered.
export const ActualRoute: Story = {
  render: () => <PageStory visitor="Signed In" path="/creator/sales" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByText(m.creator_sales_unavailable())).toBeVisible();
  },
};
