import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { useMemo } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { translate } from './format.ts';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { ParticipantRanking } from './participant-ranking.tsx';

// The participants of a match ranked by the published weighted rating, with why: the 50 ratings a place needs, and the
// overall average everyone is pulled toward until they have them.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const see = (container: HTMLElement, text: string | RegExp) =>
  waitFor(() => expect(within(container).getByText(text)).toBeVisible(), { timeout: 4000 });

function Ranking({ locale, scenario, who }: { locale: UiLocale; scenario: fixture.Scenario; who: typeof fixture.participants }) {
  const api = useMemo(() => fixture.memoryScopedRatingApi(scenario), [scenario]);
  return <div className="mx-auto max-w-3xl p-4 sm:p-6">
    <ParticipantRanking question={fixture.performance} participants={who} api={api} locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Scoped rating/Participant ranking',
  component: Ranking,
  args: { locale: 'en', scenario: fixture.participantScenario, who: fixture.participants },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(resourceHref('/e/', 'spring-finals'), 'en') } },
} satisfies Meta<typeof Ranking>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two players earned a rank; one has too few ratings and shows how far along they are; one is hidden from this reader. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, 'Rank 1');
    const first = canvasElement.querySelector('[data-rank="1"]') as HTMLElement;
    const second = canvasElement.querySelector('[data-rank="2"]') as HTMLElement;
    await expect(within(first).getByRole('link', { name: 'Kestrel' })).toBeVisible();
    await expect(within(first).getByText(/^Weighted /)).toBeVisible();
    await expect(within(second).getByRole('link', { name: 'Vesper' })).toBeVisible();
    await expect(canvasElement.querySelector('[data-rank="3"]')).toBeNull();
    // Why: the minimum, the pull toward the overall average, and the way to a rank for those who are not there yet.
    await expect(canvasElement.querySelector('[data-ranking-eligibility]')?.textContent).toMatch(/Needs at least 50 ratings to be ranked\. Overall average [\d.]+, with a weight of [\d,]+\. A participant with that many ratings is pulled halfway toward it\./);
    await expect(canvas.getByRole('heading', { name: 'Not ranked yet' })).toBeVisible();
    await expect(canvas.getByText('12 of 50 ratings')).toBeVisible();
    await expect(canvas.getByText('0 of 50 ratings')).toBeVisible();
    // The sixth participant is hidden from this reader and appears nowhere.
    await expect(canvas.getAllByRole('link', { name: 'Mako' })).toHaveLength(1);
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** Nobody has the ratings a rank needs yet: no order is invented, and each participant shows their progress. */
export const BelowThreshold: Story = {
  args: { scenario: fixture.thinParticipants, who: [fixture.kestrel, fixture.vesper] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, 'No one has enough ratings to be ranked yet.');
    await expect(canvasElement.querySelector('[data-rank]')).toBeNull();
    await expect(canvas.getByText('14 of 50 ratings')).toBeVisible();
    await expect(canvas.getByText('6 of 50 ratings')).toBeVisible();
    await fits();
  },
};
export const BelowThresholdPhone: Story = { ...BelowThreshold, globals: phone };

/** The participants' names could not be read: a retry note, never "no one has enough ratings" or an empty ranking. */
export const SummariesFailed: Story = {
  args: { who: fixture.participants.map(read => ({ ...read, summary: null })) },
  async play({ canvasElement }) {
    await see(canvasElement, 'This could not be loaded right now. Try again in a moment.');
    await expect(within(canvasElement).queryByText('No one has enough ratings to be ranked yet.')).toBeNull();
    await expect(canvasElement.querySelector('[data-rank]')).toBeNull();
  },
};

/** An event with no participants yet. */
export const Empty: Story = {
  args: { who: [] },
  async play({ canvasElement }) {
    await see(canvasElement, 'No one has enough ratings to be ranked yet.');
    await expect(canvasElement.querySelector('[data-rank]')).toBeNull();
  },
};

/** Every participant is later in the story than the reader has read: nobody is named. */
export const SpoilerHidden: Story = {
  args: { who: [fixture.hiddenPlayer] },
  async play({ canvasElement }) {
    await see(canvasElement, 'No one has enough ratings to be ranked yet.');
    await expect(within(canvasElement).queryByRole('link')).toBeNull();
  },
};
export const SpoilerHiddenPhone: Story = { ...SpoilerHidden, globals: phone };

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale },
  async play({ canvasElement }) {
    const t = translate(messages[locale], locale);
    await see(canvasElement, t.rankingBasis);
    await waitFor(() => expect(canvasElement.querySelector('[data-rank="1"]')).not.toBeNull(), { timeout: 4000 });
    await see(canvasElement, t.rankingProgress({ count: '12', min: '50' }));
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
