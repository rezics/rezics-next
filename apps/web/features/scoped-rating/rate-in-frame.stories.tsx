import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { useMemo } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import type { FrameCandidate } from './frames.ts';
import { translate } from './format.ts';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { RateInFrame } from './rate-in-frame.tsx';
import type { Viewer } from './question-rating.tsx';

// Rating a character "in" an episode: choose the place, then the questions that accept it, with their own figures.
// The sheet opens at once so each state can be reviewed; a phone gets it as a panel from the edge.

const phone = { viewport: { value: 'phone' } } as const;
const [, , e3, e4, e5] = fixture.episodes as [FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate];

function Rate({ locale, scenario, viewer, frames }: {
  locale: UiLocale; scenario: fixture.Scenario; viewer: Viewer; frames: FrameCandidate[];
}) {
  const api = useMemo(() => fixture.memoryScopedRatingApi(scenario), [scenario]);
  return <div className="mx-auto max-w-2xl p-4 sm:p-6">
    <RateInFrame subject={fixture.subject} api={api} sources={fixture.sources} viewer={viewer} initialFrames={frames}
      defaultOpen locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Scoped rating/Rate in a frame',
  component: Rate,
  args: { locale: 'en', scenario: fixture.populated, viewer: fixture.readerViewer, frames: [] },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(resourceHref('/e/', 'elizabeth-bennet'), 'en') } },
} satisfies Meta<typeof Rate>;
export default meta;
type Story = StoryObj<typeof meta>;

const copy = (locale: UiLocale) => translate(messages[locale], locale);
/** Text appears once Main has answered and the sheet has finished opening; wait for it to be visible, not merely present. */
const see = (container: HTMLElement, text: string | RegExp) =>
  waitFor(() => expect(within(container).getByText(text)).toBeVisible(), { timeout: 4000 });
const seeRole = (container: HTMLElement, role: string, name: string | RegExp) =>
  waitFor(() => expect(within(container).getByRole(role, { name })).toBeVisible(), { timeout: 4000 });
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

/** Opens the sheet's second step: gets or creates the place and shows its questions. */
async function openPlace(locale: UiLocale = 'en') {
  const dialog = await screen.findByRole('dialog');
  const next = within(dialog).getByRole('button', { name: copy(locale).continue });
  await waitFor(() => expect(next).toBeEnabled());
  await userEvent.click(next);
  return dialog;
}

/** Nothing chosen yet: the kinds of place Main accepts as frames, and why it cannot continue. */
export const ChoosePlaceEmpty: Story = {
  async play() {
    const dialog = await screen.findByRole('dialog', { name: 'Rate Elizabeth Bennet in a specific part' });
    await seeRole(dialog, 'tab', 'Episodes');
    await seeRole(dialog, 'tab', 'Continuities');
    await see(dialog, 'Choose at least one to continue.');
    await expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await fits();
  },
};
export const ChoosePlaceEmptyPhone: Story = { ...ChoosePlaceEmpty, globals: phone };

/** Searching a kind of place, choosing one, then another of the same kind: the second replaces the first. */
export const ChoosePlace: Story = {
  async play() {
    const dialog = await screen.findByRole('dialog');
    const search = await within(dialog).findByRole('combobox', { name: 'Episodes' }, { timeout: 4000 });
    await waitFor(() => expect(search).toBeEnabled());
    const choose = async (query: string, option: RegExp) => {
      // The sheet moves focus once it has opened, which closes a list opened just before; open it until it stays open.
      await waitFor(async () => {
        if (search.getAttribute('aria-expanded') !== 'true') await userEvent.click(search);
        await expect(search).toHaveAttribute('aria-expanded', 'true');
      }, { timeout: 5000 });
      await userEvent.clear(search);
      await userEvent.type(search, query);
      // The list is briefly aria-hidden while a search is answered; the options are there either way.
      const found = await screen.findByRole('option', { name: option, hidden: true }, { timeout: 4000 });
      await userEvent.click(found);
    };
    await choose('Hunsford', /Episode 3/);
    await seeRole(dialog, 'button', 'Remove Episode 3 · Hunsford');
    await expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled();
    await choose('Pemberley', /Episode 4/);
    await seeRole(dialog, 'button', 'Remove Episode 4 · Pemberley');
    await expect(within(dialog).queryByRole('button', { name: 'Remove Episode 3 · Hunsford' })).toBeNull();
  },
};

/** A well-rated place: the question in its own words, the figure with its unit and count, and the entries to review and discuss. */
export const Populated: Story = {
  args: { frames: [e3] },
  async play() {
    const dialog = await openPlace();
    await seeRole(dialog, 'link', 'Elizabeth Bennet');
    await seeRole(dialog, 'link', /Episode 3 · Hunsford/);
    await see(dialog, /\/10$/);
    await see(dialog, '214 ratings');
    await seeRole(dialog, 'heading', 'How well written is this character here?');
    await seeRole(dialog, 'list', 'Ratings by score');
    await seeRole(dialog, 'link', 'Write a review');
    await seeRole(dialog, 'link', 'Discuss');
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** Three ratings, short of the threshold: the count shows, the average waits and says how many more reveal it. */
export const BelowThreshold: Story = {
  args: { frames: [e4] },
  async play() {
    const dialog = await openPlace();
    await see(dialog, '3 ratings');
    await see(dialog, '7 more ratings will reveal the average');
    await expect(within(dialog).queryByText(/\/10/)).toBeNull();
    await expect(within(dialog).queryByText(/^0(\.0)?$/)).toBeNull();
    await fits();
  },
};
export const BelowThresholdPhone: Story = { ...BelowThreshold, globals: phone };

/** Nobody has rated this place: it says so, with no zero and no empty histogram. */
export const NoRatingsYet: Story = {
  args: { frames: [e5], scenario: { ...fixture.populated, histograms: {} } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'No ratings yet');
    await expect(within(dialog).queryByRole('list', { name: 'Ratings by score' })).toBeNull();
    await fits();
  },
};
export const NoRatingsYetPhone: Story = { ...NoRatingsYet, globals: phone };

/** No question accepts this place, so there is nothing to rate; it says so rather than offering stars. */
export const NoQuestions: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, questions: {} } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'No question applies here yet, so it can’t be rated.');
    await expect(within(dialog).queryByRole('slider')).toBeNull();
  },
};

/** A place later in the story than the reader has read is refused as an absent one: nothing of it is named. */
export const SpoilerHidden: Story = {
  args: { frames: [fixture.episodes[5]!] },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'This isn’t visible here, or it no longer exists.');
    await expect(within(dialog).queryByText(/Episode 6/)).toBeNull();
    await seeRole(dialog, 'button', 'Choose differently');
  },
};
export const SpoilerHiddenPhone: Story = { ...SpoilerHidden, globals: phone };

/** Signed out, a place can be browsed but not created or rated: the sheet leads to sign-in. */
export const SignedOut: Story = {
  args: { frames: [e3], viewer: fixture.signedOutViewer, scenario: { ...fixture.populated, signedIn: false } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'Sign in to rate.');
    await expect(within(dialog).getByRole('link', { name: 'Sign in to rate' })).toHaveAttribute('href', fixture.signedOutViewer.signInHref);
  },
};

/** Main refuses a frame set it cannot combine: the reason shows, and the choice stays to be changed. */
export const RefusedCombination: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, projectionFails: 'invalid' } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'These can’t be combined. Choose one place of each kind.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose differently' }));
    await seeRole(dialog, 'button', 'Remove Episode 3 · Hunsford');
  },
};

/** The person's rating changed on another device: this one is not saved, and the stars return to what Main holds. */
export const RatingConflict: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, rateFails: 'conflict' } },
  async play() {
    const dialog = await openPlace();
    await within(dialog).findByText('214 ratings');
    const stars = dialog.querySelectorAll<HTMLElement>('[data-slot="rating-item"]');
    await userEvent.click(stars[6]!);
    await see(dialog, 'Your rating was changed somewhere else, so this one wasn’t saved.');
    await expect(within(dialog).queryByRole('button', { name: 'Remove my rating' })).toBeNull();
  },
};

/** Rating a place moves one count into its histogram and lets the person take it back. */
export const RateAndWithdraw: Story = {
  args: { frames: [e3] },
  async play() {
    const dialog = await openPlace();
    await within(dialog).findByText('214 ratings');
    const stars = dialog.querySelectorAll<HTMLElement>('[data-slot="rating-item"]');
    await userEvent.click(stars[6]!);
    await see(dialog, 'Your rating: 7/10');
    await see(dialog, '215 ratings');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove my rating' }));
    await see(dialog, '214 ratings');
  },
};

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale, frames: [e3] },
  async play() {
    const dialog = await screen.findByRole('dialog', { name: copy(locale).sheetTitle({ name: fixture.subject.name.value }) });
    await openPlace(locale);
    await see(dialog, / \/10$|\/10/);
    await seeRole(dialog, 'link', copy(locale).writeReview);
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
