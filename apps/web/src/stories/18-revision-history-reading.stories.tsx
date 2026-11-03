import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { RevisionHistoryNavigation } from '../threads/revision-history-navigation';
import type { HistoryPage, HistoryView } from '../threads/post-history-lifetime';
import { m } from '../paraglide/messages.js';
import { selected, later, id, exactRevisionViewports } from './exact-revision/fixture';
import accounts from '../kernel/recorded/accounts.json';

/** Prepared DTOs, not native recordings or evidence that a reader can access these revisions. */
function suppliedEntries(count: number, long: boolean, removed: boolean): HistoryView['revisions'] {
  return Array.from({ length: count }, (_, index) => {
    const revision = index % 2 ? later : selected;
    const metadata = {
      ...revision,
      revisionId: id(1_000 + index),
      licence: long ? `LicenseRef-${'a-very-long-admitted-licence-name-'.repeat(12)}` : revision.licence,
    };
    return {
      revision:
        removed && index === 1
          ? { ...metadata, availability: 'erased', body: null, sha256: null, removed: true }
          : metadata,
      documentMedia: { kind: 'unavailable' },
    };
  });
}

function PreparedHistory({
  count = 10,
  long = false,
  removed = false,
  partialFailure = false,
  continuation = false,
}: {
  count?: number;
  long?: boolean;
  removed?: boolean;
  partialFailure?: boolean;
  continuation?: boolean;
}) {
  const [loaded, setLoaded] = useState(count);
  const [failed, setFailed] = useState(partialFailure);
  const [added, setAdded] = useState(false);
  const entries = useMemo(() => suppliedEntries(loaded, long, removed), [loaded, long, removed]);
  const authors: HistoryPage['authors'] = {
    [selected.authorId]: {
      ...accounts.accounts[0]!,
      id: selected.authorId,
      displayName: long ? 'Prepared multilingual author / 著者 / 작가 / '.repeat(18) : 'Prepared history author',
      handle: 'prepared-history-author',
      state: 'active',
      kind: 'actor',
    },
  };
  const hasMore = !added && (continuation || partialFailure);
  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl space-y-5 p-4 text-foreground sm:p-8">
      <p role="note" className="text-sm text-muted-foreground">
        Prepared revision-history presentation with supplied DTOs. Page continuation and retry are prepared; this story
        does not establish native authorization or transport behaviour.
      </p>
      <h1 className="text-2xl font-semibold">{m.thread_history_heading()}</h1>
      <section
        aria-label={m.thread_history_heading()}
        className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-3 sm:p-5"
      >
        <RevisionHistoryNavigation
          entries={entries}
          authors={authors}
          mentions={{}}
          subjects={[{ id: id(20), label: 'Prepared subject / 読書', labels: {}, types: ['schema:Book'], cover: null }]}
          reviewVotes={{ [selected.id]: { ...selected.voteCitation!, units: 9, revision: 7 } }}
          viewerId={selected.authorId}
          review
          now="2026-11-01T12:00:00Z"
          active
          hasMore={hasMore}
          isCurrent={() => true}
        />
        {failed ? <p role="status">{m.thread_history_page_failed()}</p> : null}
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere]"
            onClick={() => {
              setLoaded(loaded + 10);
              setFailed(false);
              setAdded(true);
            }}
          >
            {failed ? m.exact_revision_retry() : m.thread_history_more()}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{m.thread_history_complete()}</p>
        )}
        {added ? <p role="status">{m.revision_history_added({ count: '10' })}</p> : null}
      </section>
    </main>
  );
}

const meta = {
  title: 'Interfaces/Community/Revision history reading',
  component: PreparedHistory,
  args: { count: 10, long: false, removed: false, partialFailure: false, continuation: false },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: exactRevisionViewports },
    docs: {
      description: {
        component:
          'Prepared loaded-only revision inspection; existing history and exact-reader authorization remain authoritative.',
      },
    },
  },
} satisfies Meta<typeof PreparedHistory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function readingVisit({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvasElement.querySelectorAll('[data-history-summary]')).toHaveLength(10);
  await expect(canvasElement.querySelector('[data-history-inspector]')).toBeNull();
  await expect(canvas.getByText(m.revision_history_loaded_help())).toBeVisible();
  const choose = canvas.getByLabelText(m.revision_history_choose());
  await userEvent.selectOptions(choose, '7');
  await userEvent.click(canvas.getByRole('button', { name: m.revision_history_go() }));
  const trigger = canvas.getByRole('button', { name: m.revision_history_collapse({ number: '8' }) });
  await expect(trigger).toHaveFocus();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(canvasElement.querySelectorAll('[data-history-inspector]')).toHaveLength(1);
  await expect(canvas.getByText('The later edition makes the ending more explicit.')).toBeVisible();
  const open = canvas.getByRole('link', { name: m.revision_history_open_exact() });
  await expect(open).toHaveAttribute('href', expect.stringContaining(`/posts/${selected.id}/revisions/${id(1_007)}`));
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await userEvent.click(canvas.getByRole('button', { name: m.revision_history_close_inspector() }));
  await expect(canvas.getByRole('button', { name: m.revision_history_inspect({ number: '8' }) })).toHaveFocus();
  await expect(canvasElement.querySelector('[data-history-inspector]')).toBeNull();
  const inspectorButton = canvas.getByRole('button', { name: m.revision_history_inspect({ number: '8' }) });
  inspectorButton.focus();
  await userEvent.keyboard('{Home}{ArrowDown}{Enter}');
  await expect(canvas.getByRole('button', { name: m.revision_history_collapse({ number: '2' }) })).toHaveFocus();
  await expect(canvasElement.querySelectorAll('[data-history-inspector]')).toHaveLength(1);
  // A real layout witness for each named viewport/theme, including wrapped controls and the full body.
  const region = canvas.getByRole('region', { name: m.thread_history_heading() });
  await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
}

export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: readingVisit };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: readingVisit };
export const DesktopLight: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: readingVisit,
};
export const DesktopDark: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: readingVisit,
};

export const LongMetadata: Story = {
  args: { long: true },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: readingVisit,
};

export const RemovedDocument: Story = {
  args: { removed: true },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.revision_history_inspect({ number: '2' }) }));
    await expect(canvas.getByText(m.revision_history_erased_explanation())).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.getByRole('link', { name: m.revision_history_open_exact() })).toBeVisible();
    await expect(canvas.getByText(m.thread_provenance_current_vote())).toBeVisible();
  },
};

export const PartialPageRetry: Story = {
  args: { partialFailure: true },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.revision_history_inspect({ number: '3' }) }));
    await expect(canvas.getByText(m.thread_history_page_failed())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.exact_revision_retry() }));
    await expect(canvasElement.querySelectorAll('[data-history-summary]')).toHaveLength(20);
    await expect(canvas.getByRole('button', { name: m.revision_history_collapse({ number: '3' }) })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(canvasElement.querySelectorAll('[data-history-inspector]')).toHaveLength(1);
    await expect(canvas.getByText(m.revision_history_added({ count: '10' }))).toBeVisible();
  },
};

export const SuppliedOne: Story = { args: { count: 1 }, globals: { viewport: { value: 'phone390' } } };
export const SuppliedHundred: Story = {
  args: { count: 100 },
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByLabelText(m.revision_history_choose()), '99');
    await userEvent.click(canvas.getByRole('button', { name: m.revision_history_go() }));
    await expect(canvasElement.querySelectorAll('[data-history-inspector]')).toHaveLength(1);
    await expect(canvas.getByRole('button', { name: m.revision_history_next() })).toBeDisabled();
  },
};
