import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PageStory, pagePaths, pageReady } from '../page';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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

function Vote({ failed = false, pending = false }: { failed?: boolean; pending?: boolean }) {
  const [units, setUnits] = useState<number | null>(pending ? 15 : null);
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
        pending={pending}
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

async function expectComfortableAction(action: HTMLElement) {
  const bounds = action.getBoundingClientRect();
  await expect(bounds.height).toBeGreaterThanOrEqual(44);
  await expect(bounds.width).toBeGreaterThanOrEqual(44);
  await expect(getComputedStyle(action).whiteSpace).toBe('normal');

  // Exercise the current translated copy in a narrow column without replacing its accessible name.
  const maxWidth = action.style.maxWidth;
  try {
    action.style.maxWidth = '4rem';
    await expect(action.scrollWidth).toBeLessThanOrEqual(action.clientWidth);
    await expect(action.scrollHeight).toBeLessThanOrEqual(action.clientHeight);
    await expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  } finally {
    action.style.maxWidth = maxWidth;
  }
}

async function expectKeyboardFocus(action: HTMLElement) {
  await expect(action).toHaveFocus();
  await expect(action.matches(':focus-visible')).toBe(true);
  const style = getComputedStyle(action);
  await expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  await expect(style.outlineStyle).toBe('solid');
}

const meta = {
  title: 'Subjects/Subject Rating',
  id: 'patterns-subjects-subject-rating',
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
    const save = view.getByRole('button', { name: m.subject_rating_control_save() });
    const clear = view.getByRole('button', { name: m.subject_rating_control_clear() });
    await expectComfortableAction(save);
    await expectComfortableAction(clear);
    await expect(save).toBeDisabled();
    await expect(clear).toBeDisabled();
    await userEvent.click(view.getByRole('slider'));
    await userEvent.keyboard('{Home}');
    await expect(view.getByRole('slider')).toHaveAttribute('aria-valuenow', '0');
    await userEvent.keyboard('{ArrowRight}');
    await expect(view.getByRole('slider')).toHaveAttribute('aria-valuenow', '1');
    await userEvent.keyboard('{Home}');
    await userEvent.tab();
    await expectKeyboardFocus(save);
    await userEvent.click(view.getByRole('button', { name: m.subject_rating_control_save() }));
    await expect(view.getByRole('button', { name: m.subject_rating_control_clear() })).toBeEnabled();
    await expect(view.getByRole('slider')).toHaveAttribute('aria-valuenow', '0');
    await expect(save).toBeDisabled();
    await userEvent.tab();
    await expectKeyboardFocus(clear);
    await userEvent.click(view.getByRole('button', { name: m.subject_rating_control_clear() }));
    await expect(view.getByText(m.subject_rating_control_unrated())).toBeVisible();
  },
};
export const SignedOut: Story = {
  render: () => (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <RatingControlView
        question={standardRatingQuestion}
        subjectId={subject}
        locale={getLocale()}
        returnTo={`/${getLocale()}/subjects/${subject}/kokoro`}
        state={{ kind: 'signed-out' }}
        pending={false}
        failure={null}
        onSet={() => {}}
        onClear={() => {}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const signIn = within(canvasElement).getByRole('link', { name: m.account_sign_in() });
    await expect(signIn).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/subjects/${subject}/kokoro`)}`,
    );
    await expectComfortableAction(signIn);
    await userEvent.tab();
    await expectKeyboardFocus(signIn);
  },
};
export const Saving: Story = {
  render: () => <Vote pending />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(canvasElement.querySelector('[data-slot="rating-control-reserved"]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(view.getByRole('slider')).toBeDisabled();
    await expect(view.getByRole('slider')).toHaveAttribute('aria-valuenow', '15');
    for (const name of [m.subject_rating_control_save(), m.subject_rating_control_clear()]) {
      const action = view.getByRole('button', { name });
      await expect(action).toBeDisabled();
      await expectComfortableAction(action);
    }
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
export const UncertainSave: Story = {
  render: () => (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <RatingControlView
        question={standardRatingQuestion}
        subjectId={subject}
        locale={getLocale()}
        returnTo={`/${getLocale()}/subjects/${subject}/kokoro`}
        state={{ kind: 'ready', units: 15 }}
        pending={false}
        retryable
        failure={m.subject_rating_control_uncertain()}
        onSet={() => {}}
        onClear={() => {}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.subject_rating_control_uncertain());
    await expect(view.getByRole('button', { name: m.subject_rating_control_save() })).toBeEnabled();
  },
};
export const StaleReview: Story = {
  render: () => (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <RatingControlView
        question={standardRatingQuestion}
        subjectId={subject}
        locale={getLocale()}
        returnTo={`/${getLocale()}/subjects/${subject}/kokoro`}
        state={{ kind: 'ready', units: 0 }}
        pending={false}
        failure={m.subject_rating_control_stale()}
        onSet={() => {}}
        onClear={() => {}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.subject_rating_control_stale());
    await expect(view.getByRole('button', { name: m.subject_rating_control_save() })).toBeDisabled();
  },
};

// Retained illustrative presentation data; connected directory stories below use the actual route and BFF.
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

/** UNRUN connected journey cases; use the same IDs at phone390/desktop1280 in all eight locale globals. */
export const PopulationChooser: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} ratingsFixture="subject-ratings-realms" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    const first = await view.findByRole('checkbox', { name: 'The Quiet Novel Club' });
    await expect(view.getByRole('group', { name: m.rating_population_choose() })).toContainElement(first);
    first.focus();
    await userEvent.keyboard(' ');
    await expect(first).toBeChecked();
    await userEvent.tab();
    await expect(view.getByRole('checkbox', { name: 'Night Shift Translators' })).toHaveFocus();
    for (const name of ['Night Shift Translators', 'Hearth and Skillet', 'Weekend Readers'])
      await userEvent.click(view.getByRole('checkbox', { name }));
    await waitFor(() =>
      expect(context.canvasElement.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(4),
    );
    const remove = view.getByRole('button', { name: m.rating_population_remove({ name: 'Weekend Readers' }) });
    await expectComfortableAction(remove);
    await userEvent.click(remove);
    await expect(view.getByRole('checkbox', { name: 'Weekend Readers' })).not.toBeChecked();
    await expect(view.getByText(m.rating_population_choose())).toHaveFocus();
    const next = view.getByRole('button', { name: m.rating_population_next() });
    await expect(next).toBeDisabled();
    await expect(view.getAllByText(m.rating_population_source_global()).length).toBeGreaterThan(0);
    await expect(context.canvasElement.scrollWidth).toBeLessThanOrEqual(context.canvasElement.clientWidth);
  },
};
export const SparsePopulationPage: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} ratingsFixture="subject-ratings-sparse" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await expect(await view.findByText(m.rating_population_empty_page())).toBeVisible();
    const next = view.getByRole('button', { name: m.rating_population_next() });
    await expectComfortableAction(next);
    next.focus();
    await userEvent.keyboard('{Enter}');
    const first = await view.findByRole('checkbox', { name: 'The Quiet Novel Club' });
    await expect(first).toHaveFocus();
    await userEvent.click(view.getByRole('button', { name: m.rating_population_restart() }));
    await expect(await view.findByText(m.rating_population_empty_page())).toBeVisible();
  },
};
export const IndependentSources: Story = {
  render: () => (
    <PageStory visitor="Signed In" path={pagePaths.subject} ratingsFixture="subject-ratings-statistics-failed" />
  ),
  play: async (context) => {
    await pageReady(context);
    const view = within(context.canvasElement);
    await expect(await view.findByRole('checkbox', { name: 'The Quiet Novel Club' })).toBeEnabled();
    const figure = context.canvasElement.querySelector('[data-slot="public-rating-figure"]');
    const histogram = context.canvasElement.querySelector('[data-slot="rating-distribution"]');
    await expect(figure).not.toBeNull();
    await expect(histogram).not.toBeNull();
    await expect(context.canvasElement.querySelector('[data-slot="rating-control-reserved"]')).not.toBeNull();
    await userEvent.click(view.getByText(m.subject_ratings_provenance()));
    const failure = within(context.canvasElement.querySelector<HTMLElement>('[data-source="statistics"]')!);
    const retry = failure.getByRole('button', { name: m.subject_section_retry() });
    await expectComfortableAction(retry);
    await userEvent.click(retry);
    await expect(context.canvasElement.querySelector('[data-slot="public-rating-figure"]')).toBe(figure);
    await expect(context.canvasElement.querySelector('[data-slot="rating-distribution"]')).toBe(histogram);
  },
};
