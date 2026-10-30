import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CreatorOffersPage } from '../checkout/creator-offers-page';
import {
  creatorOffersStoryPage,
  creatorOfferFixture,
  delistedCreatorOfferFixture,
  type CreatorOffersStory,
} from '../kernel/fake/creator-offers';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Commerce/Creator offers',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function render(state: CreatorOffersStory) {
  return (
    <main className="min-h-screen min-w-0 bg-background p-4 sm:p-8">
      <CreatorOffersPage
        page={creatorOffersStoryPage(state)}
        locale={getLocale()}
        {...(state === 'second-page' ? { cursor: 'story-signed-cursor-placeholder' } : {})}
      />
    </main>
  );
}
export const History: Story = {
  render: () => render('history'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.creator_offers_heading() })).toBeVisible();
    await expect(view.getByRole('link', { name: creatorOfferFixture.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/offers/${creatorOfferFixture.id}`,
    );
    await expect(view.queryByRole('link', { name: delistedCreatorOfferFixture.title })).toBeNull();
    await expect(view.getByText(m.creator_offers_unknown())).toBeVisible();
    await expect(view.getByRole('link', { name: m.creator_offers_next() })).toHaveAttribute(
      'href',
      expect.stringContaining('cursor='),
    );
  },
};
export const SecondPage: Story = { render: () => render('second-page') };
export const Empty: Story = { render: () => render('empty') };
export const Denied: Story = { render: () => render('denied') };
export const Unavailable: Story = { render: () => render('unavailable') };
export const Error: Story = { render: () => render('error') };
export const Stale: Story = { render: () => render('stale') };
export const Preparing: Story = { render: () => render('preparing') };
export const LongTitle: Story = { render: () => render('long-title') };
