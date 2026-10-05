import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { useMemo } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { translate } from './format.ts';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { SubjectJudgments } from './subject-judgments.tsx';

// Everything a person can do with a subject's ratings, on the subject's own page: its question, the choice of a place to rate it
// in, each place it has been rated in, and the combined view over the episodes of one Work.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const see = (container: HTMLElement, text: string | RegExp) =>
  waitFor(() => expect(within(container).getByText(text)).toBeVisible(), { timeout: 4000 });
/** The places are listed once Main has answered. */
const places = (container: HTMLElement) =>
  waitFor(() => expect(container.querySelectorAll('[data-projection]').length).toBeGreaterThan(2), { timeout: 4000 });
const plans = [{ kind: 'position' as const, work: fixture.workIri, name: 'Pride and Prejudice (1995)' }];

function Judgments({ locale, scenario, signedIn }: { locale: UiLocale; scenario: fixture.Scenario; signedIn: boolean }) {
  const api = useMemo(() => fixture.memoryScopedRatingApi({ ...scenario, signedIn }), [scenario, signedIn]);
  return <div className="mx-auto max-w-3xl p-4 sm:p-6">
    <SubjectJudgments subject={fixture.subject} api={api} sources={fixture.sources} plans={plans}
      actingSubject={signedIn ? 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa' : null}
      signInHref="/auth/start?next=%2Fen%2Fe%2Felizabeth-bennet" locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Scoped rating/Subject judgments',
  component: Judgments,
  args: { locale: 'en', scenario: fixture.populated, signedIn: true },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(resourceHref('/e/', 'elizabeth-bennet'), 'en') } },
} satisfies Meta<typeof Judgments>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The subject's own question and figure come first and stay apart from the places below: no place's score flows into it. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await places(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'How well written is this character here?', level: 3 })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Ratings by part', level: 3 })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Rate in a specific part' })).toBeVisible();
    // Reviews belong to the places; the subject's own question offers the discussion on its page.
    await expect(canvas.queryByRole('link', { name: 'Write a review' })).toBeNull();
    await expect(canvas.getAllByRole('link', { name: 'Discuss' })[0]).toHaveAttribute('href', '#discussion');
    await expect(canvasElement.querySelectorAll('[data-open-part]').length).toBeGreaterThan(2);
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** The episodes of one Work have a combined score that names its formula and how many it could count. */
export const WithRollup: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('[data-subject-rollup]')).not.toBeNull(), { timeout: 4000 });
    await expect(canvas.getByText('Pride and Prejudice (1995)')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'All parts together' })).toBeVisible();
    await see(canvasElement, /have enough ratings to count\.$/);
    await fits();
  },
};
export const WithRollupPhone: Story = { ...WithRollup, globals: phone };

/** A new device: the rating the person already gave is read from Main and shown at once, with nothing remembered in the browser. */
export const OwnRatingFromMain: Story = {
  args: { scenario: { ...fixture.populated, own: { [`${fixture.subject.iri}|${fixture.writing.context}`]: 7 } } },
  async play({ canvasElement }) {
    await see(canvasElement, 'Your rating: 7/10');
    await expect(within(canvasElement).getByRole('button', { name: 'Remove my rating' })).toBeVisible();
  },
};

/** Nothing has been rated in a place yet: the subject's own question is still there to answer. */
export const NoPlacesYet: Story = {
  args: { scenario: fixture.empty },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('button', { name: 'Rate in a specific part' })).toBeVisible();
    await waitFor(() => expect(within(canvasElement).queryByText('Loading…')).toBeNull());
    await expect(canvasElement.querySelector('[data-subject-projections]')).toBeNull();
    await expect(within(canvasElement).queryByText('Ratings by part')).toBeNull();
    await expect(within(canvasElement).queryByText('Nobody has rated this in a specific part yet.')).toBeNull();
    await expect(canvasElement.querySelector('[data-subject-rollup]')).toBeNull();
  },
};

/** A signed-out reader sees every figure and is sent to sign in to rate. */
export const SignedOut: Story = {
  args: { signedIn: false },
  async play({ canvasElement }) {
    await places(canvasElement);
    const sign = within(canvasElement).getByRole('link', { name: 'Sign in to rate' });
    await expect(sign).toHaveAttribute('href', '/auth/start?next=%2Fen%2Fe%2Felizabeth-bennet');
  },
};

/** Choosing a place from the subject's page opens the frame picker with the kinds of place the host offered. */
export const OpensThePicker: Story = {
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Rate in a specific part' });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    await waitFor(() => expect(document.querySelector('[data-frame-picker]')).not.toBeNull(), { timeout: 4000 });
  },
};

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale },
  async play({ canvasElement }) {
    const t = translate(messages[locale], locale);
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-projection]').length).toBeGreaterThan(2), { timeout: 4000 });
    await expect(within(canvasElement).getByRole('heading', { name: t.byPart })).toBeVisible();
    await expect(within(canvasElement).getAllByRole('link', { name: t.openPart }).length).toBeGreaterThan(0);
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
