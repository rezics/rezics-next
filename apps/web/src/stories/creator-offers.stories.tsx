import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreatorOffersPage } from '../checkout/creator-offers-page';
import { formatMinorAmount } from '../checkout/money';
import { recordedMoneyUnit } from '../checkout/money-schema';
import {
  creatorOffersStoryPage,
  creatorOfferFixture,
  delistedCreatorOfferFixture,
  setCreatorOffersStory,
  type CreatorOffersStory,
} from '../kernel/fake/creator-offers';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';

const meta = {
  title: 'Pages/Commerce/Creator offers',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'History and Long title enter the served route through the existing illustrative kernel transport. Other outcomes use the same page component and shared shell harness. These fixtures establish neither native availability nor visual acceptance.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function render(state: CreatorOffersStory) {
  if (state === 'history' || state === 'long-title') return <PageStory visitor="Signed In" path="/creator/offers" />;
  return (
    <PatternStory visitor="Signed In" path="/creator/offers">
      <AppShell>
        <CreatorOffersPage
          page={creatorOffersStoryPage(state)}
          locale={getLocale()}
          {...(state === 'second-page' ? { cursor: 'story-signed-cursor-placeholder' } : {})}
        />
      </AppShell>
    </PatternStory>
  );
}
export const History: Story = {
  render: () => render('history'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('heading', { name: m.creator_offers_heading() })).toBeVisible();
    await expect(await view.findByRole('link', { name: creatorOfferFixture.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/offers/${creatorOfferFixture.id}`,
    );
    const matchingTitles = await view.findAllByRole('heading', { name: creatorOfferFixture.title });
    await expect(matchingTitles).toHaveLength(2);
    const activeRow = matchingTitles[0]!.closest('li')!;
    const delistedRow = matchingTitles[1]!.closest('li')!;
    await expect(within(activeRow).getByText(m.creator_offers_active(), { exact: true })).toBeVisible();
    await expect(within(delistedRow).getByText(m.creator_offers_delisted(), { exact: true })).toBeVisible();
    await expect(within(delistedRow).queryByRole('link')).toBeNull();
    const activeDetails = within(activeRow).getByText(m.creator_offers_technical_details(), { exact: true });
    await userEvent.click(activeDetails);
    await expect(within(activeRow).getByText(creatorOfferFixture.id)).toBeVisible();
    await expect(within(activeRow).getByText(String(creatorOfferFixture.revision))).toBeVisible();
    const resource = creatorOfferFixture.contentEdition!.benefit.resource;
    await expect(within(activeRow).getByText(`${resource.route}/${resource.id}`)).toBeVisible();
    await expect(activeRow.querySelector('details')).not.toHaveAttribute('open');
    const delistedDetails = within(delistedRow).getByText(m.creator_offers_technical_details(), { exact: true });
    await userEvent.click(delistedDetails);
    await expect(within(delistedRow).getByText(delistedCreatorOfferFixture.id)).toBeVisible();
    await expect(within(delistedRow).getByText(String(delistedCreatorOfferFixture.revision))).toBeVisible();
    await expect(within(delistedRow).queryByText(m.creator_offers_edition_locator(), { exact: true })).toBeNull();
    await expect(view.getByText(m.creator_offers_unknown())).toBeVisible();
    await expect(view.getByRole('link', { name: m.creator_offers_next() })).toHaveAttribute(
      'href',
      expect.stringContaining('cursor='),
    );
  },
};
export const SecondPage: Story = {
  render: () => render('second-page'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('link', { name: m.creator_offers_restart() })).toHaveAttribute(
      'href',
      `/${getLocale()}/creator/offers`,
    );
    await expect(view.queryByRole('link', { name: m.creator_offers_next() })).toBeNull();
  },
};
export const Empty: Story = { render: () => render('empty') };
export const Denied: Story = { render: () => render('denied') };
export const Unavailable: Story = { render: () => render('unavailable') };
export const Error: Story = { render: () => render('error') };
export const Stale: Story = {
  render: () => render('stale'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('link', { name: m.creator_offers_restart() })).toHaveAttribute(
      'href',
      `/${getLocale()}/creator/offers`,
    );
    await expect(view.queryByRole('link', { name: m.creator_offers_next() })).toBeNull();
  },
};
export const Preparing: Story = { render: () => render('preparing') };
export const LongTitle: Story = {
  beforeEach: () => {
    setCreatorOffersStory('long-title');
    return () => setCreatorOffersStory();
  },
  render: () => render('long-title'),
  play: async ({ canvasElement }) => {
    const page = creatorOffersStoryPage('long-title');
    if (page.kind !== 'ready') throw new globalThis.Error('Expected illustrative offers');
    const offer = page.offers[0]!;
    const view = within(canvasElement);
    const link = await view.findByRole('link', { name: offer.title });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/offers/${offer.id}`);
    const row = link.closest('li')!;
    await expect(within(row).getByRole('heading', { name: offer.title })).toHaveClass('line-clamp-2');
    await expect(row).toHaveTextContent(
      formatMinorAmount(getLocale(), offer.currency, offer.unitAmountMinor, recordedMoneyUnit(offer))!,
    );
    await expect(within(row).getByText(m.creator_offers_active(), { exact: true })).toBeVisible();
    const summary = within(row).getByText(m.commerce_full_title(), { exact: true });
    await expect(row.querySelector('details')).not.toHaveAttribute('open');
    await userEvent.click(summary);
    await expect(row.querySelector('details')).toHaveAttribute('open');
    await expect(row.querySelector('details p')).toHaveTextContent(offer.title);
  },
};
