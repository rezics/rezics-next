import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { CreatorOffersPage } from '../checkout/creator-offers-page';
import type { CreatorOfferGuard, CreatorOffersPageData } from '../checkout/creator-offers';
import {
  configuredPriceExample,
  creatorOfferFixture,
  delistedCreatorOfferFixture,
} from '../kernel/fake/creator-offers';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

// Authored UNRUN. All states are explicit interface fixtures, without native availability claims.
const meta = {
  title: 'Commerce/Creator offer controls disclosure',
  id: 'patterns-commerce-creator-offer-controls-disclosure',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual offer-list component with illustrative recorded price facts and configured price rules. Normal and Draft cover independent controls; Long title management retains the supplied long title at every toolbar size. Unavailable rules retains honest unknown facts and delist access. Authority retired removes private controls. Pending, uncertain original requests and late completion are authored in creator-offer-controls-disclosure.test.tsx. Stories and tests are UNRUN; native, browser, accessibility and visual verification remain deferred.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Variant = 'normal' | 'long-title' | 'rules-unavailable' | 'unavailable' | 'retired';
const longTitle = 'A captured title / '.repeat(20) + '無空白の長い題名'.repeat(24);

function Example({ variant = 'normal' }: { variant?: Variant }) {
  const [retired, setRetired] = useState(variant === 'retired');
  const [authority] = useState(() => ({ current: variant !== 'retired' }));
  const [guard] = useState<CreatorOfferGuard>(() => ({
    isCurrent: () => authority.current,
    csrfToken: () => (authority.current ? 'illustrative-current-origin' : null),
  }));
  const offer = {
    ...creatorOfferFixture,
    ...(variant === 'long-title' ? { title: longTitle } : {}),
    ...(variant === 'rules-unavailable' ? { moneyUnit: null, taxBehavior: null, contentEdition: null } : {}),
  };
  const data: CreatorOffersPageData = {
    page: { kind: 'ready', offers: [offer, delistedCreatorOfferFixture], next: null },
    schema: variant === 'rules-unavailable' ? null : configuredPriceExample,
    selling: true,
    csrfToken: 'illustrative-loader-token',
    keys: {
      [offer.id]: {
        reprice: '019a2100-0000-7000-8000-000000000011',
        delist: '019a2100-0000-7000-8000-000000000012',
      },
    },
  };
  return (
    <PatternStory visitor="Signed In" path="/creator/offers">
      <AppShell>
        <div className="min-w-0 space-y-4">
          {variant !== 'unavailable' && !retired && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                authority.current = false;
                setRetired(true);
              }}
            >
              Retire illustrative authority
            </Button>
          )}
          {retired || variant === 'unavailable' ? (
            <CreatorOffersPage locale={getLocale()} page={{ kind: retired ? 'closed' : 'unavailable' }} />
          ) : (
            <CreatorOffersPage data={data} locale={getLocale()} guard={guard} />
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}

async function openManagement(canvasElement: HTMLElement, title = creatorOfferFixture.title) {
  const view = within(canvasElement);
  const toggle = await view.findByRole('button', { name: m.creator_offer_controls_manage_offer({ title }) });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(view.queryByRole('textbox', { name: m.creator_amount() })).toBeNull();
  toggle.focus();
  await userEvent.keyboard(' ');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await userEvent.tab();
  await expect(view.getByRole('textbox', { name: m.creator_amount() })).toHaveFocus();
  return { view, toggle };
}

export const Normal: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const { view, toggle } = await openManagement(canvasElement);
    await expect(view.getByRole('link', { name: creatorOfferFixture.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/offers/${creatorOfferFixture.id}`,
    );
    await expect(view.getByText(m.creator_offers_active(), { exact: true })).toBeVisible();
    await expect(view.getByText(m.creator_offers_delisted(), { exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: m.creator_delist() })).toBeEnabled();
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveFocus();
  },
};
export const DraftRemainsVisible: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const { view, toggle } = await openManagement(canvasElement);
    const input = view.getByRole('textbox', { name: m.creator_amount() });
    await userEvent.type(input, '13.25');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('13.25');
    await expect(view.getByText(m.creator_offer_controls_retained())).toBeVisible();
  },
};
export const LongTitleManagement: Story = {
  render: () => <Example variant="narrow" />,
  play: async ({ canvasElement }) => {
    const { view } = await openManagement(canvasElement, longTitle);
    const heading = view.getByRole('heading', { name: longTitle });
    const row = heading.closest('li')!;
    await userEvent.click(within(row).getByText(m.commerce_full_title(), { exact: true }));
    await expect(row.querySelector('details > p')).toHaveTextContent(longTitle);
    await expect(view.getByRole('textbox', { name: m.creator_amount() })).toBeVisible();
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  },
};
export const UnavailableRules: Story = {
  render: () => <Example variant="rules-unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(
      await view.findByRole('button', {
        name: m.creator_offer_controls_manage_offer({ title: creatorOfferFixture.title }),
      }),
    );
    await expect(view.getByText(m.creator_offers_amount_unavailable(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.creator_price_unavailable())).toBeVisible();
    await expect(view.getByRole('textbox', { name: m.creator_amount() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.creator_delist() })).toBeEnabled();
  },
};
export const Unavailable: Story = { render: () => <Example variant="unavailable" /> };
export const AuthorityRetired: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const { view } = await openManagement(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.creator_amount() }), '13.25');
    await userEvent.click(view.getByRole('button', { name: 'Retire illustrative authority' }));
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(
      view.queryByRole('button', {
        name: m.creator_offer_controls_manage_offer({ title: creatorOfferFixture.title }),
      }),
    ).toBeNull();
    await expect(view.queryByRole('heading', { name: creatorOfferFixture.title })).toBeNull();
    await expect(view.getByText(m.creator_closed())).toBeVisible();
  },
};
