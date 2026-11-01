import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmClaimExample } from './example';
import { m } from '../../../paraglide/messages.js';

const meta = {
  title: 'Patterns/Community/Realm Claim',
  component: RealmClaimExample,
  excludeStories: ['claimJourney'],
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RealmClaimExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export async function claimJourney({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.realm_claim_request() }));
  await view.findByText(m.realm_claim_pending());
  await expect(view.getByText('01a1a000-0000-7000-8000-000000000099')).toBeVisible();
  await expect(view.queryByText(m.realm_claim_owned())).toBeNull();
  await userEvent.click(view.getByRole('button', { name: m.realm_claim_refresh() }));
  await view.findByText(m.realm_claim_owned());
  await expect(view.queryByRole('button', { name: m.realm_claim_request() })).toBeNull();
}
export const Journey: Story = { args: { scenario: 'journey' }, play: claimJourney };
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_claim_request() }));
    await view.findByText(m.realm_claim_uncertain());
    await expect(view.queryByText(m.realm_claim_pending())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_claim_retry() }));
    await view.findByText(m.realm_claim_pending());
  },
};
export const Refused: Story = {
  args: { scenario: 'refused' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_claim_request() }));
    await view.findByText(m.realm_claim_refused());
    await expect(view.queryByText(m.realm_claim_pending())).toBeNull();
  },
};
