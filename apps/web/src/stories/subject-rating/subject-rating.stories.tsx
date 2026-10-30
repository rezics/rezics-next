import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { RatingControlView } from '../../features/pages/rating-control';
import { RatingsView } from '../../features/pages/subject-ratings-view';
import type { PublicFigure } from '../../features/pages/subject-ratings';
import { ratingsFixtures, standardRatingQuestion } from '../../kernel/fake/ratings';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { ResultList } from '../../search/results';

const ready = ratingsFixtures['subject-ratings-global'].preview;
const subject = '00000000-0000-4000-8000-000000000001';

function Figures({ figure = ready.figure, imported = false }: { figure?: PublicFigure; imported?: boolean }) {
  const locale = getLocale();
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
      <RatingsView
        id="ratings"
        subject={subject}
        locale={locale}
        data={{
          ...ready,
          figure,
          statistics: imported ? ratingsFixtures['subject-ratings-imported'].preview.statistics : [],
        }}
      />
      <ResultList
        hits={[{ id: subject, type: 'schema:Book', labels: { en: 'Kokoro', 'zh-Hans': '心' }, figure }]}
        locale={locale}
        hitTypes={{ 'schema:Book': { en: 'Book', 'zh-Hans': '图书' } }}
        yearProperties={[]}
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
    await expect(within(canvasElement).getAllByText(/8.4/)).toHaveLength(2);
    await userEvent.click(within(canvasElement).getByText(m.subject_ratings_distribution()));
    await expect(canvasElement.querySelector('details')).toHaveAttribute('open');
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
