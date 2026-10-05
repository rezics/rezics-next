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
import type { FrameSource } from './sources.ts';
import { chooseOption } from '../stories/choose-option.ts';

// Rating a character "in" an episode: choose the place, then the questions that accept it, with their own figures.
// The sheet opens at once so each state can be reviewed; a phone gets it as a panel from the edge.

const phone = { viewport: { value: 'phone' } } as const;
const [, , e3, e4, e5] = fixture.episodes as [FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate, FrameCandidate];

function Rate({ locale, scenario, viewer, frames, sources = fixture.sources }: {
  locale: UiLocale; scenario: fixture.Scenario; viewer: Viewer; frames: FrameCandidate[]; sources?: readonly FrameSource[];
}) {
  const api = useMemo(() => fixture.memoryScopedRatingApi(scenario), [scenario]);
  return <div className="mx-auto max-w-2xl p-4 sm:p-6">
    <RateInFrame subject={fixture.subject} api={api} sources={sources} viewer={viewer} initialFrames={frames}
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

/** Opens the sheet's second step: looks the place up and shows its questions. */
async function openPlace(locale: UiLocale = 'en') {
  const dialog = await screen.findByRole('dialog');
  const next = await within(dialog).findByRole('button', { name: copy(locale).continue }, { timeout: 4000 });
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
      await chooseOption(screen, option);
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
    await see(dialog, /\/ 10$/);
    await see(dialog, '214 ratings');
    await seeRole(dialog, 'heading', 'How well written is this character here?');
    await seeRole(dialog, 'list', 'Rating distribution');
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
    await see(dialog, '7 more ratings will reveal the average.');
    await expect(within(dialog).queryByText(/\/ 10/)).toBeNull();
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
    await expect(within(dialog).queryByRole('list', { name: 'Rating distribution' })).toBeNull();
    await fits();
  },
};
export const NoRatingsYetPhone: Story = { ...NoRatingsYet, globals: phone };

/** No question accepts this place, so there is nothing to rate; it says so rather than offering stars. */
export const NoQuestions: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, questions: {} } },
  async play() {
    const dialog = await screen.findByRole('dialog');
    await see(dialog, 'No question applies here yet, so it can’t be rated.');
    await expect(within(dialog).queryByRole('button', { name: 'Continue' })).toBeNull();
    await expect(within(dialog).queryByRole('slider')).toBeNull();
  },
};
export const ApplicableDimensionsOnly: Story = {
  args: { scenario: { ...fixture.populated, questions: { '*': [{ ...fixture.writing, acceptedFrameDimensions: ['position'] }] } } },
  async play() {
    const dialog = await screen.findByRole('dialog');
    await seeRole(dialog, 'combobox', 'Episodes');
    await expect(within(dialog).queryByRole('tab', { name: 'Continuities' })).toBeNull();
    await expect(within(dialog).queryByRole('combobox', { name: 'Continuities' })).toBeNull();
  },
};
export const NoQuestionAcceptsTheCombination: Story = {
  args: { frames: [e3, fixture.continuities[0]!], scenario: { ...fixture.populated, questions: { '*': [
    { ...fixture.writing, acceptedFrameDimensions: ['position'] },
    { ...fixture.strength, acceptedFrameDimensions: ['continuity'] },
  ] } } },
  async play() {
    const dialog = await screen.findByRole('dialog');
    await seeRole(dialog, 'tab', 'Episodes');
    await seeRole(dialog, 'tab', 'Continuities');
    await expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: /Remove Austen/ }));
    await expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled();
  },
};

/** A place later in the story than the reader has read is not found, as one that does not exist is not; rating it is refused as an absent one. */
export const SpoilerHidden: Story = {
  args: { frames: [fixture.episodes[5]!] },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'No ratings yet');
    await userEvent.click(stars(dialog)[6]!);
    await see(dialog, 'This isn’t visible here, or it no longer exists.');
    await seeRole(dialog, 'button', 'Choose differently');
  },
};
export const SpoilerHiddenPhone: Story = { ...SpoilerHidden, globals: phone };

/** Signed out, a place can be browsed with its figures but not rated: the sheet leads to sign-in. */
export const SignedOut: Story = {
  args: { frames: [e3], viewer: fixture.signedOutViewer, scenario: { ...fixture.populated, signedIn: false } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, '214 ratings');
    await expect(within(dialog).getByRole('link', { name: 'Sign in to rate' })).toHaveAttribute('href', fixture.signedOutViewer.signInHref);
  },
};

const stars = (dialog: HTMLElement) => dialog.querySelectorAll<HTMLElement>('[data-slot="rating-item"]');
/** A continuity nobody has rated this subject in: no place exists for it yet. */
const fresh = fixture.continuities[1]!;
const writes: string[] = [];

/** Opening a place nobody has rated looks it up and makes nothing; the first rating creates it, once, and then writes. */
export const NewPlaceCreatedOnFirstRating: Story = {
  args: { frames: [fresh], scenario: { ...fixture.populated, log: writes } },
  async play() {
    writes.length = 0;
    const dialog = await openPlace();
    await seeRole(dialog, 'heading', 'How well written is this character here?');
    await see(dialog, 'No ratings yet');
    await seeRole(dialog, 'list', 'In');
    await expect(within(dialog).getByText(fresh.name.value)).toBeVisible();
    // Looking has made nothing, and review and discussion wait for a place the same way.
    await expect(writes).toEqual(['lookup']);
    await expect(within(dialog).getByRole('button', { name: 'Write a review' })).toBeEnabled();
    await expect(within(dialog).getByRole('button', { name: 'Discuss' })).toBeEnabled();
    await userEvent.click(stars(dialog)[6]!);
    await see(dialog, 'Your rating: 7/10');
    await see(dialog, '1 rating');
    await expect(writes).toEqual(['lookup', 'projection', 'rate']);
    // A second rating reuses the place.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove my rating' }));
    await waitFor(() => expect(writes).toEqual(['lookup', 'projection', 'rate', 'rate']));
  },
};
export const NewPlaceCreatedOnFirstRatingPhone: Story = { ...NewPlaceCreatedOnFirstRating, globals: phone };

/** A place that already exists is found by the lookup and never created again. */
export const ExistingPlaceIsNotCreated: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, log: writes } },
  async play() {
    writes.length = 0;
    const dialog = await openPlace();
    await within(dialog).findByText('214 ratings');
    await userEvent.click(stars(dialog)[6]!);
    await see(dialog, 'Your rating: 7/10');
    await expect(writes).toEqual(['lookup', 'rate']);
  },
};

/** The lookup itself failed: it says so and offers to try again, instead of showing an empty place to rate. */
export const LookupFailed: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, lookupFails: 'unavailable' } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'This could not be loaded right now. Try again in a moment.');
    await seeRole(dialog, 'button', 'Try again');
    await expect(within(dialog).queryByText('No ratings yet')).toBeNull();
  },
};

/** The place exists but its name could not be read: a retry note in the header, never "hidden until you reach it". */
export const SummaryFailed: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, summaryFails: true } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'This could not be loaded right now. Try again in a moment.');
    await expect(within(dialog).queryByText('Hidden until you reach it')).toBeNull();
  },
};

/** Main refuses a frame set it cannot combine when the place is first made: the reason shows beside the rating, and the choice stays to be changed. */
export const RefusedCombination: Story = {
  args: { frames: [fresh], scenario: { ...fixture.populated, projectionFails: 'invalid' } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'No ratings yet');
    await userEvent.click(stars(dialog)[6]!);
    await see(dialog, 'These can’t be combined. Choose one place of each kind.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Choose differently' }));
    await seeRole(dialog, 'button', `Remove ${fresh.name.value}`);
  },
};

/** Two Works in one place is its own refusal, with its own words. */
export const RefusedAcrossWorks: Story = {
  args: { frames: [fresh], scenario: { ...fixture.populated, projectionFails: 'work-mismatch' } },
  async play() {
    const dialog = await openPlace();
    await see(dialog, 'No ratings yet');
    await userEvent.click(stars(dialog)[6]!);
    await see(dialog, 'These belong to different works. Choose places from one work.');
  },
};

/** One save at a time: the stars are read-only until Main has answered, so presses cannot overtake each other. */
export const RatingWaitsForTheSave: Story = {
  args: { frames: [e3], scenario: { ...fixture.populated, delay: 250, log: writes } },
  async play() {
    writes.length = 0;
    const dialog = await openPlace();
    await within(dialog).findByText('214 ratings', undefined, { timeout: 4000 });
    const root = dialog.querySelector<HTMLElement>('[data-slot="rating-control"]')!;
    await expect(root).not.toHaveAttribute('data-readonly');
    await userEvent.click(stars(dialog)[6]!);
    await waitFor(() => expect(root).toHaveAttribute('data-readonly'));
    // A press while saving is ignored.
    await userEvent.click(stars(dialog)[8]!, { pointerEventsCheck: 0 });
    await see(dialog, 'Your rating: 7/10');
    await waitFor(() => expect(root).not.toHaveAttribute('data-readonly'));
    await expect(writes.filter(entry => entry === 'rate')).toHaveLength(1);
  },
};

/** Choosing across Works keeps what Main allows: an edition of the same Work beside an episode, and the first Work's places given up for another's. */
export const ChooseAcrossWorks: Story = {
  args: { sources: fixture.crossWorkSources },
  async play() {
    const dialog = await screen.findByRole('dialog');
    const choose = async (kind: string, query: string, option: RegExp) => {
      const tab = within(dialog).queryByRole('tab', { name: kind });
      if (tab) await userEvent.click(tab);
      const search = await within(dialog).findByRole('combobox', { name: kind }, { timeout: 4000 });
      await waitFor(() => expect(search).toBeEnabled());
      await waitFor(async () => {
        if (search.getAttribute('aria-expanded') !== 'true') await userEvent.click(search);
        await expect(search).toHaveAttribute('aria-expanded', 'true');
      }, { timeout: 5000 });
      await userEvent.clear(search);
      await userEvent.type(search, query);
      await chooseOption(screen, option);
    };
    await choose('Episodes', 'Hunsford', /Episode 3/);
    await choose('Releases', 'Blu-ray', /Blu-ray/);
    await seeRole(dialog, 'button', 'Remove Episode 3 · Hunsford');
    await seeRole(dialog, 'button', 'Remove Blu-ray box (2005)');
    await choose('Releases', 'Manga', /Manga/);
    await seeRole(dialog, 'button', 'Remove Manga box set');
    await expect(within(dialog).queryByRole('button', { name: 'Remove Episode 3 · Hunsford' })).toBeNull();
    await expect(within(dialog).queryByRole('button', { name: 'Remove Blu-ray box (2005)' })).toBeNull();
  },
};
export const ChooseAcrossWorksPhone: Story = { ...ChooseAcrossWorks, globals: phone };

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
    await see(dialog, /\/ 10$/);
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
