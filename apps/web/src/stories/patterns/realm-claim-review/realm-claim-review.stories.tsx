import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmClaimReviewExample } from './example';
import { m } from '../../../paraglide/messages.js';

const meta = {
  title: 'Patterns/Community/Realm Claim Review',
  component: RealmClaimReviewExample,
  excludeStories: ['confirmReview'],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RealmClaimReviewExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export async function confirmReview({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.realm_review_review() }));
  await expect(await view.findByRole('heading', { name: m.realm_review_confirm_heading() })).toBeVisible();
  await userEvent.click(view.getByRole('button', { name: m.realm_review_confirm() }));
}
export const Pending: Story = { args: { scenario: 'pending' } };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Sparse: Story = {
  args: { scenario: 'sparse' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByText(m.realm_review_empty())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_review_next() }));
    await expect(await view.findByRole('button', { name: m.realm_review_review() })).toBeEnabled();
  },
};
export const Denied: Story = { args: { scenario: 'denied' } };
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async (context) => {
    await confirmReview(context);
    await within(context.canvasElement).findByText(m.realm_review_conflict());
  },
};
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async (context) => {
    await confirmReview(context);
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.realm_review_inspect_original() }));
    await userEvent.click(await view.findByRole('button', { name: m.realm_review_retry() }));
    await expect(await view.findByText(m.realm_review_success())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_review_confirm() })).toBeNull();
  },
};
export const Success: Story = {
  args: { scenario: 'success' },
  play: async (context) => {
    await confirmReview(context);
    await within(context.canvasElement).findByText(m.realm_review_success());
  },
};
