import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { useMemo } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { translate } from './format.ts';
import * as fixture from './fixtures.ts';
import { FrameRollup, type RollupUnit } from './frame-rollup.tsx';
import { messages } from './messages.ts';

// A subject's episodes with one combined score that says how it was combined and how many episodes it could count.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const see = (container: HTMLElement, text: string | RegExp) =>
  waitFor(() => expect(within(container).getByText(text)).toBeVisible(), { timeout: 4000 });

function Rollup({ locale, scenario, unit }: { locale: UiLocale; scenario: fixture.Scenario; unit: RollupUnit }) {
  const api = useMemo(() => fixture.memoryScopedRatingApi(scenario), [scenario]);
  return <div className="mx-auto max-w-3xl p-4 sm:p-6">
    <FrameRollup subject={fixture.subject.iri} question={fixture.writing} unit={unit} api={api} locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Scoped rating/Frame roll-up',
  component: Rollup,
  args: { locale: 'en', scenario: fixture.populated, unit: 'episodes' },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(resourceHref('/e/', 'elizabeth-bennet'), 'en') } },
} satisfies Meta<typeof Rollup>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Pooled: the value, its formula in words, and how many episodes could be counted. An episode the question does not accept is named and left out. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, '4 of 5 episodes have enough ratings to count.');
    await expect(canvas.getByRole('heading', { name: 'All episodes together' })).toBeVisible();
    await expect(canvas.getByRole('radio', { name: 'Pooled' })).toBeChecked();
    await expect(canvas.getByText('Pooled: every rating counts the same, so a part with more ratings weighs more.')).toBeVisible();
    await expect(canvasElement.querySelector('[data-rollup-value]')?.textContent).toMatch(/\/ 10/);
    await expect(canvas.getByText('1 was left out because this question doesn’t apply to it.')).toBeVisible();
    // Every counted episode keeps its own figure; the thin one shows its count and no average.
    await expect(canvasElement.querySelectorAll('[data-rollup-member]')).toHaveLength(5);
    await expect(canvas.getByText('7 more ratings will reveal the average.')).toBeVisible();
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** Averaging the episodes instead of pooling their ratings is a different number, and the label says which one is shown. */
export const AverageOfEpisodes: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, '4 of 5 episodes have enough ratings to count.');
    const pooled = canvasElement.querySelector('[data-rollup-value]')?.textContent;
    await userEvent.click(canvas.getByRole('radio', { name: 'Average of episodes' }));
    await see(canvasElement, 'Average of episodes: every one counts the same, however many ratings it has.');
    await waitFor(() => expect(canvasElement.querySelector('[data-rollup-value]')?.textContent).not.toBe(pooled));
    await expect(canvas.getByRole('radio', { name: 'Average of episodes' })).toBeChecked();
  },
};

/** Averaging counts only the episodes the average is taken over: the thin one adds no ratings to the number shown. */
export const AverageOfEpisodesCountsWhatItAveraged: Story = {
  args: { scenario: { ...fixture.populated, places: [fixture.placeEpisode1, fixture.placeEpisode2, fixture.placeEpisode3, fixture.placeEpisode4, fixture.placeEpisode5],
    notAccepted: [] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const value = () => canvasElement.querySelector('[data-rollup-value]') as HTMLElement;
    await waitFor(() => expect(value().textContent).toContain('524 ratings'), { timeout: 4000 });
    await userEvent.click(canvas.getByRole('radio', { name: 'Average of episodes' }));
    await waitFor(() => expect(value().textContent).toContain('521 ratings'), { timeout: 4000 });
    await expect(value().textContent).not.toContain('524');
  },
};

/** The names of the episodes could not be read: a retry note, never "nobody has rated this". */
export const SummariesFailed: Story = {
  args: { scenario: { ...fixture.populated, summaryFails: true } },
  async play({ canvasElement }) {
    await see(canvasElement, 'This could not be loaded right now. Try again in a moment.');
    await expect(within(canvasElement).queryByText('Nobody has rated this in a specific part yet.')).toBeNull();
    await expect(canvasElement.querySelector('[data-rollup]')).toBeNull();
  },
};

/** Fewer than half of the episodes have enough ratings: the combined score is withheld, and the reason is the coverage. */
export const BelowThreshold: Story = {
  args: { scenario: fixture.belowThreshold },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, 'No combined score yet: fewer than half of the episodes have enough ratings.');
    await expect(canvas.getByText('0 of 3 episodes have enough ratings to count.')).toBeVisible();
    await expect(canvasElement.querySelector('[data-rollup-value]')?.textContent).not.toMatch(/\/ 10/);
    await fits();
  },
};
export const BelowThresholdPhone: Story = { ...BelowThreshold, globals: phone };

/** No episode has been rated, or none can be shown to this reader. */
export const Empty: Story = {
  args: { scenario: fixture.empty },
  async play({ canvasElement }) {
    await see(canvasElement, 'Nobody has rated this in a specific part yet.');
    await expect(canvasElement.querySelector('[data-rollup]')).toBeNull();
  },
};
export const SpoilerHidden: Story = {
  args: { scenario: fixture.allHidden },
  async play({ canvasElement }) {
    await see(canvasElement, 'Nobody has rated this in a specific part yet.');
    await expect(within(canvasElement).queryByText(/Episode \d/)).toBeNull();
  },
};
export const SpoilerHiddenPhone: Story = { ...SpoilerHidden, globals: phone };

/** Chapters, matches, maps and parts name their own members in the label and the coverage. */
export const Maps: Story = {
  args: { unit: 'maps' },
  async play({ canvasElement }) {
    await see(canvasElement, '4 of 5 maps have enough ratings to count.');
    await expect(within(canvasElement).getByRole('heading', { name: 'All maps together' })).toBeVisible();
  },
};

/** Some of the episodes cannot be read: they are counted as unreadable, and the value comes from the rest. */
export const Unreadable: Story = {
  args: { scenario: { ...fixture.populated, unreadable: [fixture.placeEpisode2.projection.id], notAccepted: [] } },
  async play({ canvasElement }) {
    await see(canvasElement, '1 could not be read.');
    await fits();
  },
};

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale, unit: 'episodes' },
  async play({ canvasElement }) {
    const t = translate(messages[locale], locale);
    await waitFor(() => expect(canvasElement.querySelector('[data-rollup-value]')).not.toBeNull(), { timeout: 4000 });
    await see(canvasElement, t.explainPooled);
    await expect(within(canvasElement).getByRole('heading', { name: t.combined({ unit: t.unitEpisodes }) })).toBeVisible();
    await fits();
  },
});
export const TraditionalChinese: Story = localized('zh-Hant');
export const SimplifiedChinese: Story = localized('zh-Hans');
export const Japanese: Story = localized('ja');
export const Korean: Story = localized('ko');
export const German: Story = localized('de');
export const French: Story = localized('fr');
export const Spanish: Story = localized('es');
