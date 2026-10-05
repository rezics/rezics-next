import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { useMemo } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { EventRanking } from './event-ranking.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';

// An event page's ranking: the participants the page could find, ranked for the first question that accepts them.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

function Ranking({ locale, scenario, who }: { locale: UiLocale; scenario: fixture.Scenario; who: typeof fixture.participants }) {
  const api = useMemo(() => fixture.memoryScopedRatingApi(scenario), [scenario]);
  return <div className="mx-auto max-w-3xl p-4 sm:p-6">
    <EventRanking participants={who} api={api} actingSubject={null} locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Scoped rating/Event ranking',
  component: Ranking,
  args: { locale: 'en', scenario: fixture.participantScenario, who: fixture.participants },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(resourceHref('/e/', 'spring-finals'), 'en') } },
} satisfies Meta<typeof Ranking>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The question is read for the participants, then the ranking states how it was made and who is not ranked yet. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('[data-rank="1"]')).not.toBeNull(), { timeout: 4000 });
    await expect(canvas.getByRole('heading', { name: 'Ranking', level: 2 })).toBeVisible();
    await expect(canvasElement.querySelector('[data-ranking-eligibility]')?.textContent).toMatch(/Needs at least 50 ratings/);
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** No question accepts the participants: nothing is ranked and nothing is drawn. */
export const NoQuestion: Story = {
  args: { scenario: { ...fixture.participantScenario, questions: {} } },
  async play({ canvasElement }) {
    await waitFor(() => expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull(), { timeout: 4000 });
    await expect(canvasElement.querySelector('[data-ranking]')).toBeNull();
  },
};

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale },
  async play({ canvasElement }) {
    await waitFor(() => expect(canvasElement.querySelector('[data-rank="1"]')).not.toBeNull(), { timeout: 4000 });
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
