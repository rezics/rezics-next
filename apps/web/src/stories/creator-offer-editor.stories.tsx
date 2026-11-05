import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreatorPriceFields, type CreatorPriceIntent } from '../checkout/creator-offer-editor';
import { configuredPriceExample } from '../kernel/fake/creator-offers';
import { formatMinorAmount } from '../checkout/money';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, PatternStory, pageReady } from './page';

const meta = {
  title: 'Pages/Commerce/Creator Offer Editor',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual served routes retain native unavailable outcomes. Price-field examples use explicit configured USD/EUR unit facts only; they establish neither Content publication, selling permission nor provider qualification. Web review and native proof remain pending.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function PriceExample() {
  const [intent, setIntent] = useState<CreatorPriceIntent>({ currency: '', text: '' });
  return (
    <PatternStory>
      <div className="max-w-3xl space-y-6 p-5 sm:p-8">
        <form
          onSubmit={(event) => event.preventDefault()}
          className="space-y-6 rounded-xl border bg-card p-5 text-card-foreground"
        >
          <CreatorPriceFields
            rules={configuredPriceExample.configuredSaleCurrencies}
            intent={intent}
            onChange={setIntent}
            locale={getLocale()}
          />
        </form>
      </div>
    </PatternStory>
  );
}
async function priceIntent({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const currency = await view.findByRole('combobox', { name: m.creator_currency() });
  await userEvent.selectOptions(currency, 'usd');
  const amount = view.getByRole('textbox', { name: m.creator_amount() });
  await userEvent.type(amount, '12.99');
  const rule = configuredPriceExample.configuredSaleCurrencies[0]!;
  await expect(
    view.getByText(`${formatMinorAmount(getLocale(), 'usd', 1299, rule.unit)} · USD · ${m.commerce_before_tax()}`),
  ).toBeVisible();
  await userEvent.selectOptions(currency, 'eur');
  await expect(amount).toHaveValue('');
  await userEvent.type(amount, '12,99');
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await userEvent.clear(amount);
  await userEvent.type(amount, '12.99');
  await expect(
    view.getByText(`${formatMinorAmount(getLocale(), 'eur', 1299, rule.unit)} · EUR · ${m.commerce_before_tax()}`),
  ).toBeVisible();
}
export const PriceIntent: Story = {
  render: () => <PriceExample />,
  play: priceIntent,
};
export const ActualRoute: Story = {
  render: () => <PageStory visitor="Signed In" path="/creator/offers/new" />,
  play: pageReady,
};
export const ActualOwnedOffers: Story = {
  render: () => <PageStory visitor="Signed In" path="/creator/offers" />,
  play: pageReady,
};
