import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useRef, useState, type ComponentProps } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { PersonalEntry } from '@rezics/client';
import { RichPrivateEntry } from '../library/rich-private-entry/view';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Library/Private priority review',
  id: 'patterns-library-private-priority-review',
  parameters: { layout: 'padded', admitted: ['personal_library'] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Scenario = 'preservation' | 'stale' | 'uncertain' | 'retired';
const subject = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000010', label: 'Kokoro' };
const initial: PersonalEntry = {
  subjectId: subject.id,
  annotationRevision: 4,
  note: 'Read the original edition next.',
  priority: 7,
  annotationUpdatedAt: '2026-01-01T00:00:00Z',
  sourceObservations: [
    {
      provider: 'reading-list',
      recordId: 'book-10',
      revision: 2,
      privacy: { status: 'unknown', sourceValue: 'friends-only' },
      sourceCreated: { status: 'known', value: '2025-01', precision: 'month', zone: 'unknown' },
      sourceUpdated: { status: 'absent' },
      recordedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

// Stable illustrative receiver states; running-product/native evidence belongs to the controller walkthrough.
function Review({ scenario }: { scenario: Scenario }) {
  const entry = useRef(initial);
  const [guard, setGuard] = useState({ incarnationId: subject.id, currentRevision: 3 });
  const transport = useMemo<NonNullable<ComponentProps<typeof RichPrivateEntry>['transport']>>(
    () => ({
      read: async () => ({
        kind: 'ready',
        viewer: 'story-reader',
        csrfToken: 'story-csrf-token',
        credential: 'story-captured-credential',
        entry: entry.current,
      }),
      annotations: async ({ data }) => {
        if (scenario === 'uncertain') return { kind: 'uncertain' };
        if (scenario === 'retired') return { kind: 'retired' };
        if (scenario === 'stale') {
          entry.current = { ...entry.current, note: 'A newer private note from another visit.' };
          setGuard({ incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000011', currentRevision: 1 });
          return { kind: 'conflict' };
        }
        entry.current = {
          ...entry.current,
          annotationRevision: entry.current.annotationRevision + 1,
          note:
            data.body.note.op === 'set'
              ? data.body.note.value
              : data.body.note.op === 'clear'
                ? null
                : entry.current.note,
          priority:
            data.body.priority.op === 'set'
              ? data.body.priority.value
              : data.body.priority.op === 'clear'
                ? null
                : entry.current.priority,
        };
        return { kind: 'saved', entry: entry.current };
      },
      sourceCorrection: async () => ({ kind: 'uncertain' }),
    }),
    [scenario],
  );
  return (
    <PatternStory visitor="Signed In" path={`/subjects/${subject.id}/kokoro`}>
      <div className="mx-auto max-w-3xl">
        <RichPrivateEntry
          subject={subject}
          session={{ state: 'signed-in', subject: 'story-reader', csrfToken: 'story-csrf-token' }}
          admitted
          returnTo={`/en/subjects/${subject.id}/kokoro`}
          entryGuard={guard}
          origin={{ lifetime: scenario, isCurrent: () => true, refreshEntry: async () => true }}
          transport={transport}
        />
      </div>
    </PatternStory>
  );
}

async function setRank(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const rank = await canvas.findByRole('spinbutton', { name: m.library_rich_entry_priority() });
  await userEvent.click(rank);
  await userEvent.clear(rank);
  await userEvent.type(rank, '1');
  await userEvent.tab();
  await userEvent.click(canvas.getByRole('button', { name: m.library_rich_entry_save() }));
  return canvas;
}
export const Preservation: Story = {
  render: () => <Review scenario="preservation" />,
  play: async ({ canvasElement }) => {
    const canvas = await setRank(canvasElement);
    await expect(canvas.getByRole('textbox', { name: m.library_rich_entry_note() })).toHaveValue(initial.note);
    await expect(canvas.getByText('friends-only', { exact: false })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.library_rich_entry_clear_priority() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_rich_entry_save() }));
    await expect(canvas.getByText(m.library_rich_entry_unranked())).toBeVisible();
  },
};
export const StaleIncarnation: Story = {
  render: () => <Review scenario="stale" />,
  play: async ({ canvasElement }) => {
    const canvas = await setRank(canvasElement);
    await expect(await canvas.findByRole('button', { name: m.library_rich_entry_review_latest() })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.library_rich_entry_save() })).toBeDisabled();
    await expect(canvas.getByRole('spinbutton')).toHaveValue(1);
  },
};
export const Uncertain: Story = {
  render: () => <Review scenario="uncertain" />,
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = await setRank(canvasElement);
    await expect(await canvas.findByRole('button', { name: m.library_rich_entry_retry() })).toBeEnabled();
    await expect(canvas.getByText(m.library_rich_entry_uncertain())).toBeVisible();
  },
};
export const Retired: Story = {
  render: () => <Review scenario="retired" />,
  play: async ({ canvasElement }) => {
    const canvas = await setRank(canvasElement);
    await expect(await canvas.findByText(m.library_rich_entry_signed_out())).toBeVisible();
    await expect(canvas.queryByRole('textbox')).toBeNull();
  },
};
