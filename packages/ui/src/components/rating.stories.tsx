import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { withSurface } from '../stories/support.tsx';
import { metaText } from './meta-line.tsx';
import {
  RatingInput,
  RatingSummary,
  ratingMean,
  type ImportedRating,
  type RatingAggregate,
  type RatingPopulation,
  type RatingScale,
} from './rating.tsx';

const meta = {
  title: 'Rezics UI/Rating',
  component: RatingSummary,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: {
    docs: {
      description: {
        component:
          'The rating figures of one subject and the control that writes the reader’s vote. A score always appears with its population and count; the page’s own population is the headline and every other population is a labelled list, never averaged or substituted. The mean and the distribution appear only from the threshold the aggregate returns; below it only the count, the votes still needed and the reason appear, and with no votes nothing is drawn. Imported scores keep their source and scale. The reader rates with one slider and can clear the vote.',
      },
    },
  },
} satisfies Meta<typeof RatingSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The standard question: stored as integer units 0 to 20, shown as 0 to 10 in steps of 0.5. */
const scale: RatingScale = { minimum: 0, maximum: 20, unitsPerPoint: 2 };

const rezics: RatingPopulation = { id: 'population-global', kind: 'global', label: 'REZICS' };
const realm = (id: string, label: string): RatingPopulation => ({ id, kind: 'realm', label });

/** Votes per stored unit, bell shaped around `center` units, adding up to exactly `total`. */
function spread(total: number, center: number, width: number): number[] {
  const weights = Array.from({ length: scale.maximum - scale.minimum + 1 }, (_, unit) =>
    Math.exp(-((unit - center) ** 2) / (2 * width ** 2)),
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  const votes = weights.map((weight) => Math.round((weight / sum) * total));
  const peak = votes.indexOf(Math.max(...votes));
  votes[peak]! += total - votes.reduce((a, b) => a + b, 0);
  return votes;
}

/** Builds the aggregate the way the rating module returns it: count and sum are components of the histogram. */
function aggregate(
  population: RatingPopulation,
  histogram: number[],
  options: { threshold?: number; updating?: boolean } = {},
): RatingAggregate {
  return {
    population,
    count: histogram.reduce((a, b) => a + b, 0),
    sum: histogram.reduce((total, votes, unit) => total + votes * (scale.minimum + unit), 0),
    histogram,
    threshold: options.threshold ?? 5,
    ...(options.updating === undefined ? {} : { updating: options.updating }),
  };
}

const empty = () => Array<number>(21).fill(0);
const few = (...units: number[]) => {
  const votes = empty();
  for (const unit of units) votes[unit]! += 1;
  return votes;
};

const global = aggregate(rezics, spread(1203, 17, 3));
const hardSf = aggregate(realm('realm-hard-sf', 'Hard SF Readers'), spread(64, 18, 2));
const translators = aggregate(realm('realm-translators', 'Translators’ Guild'), spread(412, 15, 3.5));
const newcomers = aggregate(realm('realm-newcomers', 'Newcomers'), few(14, 16, 17));
const quiet = aggregate(realm('realm-quiet', 'Quiet Corner'), empty());
const cinema = aggregate(realm('realm-cinema', 'Cinema Club'), spread(120, 13, 4));

const vndb: ImportedRating = {
  source: 'VNDB',
  mean: 7.94,
  count: 4512,
  scale: { minimum: 1, maximum: 10 },
  asOf: '2026-10-01',
};
const bangumi: ImportedRating = {
  source: 'Bangumi',
  mean: 8.1,
  count: 25883,
  scale: { minimum: 1, maximum: 10 },
  asOf: '2026-09-28',
};

const mean = (value: RatingAggregate) => ratingMean(value, scale)!.toFixed(1);

const summary = (canvasElement: HTMLElement) => within(canvasElement).getByRole('region', { name: 'Ratings' });

export const HeadlineShowsPopulationAndCount: Story = {
  args: { headline: global, scale, locale: 'en' },
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(headline).toHaveAttribute('data-state', 'published');
    await expect(within(headline).getByText('1,203 ratings on REZICS')).toBeVisible();
    await expect(headline.textContent).toContain(`${mean(global)} out of 10`);
    await expect(within(region).getByRole('figure', { name: 'Distribution of ratings' })).toBeVisible();
    await expect(within(region).getAllByRole('row')).toHaveLength(22);
    await expect(region.querySelector('[data-slot="rating-populations"]')).toBeNull();
  },
};

export const RealmHeadlineBesideGlobal: Story = {
  args: { headline: hardSf, others: [global, translators], scale, locale: 'en' },
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    await expect(within(region).getByText('Showing ratings from Hard SF Readers.')).toBeVisible();
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(within(headline).getByText('64 ratings in Hard SF Readers')).toBeVisible();
    // Global sits beside the headline with its own figure and count, not blended into it.
    const beside = region.querySelector('[data-slot="rating-global"]') as HTMLElement;
    await expect(within(beside).getByText('1,203 ratings on REZICS')).toBeVisible();
    await expect(beside.textContent).toContain(mean(global));
    await expect(beside.textContent).not.toContain(mean(hardSf));
    await expect(headline.textContent).not.toContain('1,203');
    // The remaining population is the only entry in the list; Global is not repeated there.
    const list = within(region).getByRole('list', { name: 'Other populations' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await expect(within(list).getByText('412 ratings in Translators’ Guild')).toBeVisible();
  },
};

export const OtherPopulationsListedSeparately: Story = {
  args: { headline: global, others: [translators, cinema, newcomers, quiet, hardSf], scale, locale: 'en' },
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    const list = within(region).getByRole('list', { name: 'Other populations' });
    const rows = within(list).getAllByRole('listitem');
    await expect(rows).toHaveLength(3);
    // Each population keeps its own figure with its own name and count.
    await expect(rows[0]!.textContent).toContain(mean(translators));
    await expect(rows[0]!).toHaveTextContent('412 ratings in Translators’ Guild');
    await expect(rows[1]!).toHaveTextContent('120 ratings in Cinema Club');
    // Below the threshold only the count and the votes still needed appear, never a score.
    await expect(rows[2]!).toHaveTextContent('3 ratings in Newcomers');
    await expect(rows[2]!).toHaveTextContent('2 more ratings to show a score');
    await expect(rows[2]!.textContent).not.toMatch(/out of/);
    // The headline never absorbs another population's votes.
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(headline).toHaveTextContent('1,203 ratings on REZICS');
    await expect(headline.textContent).not.toContain(mean(translators));

    const more = within(region).getByRole('button', { name: 'Show 2 more' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5));
    const all = within(list).getAllByRole('listitem');
    await expect(all[3]!).toHaveTextContent('No ratings yet in Quiet Corner');
    await expect(all[3]!.textContent).not.toMatch(/\d/);
    await expect(all[4]!).toHaveTextContent('64 ratings in Hard SF Readers');
    await userEvent.click(within(region).getByRole('button', { name: 'Show fewer' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
  },
};

export const ImportedScoresLabelled: Story = {
  args: { headline: global, others: [translators], imported: [vndb, bangumi], scale, locale: 'en' },
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    const imported = region.querySelector('[data-slot="rating-imported"]') as HTMLElement;
    await expect(within(imported).getByText('Imported scores')).toBeVisible();
    await expect(within(imported).getByText(/never combined/i)).toBeVisible();
    const rows = within(within(imported).getByRole('list', { name: 'Imported scores' })).getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    await expect(rows[0]!).toHaveTextContent('VNDB');
    await expect(rows[0]!).toHaveTextContent(metaText(['7.94 out of 10', '4,512 ratings', 'as of Oct 1, 2026']));
    await expect(rows[1]!).toHaveTextContent('Bangumi');
    await expect(rows[1]!).toHaveTextContent(metaText(['8.1 out of 10', '25,883 ratings']));
    // Imported figures stay out of the native list and the native headline.
    const native = region.querySelector('[data-slot="rating-populations"]') as HTMLElement;
    await expect(native).not.toHaveTextContent('VNDB');
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(headline.textContent).not.toContain('7.94');
    await expect(headline).toHaveTextContent('1,203 ratings on REZICS');
  },
};

export const NoRatingsDrawsNothing: Story = {
  args: { headline: aggregate(rezics, empty()), others: [quiet], scale, locale: 'en' },
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(headline).toHaveAttribute('data-state', 'none');
    await expect(headline).toHaveTextContent('No ratings yet on REZICS');
    // Never a zero, never an empty histogram.
    await expect(headline.textContent).not.toMatch(/\d/);
    await expect(within(region).queryByRole('figure')).not.toBeInTheDocument();
    await expect(within(region).queryByRole('table')).not.toBeInTheDocument();
  },
};

export const BelowThresholdHidesDistribution: Story = {
  args: { headline: aggregate(rezics, few(14, 16, 17)), scale, locale: 'en' },
  render: (args) => (
    <div className="flex flex-col gap-10">
      <RatingSummary {...args} />
      <RatingSummary
        headline={aggregate(realm('realm-episode', 'Episode 12 viewers'), spread(9, 15, 2), { threshold: 10 })}
        labels={{ title: 'Episode ratings' }}
        locale="en"
        scale={scale}
      />
    </div>
  ),
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(headline).toHaveAttribute('data-state', 'withheld');
    await expect(within(headline).getByText('3 ratings on REZICS')).toBeVisible();
    await expect(within(headline).getByText('2 more ratings to show a score')).toBeVisible();
    await expect(headline.textContent).not.toMatch(/out of/);
    // The reason is given where the distribution would be.
    await expect(within(region).getByText(/appears from 5 ratings/)).toBeVisible();
    await expect(within(region).queryByRole('figure')).not.toBeInTheDocument();

    // A finer grain declares a higher threshold, and the summary follows what the aggregate says.
    const episode = within(canvasElement).getByRole('region', { name: 'Episode ratings' });
    await expect(within(episode).getByText('9 ratings in Episode 12 viewers')).toBeVisible();
    await expect(within(episode).getByText('1 more rating to show a score')).toBeVisible();
    await expect(within(episode).getByText(/appears from 10 ratings/)).toBeVisible();
    await expect(within(episode).queryByRole('figure')).not.toBeInTheDocument();
  },
};

export const AtThresholdShowsDistribution: Story = {
  args: { headline: aggregate(rezics, few(14, 16, 17, 17, 18)), scale, locale: 'en' },
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    const headline = region.querySelector('[data-slot="rating-headline"]') as HTMLElement;
    await expect(headline).toHaveAttribute('data-state', 'published');
    // 14 + 16 + 17 + 17 + 18 = 82 units over 5 votes is 8.2 points.
    await expect(headline).toHaveTextContent('8.2 out of 10');
    await expect(within(headline).getByText('5 ratings on REZICS')).toBeVisible();
    const figure = within(region).getByRole('figure', { name: 'Distribution of ratings' });
    await expect(within(figure).getByRole('row', { name: '8.5 2' })).toBeInTheDocument();
    await expect(within(region).queryByText(/appears from/)).not.toBeInTheDocument();
  },
};

export const UpdatingWhileMembersJoin: Story = {
  args: {
    headline: aggregate(realm('realm-hard-sf', 'Hard SF Readers'), spread(64, 18, 2), { updating: true }),
    scale,
    locale: 'en',
  },
  async play({ canvasElement }) {
    await expect(within(summary(canvasElement)).getByText('Updating')).toBeVisible();
  },
};

export const OwnVoteShownOnce: Story = {
  args: { headline: global, own: 17, scale, locale: 'en' },
  async play({ canvasElement }) {
    const own = summary(canvasElement).querySelector('[data-slot="rating-own"]') as HTMLElement;
    await expect(own).toHaveTextContent('Your rating8.5Only you can see this.');
  },
};

const longRealm = aggregate(
  realm(
    'realm-long',
    'The Society for the Preservation and Appreciation of Translated Speculative Fiction from Every Language',
  ),
  spread(88, 16, 3),
);
const cjkRealm = aggregate(realm('realm-cjk', '銀河英雄傳說愛好者協會'), spread(214, 17, 2.5));

export const LongAndCJKNames: Story = {
  args: { headline: global, others: [longRealm, cjkRealm, quiet], imported: [vndb], scale, locale: 'en' },
  decorators: [(Story) => <div className="w-80 max-w-full">{Story()}</div>],
  async play({ canvasElement }) {
    const region = summary(canvasElement);
    await expect(within(region).getByText(/88 ratings in The Society for the Preservation/)).toBeVisible();
    await expect(within(region).getByText('214 ratings in 銀河英雄傳說愛好者協會')).toBeVisible();
    // Long names wrap instead of widening the summary.
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth);
  },
  render: (args) => (
    <div className="flex flex-col gap-10">
      <RatingSummary {...args} />
      <RatingSummary
        {...args}
        headline={{ ...cjkRealm, population: realm('realm-cjk', '銀河英雄傳說愛好者協會') }}
        imported={undefined}
        labels={{
          title: '評分',
          outOf: '滿分 {max}',
          globalOne: '{population}有 {count} 個評分',
          globalOther: '{population}有 {count} 個評分',
          realmOne: '{population}有 {count} 個評分',
          realmOther: '{population}有 {count} 個評分',
          realmContext: '顯示「{population}」的評分。',
          others: '其他族群',
        }}
        locale="zh-Hant"
        others={[global]}
      />
    </div>
  ),
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  args: { headline: global, others: [translators, newcomers, quiet], imported: [vndb], own: 17, scale, locale: 'en' },
  async play({ canvasElement }) {
    await expect(within(summary(canvasElement)).getByRole('figure')).toBeVisible();
  },
  render: (args) => (
    <div className="grid max-w-4xl gap-10 md:grid-cols-2">
      <RatingSummary {...args} />
      <RatingInputDemo initial={null} />
    </div>
  ),
};

function RatingInputDemo({
  initial,
  onSave,
  fail,
}: {
  initial: number | null;
  onSave?: (units: number | null) => void;
  fail?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="max-w-sm">
      <RatingInput
        locale="en"
        onChange={async (units) => {
          onSave?.(units);
          if (fail) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            throw new Error('offline');
          }
          setValue(units);
        }}
        scale={scale}
        value={value}
      />
    </div>
  );
}

/** The input stories render `RatingInput`; the meta's required args stay satisfied by an unused summary. */
const inputArgs = { headline: aggregate(rezics, empty()), scale, locale: 'en' } as const;

const saved = fn();
const cleared = fn();

const readout = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('[data-slot="rating-value"]') as HTMLElement;

export const RateWithOneControl: Story = {
  args: inputArgs,
  render: () => <RatingInputDemo initial={null} onSave={saved} />,
  async play({ canvasElement }) {
    saved.mockClear();
    const canvas = within(canvasElement);
    // One control writes the vote.
    await expect(canvas.getAllByRole('slider')).toHaveLength(1);
    const slider = canvas.getByRole('slider', { name: /^Your rating/ });
    await expect(readout(canvasElement)).toHaveTextContent('Not rated');
    slider.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(saved).toHaveBeenLastCalledWith(20));
    await waitFor(() => expect(readout(canvasElement)).toHaveTextContent('10 out of 10'));
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(saved).toHaveBeenLastCalledWith(19));
    await waitFor(() => expect(readout(canvasElement)).toHaveTextContent('9.5 out of 10'));
    await expect(slider).toHaveValue('9.5');
  },
};

export const ClearOwnVote: Story = {
  args: inputArgs,
  render: () => <RatingInputDemo initial={17} onSave={cleared} />,
  async play({ canvasElement }) {
    cleared.mockClear();
    const canvas = within(canvasElement);
    await expect(readout(canvasElement)).toHaveTextContent('8.5 out of 10');
    await expect(canvas.getByRole('slider', { name: /^Your rating/ })).toHaveValue('8.5');
    await userEvent.click(canvas.getByRole('button', { name: 'Clear rating' }));
    await waitFor(() => expect(cleared).toHaveBeenCalledWith(null));
    await waitFor(() => expect(readout(canvasElement)).toHaveTextContent('Not rated'));
    await expect(canvas.getByRole('button', { name: 'Clear rating' })).toBeDisabled();
  },
};

export const FailedSaveRollsBack: Story = {
  args: inputArgs,
  render: () => <RatingInputDemo fail initial={14} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole('slider', { name: /^Your rating/ });
    slider.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(readout(canvasElement)).toHaveTextContent('7.5 out of 10'));
    await waitFor(() => expect(canvas.getByText('Your rating could not be saved.')).toBeVisible());
    await expect(readout(canvasElement)).toHaveTextContent('7 out of 10');
  },
};

export const Unrated: Story = {
  args: inputArgs,
  render: () => <RatingInputDemo initial={null} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(readout(canvasElement)).toHaveTextContent('Not rated');
    await expect(canvas.getByRole('slider', { name: 'Your rating Not rated' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Clear rating' })).toBeDisabled();
    await expect(canvas.queryByText('Your rating could not be saved.')).not.toBeInTheDocument();
  },
};
