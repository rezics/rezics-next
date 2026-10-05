import type { Meta, StoryObj } from '@storybook/react-vite';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import { useMemo } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { SubjectProjections } from './subject-projections.tsx';

// A subject's places with each one's own figures: well rated, thin, unrated, and hidden by the reader's position.

const phone = { viewport: { value: 'phone' } } as const;
const fits = async () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const see = (container: HTMLElement, text: string | RegExp) =>
  waitFor(() => expect(within(container).getByText(text)).toBeVisible(), { timeout: 4000 });

function Projections({ locale, scenario }: { locale: UiLocale; scenario: fixture.Scenario }) {
  const api = useMemo(() => fixture.memoryScopedRatingApi(scenario), [scenario]);
  return <div className="mx-auto max-w-3xl p-4 sm:p-6">
    <SubjectProjections subject={fixture.subject.iri} api={api} locale={locale} messages={messages[locale]} />
  </div>;
}

const meta = {
  title: 'Scoped rating/Subject projections',
  component: Projections,
  args: { locale: 'en', scenario: fixture.populated },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: localizedPath(resourceHref('/e/', 'elizabeth-bennet'), 'en') } },
} satisfies Meta<typeof Projections>;
export default meta;
type Story = StoryObj<typeof meta>;

const row = (canvas: ReturnType<typeof within>, name: string) =>
  canvas.getByRole('link', { name: new RegExp(name) }).closest('[data-projection]') as HTMLElement;

/** Each place has its own figure for the question; a thin place shows its count and how many more reveal the average. */
export const Populated: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, '190 ratings');
    await expect(canvas.getByRole('heading', { name: 'Ratings by part' })).toBeVisible();
    await expect(within(row(canvas, 'Episode 1')).getByText(/\/ 10$/)).toBeVisible();
    await see(row(canvas, 'Episode 4'), '3 ratings');
    await see(row(canvas, 'Episode 4'), '7 more ratings will reveal the average.');
    await expect(within(row(canvas, 'Episode 4')).queryByText(/\/ 10/)).toBeNull();
    await see(row(canvas, 'Episode 5'), '76 ratings');
    // One place is later in the story than the reader has read: counted, never named.
    await expect(canvas.getByText('1 more is hidden until you reach it.')).toBeVisible();
    await expect(canvas.queryByText(/Episode 6/)).toBeNull();
    await expect(canvas.getAllByText('How well written is this character here?').length).toBeGreaterThan(1);
    await fits();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const PopulatedDarkPhone: Story = { ...Populated, globals: { ...phone, theme: 'dark' } };

/** The names of the places could not be read: a retry note, never "hidden until you reach it" or "nobody has rated". */
export const SummariesFailed: Story = {
  args: { scenario: { ...fixture.populated, summaryFails: true } },
  async play({ canvasElement }) {
    await see(canvasElement, 'This could not be loaded right now. Try again in a moment.');
    await expect(canvasElement.querySelector('[data-hidden-parts]')).toBeNull();
    await expect(within(canvasElement).queryByText(/hidden until you reach/)).toBeNull();
    await expect(within(canvasElement).queryByText('Nobody has rated this in a specific part yet.')).toBeNull();
    await expect(within(canvasElement).getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

/** Nobody has rated the subject in any place yet: the section is not drawn, neither its heading nor an empty note. */
export const Empty: Story = {
  args: { scenario: fixture.empty },
  async play({ canvasElement }) {
    await waitFor(() => expect(within(canvasElement).queryByText('Loading…')).toBeNull());
    await expect(canvasElement.querySelector('[data-subject-projections]')).toBeNull();
    await expect(within(canvasElement).queryByText('Ratings by part')).toBeNull();
    await expect(within(canvasElement).queryByText('Nobody has rated this in a specific part yet.')).toBeNull();
    await fits();
  },
};
export const EmptyPhone: Story = { ...Empty, globals: phone };

/** Places with no accepting question are omitted, including on an otherwise populated page. */
export const ApplicablePlacesOnly: Story = {
  args: { scenario: { ...fixture.populated, questions: { [fixture.populated.places![0]!.projection.id]: [fixture.writing] } } },
  async play({ canvasElement }) {
    await see(canvasElement, '190 ratings');
    await expect(canvasElement.querySelectorAll('[data-projection]')).toHaveLength(1);
    await expect(within(canvasElement).queryByText(/No question applies/)).toBeNull();
  },
};
export const ContinueAfterAnUnrateablePage: Story = {
  args: { scenario: { ...fixture.populated, pageSize: 3,
    questions: { [fixture.populated.places![4]!.projection.id]: [fixture.writing] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Show more' })).toBeVisible());
    await expect(canvasElement.querySelectorAll('[data-projection]')).toHaveLength(0);
    await expect(canvas.queryByText('Nobody has rated this in a specific part yet.')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await see(canvasElement, '76 ratings');
  },
};

/** Every place is short of the display threshold or unrated: counts show, no average, no zero. */
export const BelowThreshold: Story = {
  args: { scenario: fixture.belowThreshold },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, '9 ratings');
    await expect(canvas.getByText('1 more rating will reveal the average.')).toBeVisible();
    await expect(canvas.getByText('7 more ratings will reveal the average.')).toBeVisible();
    await expect(canvas.getByText('No ratings yet')).toBeVisible();
    await expect(canvas.queryByText(/\/ 10/)).toBeNull();
    await fits();
  },
};
export const BelowThresholdPhone: Story = { ...BelowThreshold, globals: phone };

/** Every place is ahead of the reader: no names or numbers, only how many are hidden. */
export const SpoilerHidden: Story = {
  args: { scenario: fixture.allHidden },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, '3 more are hidden until you reach them.');
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByText(/Episode|ratings/)).toBeNull();
    await fits();
  },
};
export const SpoilerHiddenPhone: Story = { ...SpoilerHidden, globals: phone };

/** A long list comes a page at a time. */
export const ShowMore: Story = {
  args: { scenario: { ...fixture.populated, pageSize: 3 } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await see(canvasElement, '190 ratings');
    await expect(canvas.queryByText('76 ratings')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await see(canvasElement, '76 ratings');
    // The last page has one place left; with it the button goes.
    await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
    await see(canvasElement, '1,280 ratings');
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull());
  },
};

/** Main cannot answer: the reason shows with a way to try again, and the page around it stays. */
export const Failed: Story = {
  args: { scenario: { ...fixture.populated, listFails: 'unavailable' } },
  async play({ canvasElement }) {
    await see(canvasElement, 'This could not be loaded right now. Try again in a moment.');
    await expect(within(canvasElement).getByRole('button', { name: 'Try again' })).toBeVisible();
    await fits();
  },
};

const localized = (locale: UiLocale): Story => ({
  globals: phone,
  args: { locale },
  async play({ canvasElement }) {
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-projection]').length).toBeGreaterThan(2), { timeout: 4000 });
    await waitFor(() => expect(canvasElement.querySelector('[data-rating-mean="shown"]')).not.toBeNull(), { timeout: 4000 });
    await expect(canvasElement.querySelector('[data-hidden-parts]')).not.toBeNull();
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
