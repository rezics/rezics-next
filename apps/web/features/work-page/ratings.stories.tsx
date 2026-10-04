import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { identityRatings } from '../entity-page/identity-fixtures.ts';
import { TargetRatingsRegion } from './ratings.tsx';
import { messages } from './messages.ts';

const meta = {
  title: 'Work page/Target ratings',
  component: TargetRatingsRegion,
  args: {
    ratings: identityRatings(1),
    subject: 'Ratings for this character',
    none: 'No ratings yet.',
    locale: 'en',
    messages: messages.en,
  },
} satisfies Meta<typeof TargetRatingsRegion>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BelowThreshold: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('1 rating')).toBeVisible();
    await expect(canvas.getByText('4 more ratings will reveal the average.')).toBeVisible();
    await expect(canvas.getByRole('list', { name: 'Rating distribution' })).toBeVisible();
    await expect(canvasElement.querySelector('svg')).toBeNull();
  },
};
export const NoData: Story = { args: { ratings: identityRatings(0) } };
export const AtThreshold: Story = { args: { ratings: identityRatings(5) } };
export const BelowThresholdPhone: Story = {
  ...BelowThreshold,
  globals: { viewport: { value: 'phone' } },
};
