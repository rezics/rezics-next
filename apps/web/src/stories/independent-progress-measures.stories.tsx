import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ProgressSessionPage, ProgressSessionView } from '../library/progress-reads';
import { IndependentMeasuresVisit } from '../library/independent-measures/visit';
import { m } from '../paraglide/messages.js';

type Scenario = 'refresh' | 'draft' | 'correction' | 'withdrawn';

function progressSession(
  revision: number,
  chapter: string,
  volume: string,
  options: { volumeMax?: string; withdrawn?: boolean } = {},
): ProgressSessionView {
  const chapterMeasure = {
    unit: 'chapter',
    amount: chapter,
    total: '24',
    primary: true,
    meaning: 'known' as const,
    recordingState: 'supported' as const,
    unitLabel: 'chapters',
    inputRules: { min: '0', max: '24', step: '1', total: 'optional' as const },
  };
  const secondMeasure = options.withdrawn
    ? {
        unit: 'page',
        amount: '4',
        total: null,
        primary: false,
        meaning: 'known' as const,
        recordingState: 'unsupported' as const,
        unitLabel: 'pages',
      }
    : {
        unit: 'volume',
        amount: volume,
        total: '12',
        primary: false,
        meaning: 'known' as const,
        recordingState: 'supported' as const,
        unitLabel: 'volumes',
        inputRules: { min: '0', max: options.volumeMax ?? '12', step: '1', total: 'optional' as const },
      };
  return {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000020',
    subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
    versionSubjectId: null,
    mode: 'scalar_amount',
    unit: 'chapter',
    total: '24',
    amount: chapter,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision,
    startedAt: '2026-04-02T15:04:05.000Z',
    completedAt: null,
    subject: null,
    versionSubject: null,
    meaning: 'known',
    recordingState: 'supported',
    unitLabel: 'chapters',
    measures: [chapterMeasure, secondMeasure],
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
  };
}

function IndependentProgressJourney({ scenario }: { scenario: Scenario }) {
  const [session] = useState(() => progressSession(3, '10', '2'));
  const latest = useMemo(() => {
    if (scenario === 'correction') return progressSession(4, '11', '2', { volumeMax: '2' });
    if (scenario === 'withdrawn') return progressSession(4, '11', '2', { withdrawn: true });
    return progressSession(4, '11', '3');
  }, [scenario]);
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">Independent reading progress</h1>
      <IndependentMeasuresVisit
        session={session}
        credential={() => ({ 'X-CSRF-Token': 'story-token' })}
        isCurrent={() => true}
        onAcknowledged={() => {}}
        onRefresh={async () =>
          ({ signedIn: true, idempotencyKey: 'story-read', session: latest }) satisfies ProgressSessionPage
        }
        sender={async () => ({ ok: false, reason: 'conflict' })}
      />
    </main>
  );
}

function RoutedIndependentProgress({ scenario }: { scenario: Scenario }) {
  const router = useMemo(() => {
    const route = createRootRoute({ component: () => <IndependentProgressJourney scenario={scenario} /> });
    return createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  }, [scenario]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Interfaces/Library/Independent progress measures',
  component: RoutedIndependentProgress,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RoutedIndependentProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

async function refreshWithoutDraft({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const refresh = canvas.getByRole('button', { name: m.library_progress_measures_refresh() });
  await expect(refresh.className).toContain('min-h-11');
  await expect(refresh.className).toContain('min-w-11');
  await userEvent.click(refresh);
  const amounts = canvas.getAllByLabelText(m.library_progress_amount()) as HTMLInputElement[];
  await expect(amounts.map((input) => input.value)).toEqual(['11', '3']);
  await userEvent.click(canvas.getByRole('button', { name: m.library_progress_measure_save() }));
  await expect(canvas.queryByRole('region', { name: m.library_progress_measures_review() })).toBeNull();
}

async function preserveVolumeDraft({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const amounts = canvas.getAllByLabelText(m.library_progress_amount()) as HTMLInputElement[];
  await userEvent.clear(amounts[1]!);
  await userEvent.type(amounts[1]!, '7');
  await userEvent.click(canvas.getByRole('button', { name: m.library_progress_measures_refresh() }));
  await expect(amounts.map((input) => input.value)).toEqual(['11', '7']);
  await userEvent.click(canvas.getByRole('button', { name: m.library_progress_measure_save() }));
  await canvas.findByRole('region', { name: m.library_progress_measures_review() });
  await expect(canvas.getByText(m.library_progress_measures_review_unchanged({ unit: 'chapter' }))).toBeVisible();
  await expect(
    canvas.getByText(m.library_progress_measures_review_amount({ unit: 'volume', amount: '7' })),
  ).toBeVisible();
}

async function correctChangedRules({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const amount = canvas.getAllByLabelText(m.library_progress_amount())[1]!;
  await userEvent.clear(amount);
  await userEvent.type(amount, '3');
  await userEvent.click(canvas.getByRole('button', { name: m.library_progress_measures_refresh() }));
  await canvas.findByRole('alert', { name: m.library_progress_measures_correction() });
}

async function refreshWithdrawnMeasure({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const amount = canvas.getAllByLabelText(m.library_progress_amount())[1]!;
  await userEvent.clear(amount);
  await userEvent.type(amount, '7');
  await userEvent.click(canvas.getByRole('button', { name: m.library_progress_measures_refresh() }));
  await expect(canvas.getAllByLabelText(m.library_progress_amount())).toHaveLength(1);
  await expect(canvas.getByText('pages')).toBeVisible();
}

export const RefreshWithoutDraft: Story = {
  args: { scenario: 'refresh' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: refreshWithoutDraft,
};
export const PreserveVolumeDraft: Story = {
  args: { scenario: 'draft' },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: preserveVolumeDraft,
};
export const CorrectChangedRules: Story = {
  args: { scenario: 'correction' },
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: correctChangedRules,
};
export const RefreshWithdrawnMeasure: Story = {
  args: { scenario: 'withdrawn' },
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: refreshWithdrawnMeasure,
};
