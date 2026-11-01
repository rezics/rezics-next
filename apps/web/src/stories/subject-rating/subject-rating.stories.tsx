import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { RatingControlView } from '../../features/pages/rating-control';
import { RatingsView } from '../../features/pages/subject-ratings-view';
import { GLOBAL, type PublicFigure, type Ratings } from '../../features/pages/subject-ratings';
import { ratingsFixtures, standardRatingQuestion } from '../../kernel/fake/ratings';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

const ready = ratingsFixtures['subject-ratings-global'].preview;
const subject = '00000000-0000-4000-8000-000000000001';

function Figures({
  figure,
  imported = false,
  data = ready,
}: {
  figure?: PublicFigure;
  imported?: boolean;
  data?: Ratings;
}) {
  const locale = getLocale();
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
      <RatingsView
        id="ratings"
        subject={subject}
        locale={locale}
        data={{
          ...data,
          figure: figure ?? data.figure,
          statistics: imported ? ratingsFixtures['subject-ratings-imported'].preview.statistics : data.statistics,
        }}
      />
    </main>
  );
}

function Vote({ failed = false }: { failed?: boolean }) {
  const [units, setUnits] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const locale = getLocale();
  return (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <RatingControlView
        question={standardRatingQuestion}
        subjectId={subject}
        locale={locale}
        returnTo={`/${locale}/subjects/${subject}/kokoro`}
        state={{ kind: 'ready', units }}
        pending={false}
        failure={failure}
        onSet={(value) => {
          if (failed) setFailure(m.subject_rating_control_error());
          else setUnits(value);
        }}
        onClear={() => setUnits(null)}
      />
    </div>
  );
}

const meta = {
  title: 'Patterns/Subjects/Subject Rating',
  component: Figures,
  parameters: { layout: 'fullscreen' },
  render: () => <Figures />,
} satisfies Meta<typeof Figures>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText(/8.4/)).toHaveLength(1);
    await userEvent.click(within(canvasElement).getByText(m.subject_ratings_distribution()));
    await expect(canvasElement.querySelector('[data-slot="rating-distribution"]')).toHaveAttribute('open');
  },
};
export const Pending: Story = {
  render: () => <Figures figure={{ ...ready.figure, count: 0, state: 'updating', mean: null, score: null }} />,
};
export const BelowThreshold: Story = {
  render: () => <Figures figure={{ ...ready.figure, count: 3, state: 'insufficient_data', mean: null, score: null }} />,
};
export const Empty: Story = {
  render: () => <Figures figure={{ ...ready.figure, count: 0, state: 'insufficient_data', mean: null, score: null }} />,
};
export const PublishedZero: Story = {
  render: () => <Figures figure={{ ...ready.figure, mean: 0, score: null }} />,
};
export const Imported: Story = { render: () => <Figures imported /> };
export const Unavailable: Story = {
  render: () => (
    <div className="p-4">
      <RatingsView data={null} id="ratings" subject={subject} locale={getLocale()} />
    </div>
  ),
};
export const SaveClearZero: Story = {
  render: () => <Vote />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('slider'));
    await userEvent.keyboard('{Home}');
    await userEvent.click(view.getByRole('button', { name: m.subject_rating_control_save() }));
    await expect(view.getByRole('button', { name: m.subject_rating_control_clear() })).toBeEnabled();
    await expect(view.getByRole('slider')).toHaveAttribute('aria-valuenow', '0');
    await userEvent.click(view.getByRole('button', { name: m.subject_rating_control_clear() }));
    await expect(view.getByText(m.subject_rating_control_unrated())).toBeVisible();
  },
};
export const SaveFailure: Story = {
  render: () => <Vote failed />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('slider'));
    await userEvent.keyboard('{Home}');
    await userEvent.click(view.getByRole('button', { name: m.subject_rating_control_save() }));
    await expect(view.getByRole('status')).toHaveTextContent(m.subject_rating_control_error());
    await expect(view.getByRole('button', { name: m.subject_rating_control_clear() })).toBeDisabled();
  },
};

// Illustrative supplied data only: this does not enable Realm discovery or change readRatings' three-Realm limit.
const suppliedContexts: Ratings = {
  ...ready,
  realms: [
    { id: GLOBAL, name: 'Duplicate Global must be omitted' },
    ...[
      'Readers comparing translations across languages and editions with a deliberately long context name',
      'A very long unbroken context label: ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'Night Shift Translators',
      'Hearth and Skillet',
      'The Quiet Novel Club',
      'Weekend Readers',
      'Small Press Discussion',
      'Archive Readers',
    ].map((name, index) => ({ id: `supplied-context-${index}`, name })),
  ],
  figures: [
    ...ready.figures,
    ...[40, 30, 20, 10, 8, 6, 0, 0].map((count, index) => ({
      population: `supplied-context-${index}`,
      count,
      ...(count > 0 ? { mean: 16 } : {}),
    })),
  ],
};

export const ManySuppliedContexts: Story = {
  render: () => <Figures data={suppliedContexts} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByText(m.subject_ratings_comparisons()));
    await expect(canvasElement.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(5);
    await expect(view.queryByText('Duplicate Global must be omitted')).not.toBeInTheDocument();
    const more = view.getByRole('button', { name: m.subject_ratings_more_comparisons({ count: '3' }) });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    await expect(canvasElement.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(8);
    await expect(view.getByText('Archive Readers')).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.subject_ratings_fewer_comparisons() }));
    await expect(canvasElement.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(5);
  },
};

export const ContextStates: Story = {
  render: () => (
    <Figures
      data={{
        ...ready,
        realms: [
          { id: 'missing', name: 'Figure not supplied' },
          { id: 'empty', name: 'No ratings yet' },
          { id: 'threshold', name: 'Below publication threshold' },
          { id: 'updating', name: 'Publication updating' },
        ],
        figures: [
          ...ready.figures,
          { population: 'empty', count: 0 },
          { population: 'threshold', count: 3, remaining: 2 },
          { population: 'updating', count: 12, mean: 17, freshness: { asOf: null, updating: true } },
        ],
      }}
    />
  ),
};

export const AllZeroDistribution: Story = {
  render: () => (
    <Figures
      data={{
        ...ready,
        figures: ready.figures.map((item) => ({ ...item, histogram: Array.from({ length: 21 }, () => 0) })),
      }}
    />
  ),
};

export const UpdatingDistribution: Story = {
  render: () => (
    <Figures
      data={{
        ...ready,
        figures: ready.figures.map((item) => ({ ...item, freshness: { asOf: null, updating: true } })),
      }}
    />
  ),
};

export const MissingDistribution: Story = {
  render: () => <Figures data={{ ...ready, figures: [] }} />,
};

export const SteppedDistribution: Story = {
  render: () => (
    <Figures
      data={{
        ...ready,
        question: { ...ready.question, revision: 7, scale: { min: 0, max: 40, displayStep: 4 } },
        figure: { ...ready.figure, scale: { min: 0, max: 40, displayStep: 4 } },
        figures: [
          {
            population: GLOBAL,
            count: ready.figure.count,
            mean: 33.6,
            histogram: [0, 0, 0, 0, 0, 0, 0, 100, 600, 500, 3],
          },
        ],
      }}
    />
  ),
};
