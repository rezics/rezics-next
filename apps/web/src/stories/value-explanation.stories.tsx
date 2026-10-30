import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useMemo } from 'react';
import { ValueExplanation } from '../features/catalogue/value-explanation-page';
import { valueExplanationFixture, type ValueScenario } from '../kernel/fake/value-explanation';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function WhyStory({ scenario = 'selected' }: { scenario?: ValueScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => valueExplanationFixture(scenario, locale), [scenario, locale]);
  return (
    <PatternStory visitor="Signed In" path="/">
      <AppShell>
        <ValueExplanation key={`${scenario}:${locale}`} locale={locale} transport={fixture.transport} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Catalogue/Why this value',
  component: WhyStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof WhyStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Selected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('9780156012195')).toBeVisible();
    await expect(canvas.getByText('Édition originale')).toHaveAttribute('lang', 'fr');
    await expect(canvas.getByRole('link', { name: m.subject_sources() })).toHaveAttribute(
      'href',
      expect.stringContaining('/sources'),
    );
    await expect(canvas.getByText(m.value_change_unavailable())).toBeVisible();
  },
};
export const ContinueReview: Story = {
  args: { scenario: 'paged' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.value_not_returned())).toBeVisible();
    await userEvent.click(await canvas.findByRole('button', { name: m.value_more() }));
    await waitFor(() => expect(canvas.getByRole('button', { name: m.value_more() })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: m.value_more() }));
    await expect(await canvas.findByText(m.value_accepted())).toBeVisible();
    await expect(canvas.getByText('9780156012195')).toBeVisible();
    await expect(canvas.queryByText('UNSELECTED PRIVATE ALTERNATIVE')).toBeNull();
  },
};
export const ReviewDenied: Story = { args: { scenario: 'review-denied' } };
export const ReviewUnavailable: Story = { args: { scenario: 'review-error' } };
export const Unresolved: Story = { args: { scenario: 'unresolved' } };
export const NoLongerSelected: Story = { args: { scenario: 'not-selected' } };
export const UnknownValue: Story = { args: { scenario: 'somevalue' } };
export const NoValue: Story = { args: { scenario: 'novalue' } };
export const Concealed: Story = { args: { scenario: 'concealed' } };
export const ReadError: Story = { args: { scenario: 'error' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const DocumentUnavailable: Story = { args: { scenario: 'document' } };
