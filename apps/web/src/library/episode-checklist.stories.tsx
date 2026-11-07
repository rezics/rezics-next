import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useMemo, useRef } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from '../stories/page';
import type { ChecklistRow, ChecklistViewerBinding } from './episode-checklist/contract';
import { EpisodeChecklistVisit } from './episode-checklist/visit';
import { readyVisit } from './episode-checklist/controller';
import type { EpisodeSender } from './episode-checklist/commands';

const sessionId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const episodeId = '019a1b2c-3d4e-7f00-8a00-000000000001';
const viewerId = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';

type Example = 'detached' | 'sparse' | 'uncertain';

function row(
  id: string,
  completed: boolean,
  membership: 'member' | 'detached',
  source: ChecklistRow['source'] = 'retained',
): ChecklistRow {
  return {
    episodeSubjectId: id,
    completed,
    membership,
    ordinal: 'Special 2',
    label: 'The Lantern Episode',
    source,
  };
}

function binding(locale: string): ChecklistViewerBinding {
  return { viewer: viewerId, locale, subjectId, sessionId, revision: 3 };
}

function EpisodeChecklistExample({ example = 'detached' }: { example?: Example }) {
  const locale = getLocale();
  const currentBinding = useMemo(() => binding(locale), [locale]);
  const initial = useMemo(() => {
    const initialRows =
      example === 'sparse'
        ? [row(episodeId, true, 'detached')]
        : example === 'uncertain'
          ? [row(episodeId, false, 'member', 'membership')]
          : [row(episodeId, true, 'detached')];
    return readyVisit(currentBinding, initialRows, {
      membership: 'admitted',
      retainedNext: example === 'sparse' ? 'opaque:cursor/first-page' : null,
    });
  }, [currentBinding, example]);
  const attempts = useRef<Parameters<EpisodeSender>[0][]>([]);
  const continuedCursor = useRef<string | undefined>(undefined);
  const sender = useCallback<EpisodeSender>(
    async (input) => {
      attempts.current.push(input);
      if (example === 'uncertain' && attempts.current.length === 1) throw new Error('Illustrative lost response');
      return { ok: true, revision: input.revision + 1 };
    },
    [example],
  );
  const continueRetained = useCallback(async (cursor?: string) => {
    continuedCursor.current = cursor;
    if (cursor === 'opaque:cursor/first-page') {
      return { rows: [], next: 'opaque:cursor/after-sparse-page', revision: 3 };
    }
    return { rows: [row(episodeId, true, 'detached')], next: null, revision: 3 };
  }, []);
  const exactReplay =
    attempts.current.length === 2 && JSON.stringify(attempts.current[0]) === JSON.stringify(attempts.current[1]);

  return (
    <PatternStory visitor="Signed In" path={`/library/progress/${sessionId}`}>
      <AppShell>
        <main className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Series progress</h1>
          <p className="text-sm text-muted-foreground">Illustrative checklist fixture; no native response was recorded.</p>
          <EpisodeChecklistVisit
            binding={currentBinding}
            credential={() => ({ 'X-CSRF-Token': 'illustrative-only' })}
            isCurrent={() => true}
            sender={sender}
            initial={initial}
            {...(example === 'sparse' ? { continueRetained } : {})}
          />
          <div data-testid="episode-story-replay" data-exact={String(exactReplay)} />
          <div data-testid="episode-story-cursor" data-value={continuedCursor.current ?? ''} />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Library/Canonical episode checklist',
  component: EpisodeChecklistExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative default-visit states supplied by local fixtures. They do not claim recorded native reads or writes.',
      },
    },
  },
} satisfies Meta<typeof EpisodeChecklistExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RetainedDetachedCompletion: Story = {
  args: { example: 'detached' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retained = await canvas.findByRole('listitem');
    await expect(retained).toHaveTextContent('The Lantern Episode');
    await expect(retained).toHaveTextContent(m.library_progress_episodes_detached());
    await expect(canvas.getByRole('checkbox')).toBeEnabled();
  },
};

export const SparseNextPage: Story = {
  args: { example: 'sparse' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.library_progress_episodes_continue() }));
    await expect(canvas.queryAllByRole('listitem')).toHaveLength(0);
    await expect(canvas.getByRole('button', { name: m.library_progress_episodes_continue() })).toBeVisible();
    await expect(canvas.getByTestId('episode-story-cursor')).toHaveAttribute(
      'data-value',
      'opaque:cursor/first-page',
    );
  },
};

export const UncertainExactReplay: Story = {
  args: { example: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('checkbox'));
    await userEvent.click(canvas.getByRole('button', { name: m.library_progress_episodes_apply() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_progress_confirm_correction() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_progress_measures_retry() }));
    await canvas.findByText(m.library_progress_episodes_accepted());
    await expect(canvas.getByTestId('episode-story-replay')).toHaveAttribute('data-exact', 'true');
  },
};
