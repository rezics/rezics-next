import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { HostedBookCheckpoint } from '../books/reader/checkpoint';
import type { CheckpointView, CheckpointWrite } from '../books/reader/checkpoint-api';
import type { CheckpointTransport } from '../books/reader/checkpoint-intent';
import { HostedBookReader } from '../books/reader/hosted-book-reader';
import { createIllustrativeHostedBook, illustrativeBookIds as ids } from '../books/reader/illustrative-source';
import type { BookChapterAddress } from '../books/reader/source';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

type Scenario = 'saved' | 'unknown-save' | 'unknown-clear' | 'failed-read' | 'replaced-visit';
type Runtime = {
  book: ReturnType<typeof createIllustrativeHostedBook>;
  address: BookChapterAddress;
  transport: CheckpointTransport;
};

function recoveryTransport(
  scenario: Scenario,
  chapter: BookChapterAddress,
  pending: (complete: () => void) => void,
): CheckpointTransport {
  const saved: CheckpointView = {
    state: 'saved', subjectId: ids.post, revision: '7',
    address: {
      catalogueId: chapter.publication.id,
      publicationRevisionId: chapter.publication.releaseRevisionId!,
      occurrenceId: chapter.selection.occurrenceId,
      targetRevisionId: chapter.selection.body.revisionId,
      targetSha256: chapter.selection.body.sha256,
      documentPosition: { blockId: 'opening', offset: 73 },
    },
    resume: { availability: 'available', title: 'Dawn / 黎明 · The observatory and the long journey home' },
  };
  let value: CheckpointView = scenario === 'saved' || scenario === 'unknown-clear'
    ? saved : { state: 'none', subjectId: ids.post };
  let reads = 0;
  let writes = 0;
  return {
    read: async () => {
      if (scenario === 'failed-read' && reads++ === 0) return { state: 'unavailable' };
      return { state: 'ready', value, csrfToken: 'illustrative-checkpoint-csrf' };
    },
    write: async ({ data }) => {
      const result: CheckpointWrite = {
        state: 'ready',
        value: data.command.kind === 'clear' ? { state: 'none', subjectId: ids.post } : {
          ...saved, address: data.command.address, revision: '8',
        },
      };
      const first = writes++ === 0;
      if ((scenario === 'unknown-save' || scenario === 'unknown-clear') && first) {
        // Native may have applied it; only replaying the original command can settle its outcome.
        value = result.value;
        return { state: 'uncertain' };
      }
      if (scenario === 'replaced-visit' && first) {
        return new Promise<CheckpointWrite>((resolve) => pending(() => resolve(result)));
      }
      value = result.value;
      return result;
    },
  };
}

function CheckpointVisit({
  scenario, pending, reload,
}: { scenario: Scenario; pending: (complete: () => void) => void; reload: () => void }) {
  const locale = getLocale();
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  useEffect(() => {
    let live = true;
    const book = createIllustrativeHostedBook('nested', true);
    void book.chapter().then((address) => {
      if (live) setRuntime({ book, address, transport: recoveryTransport(scenario, address, pending) });
    });
    return () => { live = false; };
  }, [scenario, locale, pending]);
  if (!runtime) return <p role="status">{m.book_reader_loading({}, { locale })}</p>;
  return <HostedBookReader
    address={runtime.address} source={runtime.book.source} readingIdentity={runtime.book} locale={locale}
    renderCheckpoint={(page, isCurrent, position) => <HostedBookCheckpoint
      page={page} isCurrent={isCurrent} position={position} locale={locale}
      viewer={ids.author} subjectId={ids.post} transport={runtime.transport} reload={reload}
    />}
  />;
}

function BookCheckpointRecovery({ scenario = 'saved' }: { scenario?: Scenario }) {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    value.setQueryData(['session'], { state: 'signed-in', subject: ids.author, csrfToken: 'illustrative-checkpoint-csrf' });
    return value;
  });
  useEffect(() => () => client.clear(), [client]);
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  const late = useRef<(() => void) | null>(null);
  const [capturePending] = useState(() => (complete: () => void) => {
    late.current = complete;
    setPending(true);
  });
  return <QueryClientProvider client={client}>
    <main className="mx-auto min-w-0 max-w-4xl space-y-4 p-4 sm:p-8">
      <aside className="space-y-2 text-sm text-muted-foreground">
        <p>Illustrative native checkpoint responses through the actual checkpoint and Book reader components.</p>
        {scenario === 'replaced-visit' ? <div className="flex flex-wrap gap-2">
          <Button className="min-h-11 min-w-11" variant="outline" disabled={!pending}
            onClick={() => setGeneration((value) => value + 1)}>Replace reading visit</Button>
          <Button className="min-h-11 min-w-11" variant="outline" disabled={!pending || generation === 0}
            onClick={() => { late.current?.(); setPending(false); }}>Deliver retired response</Button>
        </div> : null}
      </aside>
      <CheckpointVisit key={`${scenario}:${generation}:${getLocale()}`}
        scenario={generation === 0 ? scenario : 'unknown-save'} pending={capturePending}
        reload={() => setGeneration((value) => value + 1)} />
    </main>
  </QueryClientProvider>;
}

const meta = {
  title: 'Books/Book checkpoint recovery',
  id: 'interfaces-book-checkpoint-recovery',
  component: BookCheckpointRecovery,
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Saved, unknown save/clear, failed observation and replaced visit. Native-format fixtures establish interface behavior only.' } },
  },
} satisfies Meta<typeof BookCheckpointRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  args: { scenario: 'saved' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const resume = await canvas.findByRole('link', { name: m.book_reader_checkpoint_resume() });
    await expect(resume).toHaveAttribute('href', expect.stringContaining(`release=${ids.release}`));
    await expect(canvas.getByText(m.book_reader_checkpoint_observed_saved({
      chapter: 'Dawn / 黎明 · The observatory and the long journey home',
    }))).toBeVisible();
  },
};
export const UnknownSave: Story = {
  args: { scenario: 'unknown-save' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const save = await canvas.findByRole('button', { name: m.book_reader_checkpoint_save() });
    await userEvent.click(save);
    const replay = await canvas.findByRole('button', { name: m.book_reader_checkpoint_retry_save() });
    await expect(save).toBeDisabled();
    await expect(canvas.getByText(m.book_reader_checkpoint_observed_none())).toBeVisible();
    await userEvent.click(replay);
    await expect(await canvas.findByText(m.book_reader_checkpoint_saved())).toBeVisible();
  },
};
export const UnknownClear: Story = {
  args: { scenario: 'unknown-clear' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText(m.book_reader_checkpoint_details()));
    await userEvent.click(canvas.getByRole('button', { name: m.book_reader_checkpoint_clear() }));
    const replay = await canvas.findByRole('button', { name: m.book_reader_checkpoint_retry_clear() });
    await expect(canvas.getByRole('button', { name: m.book_reader_checkpoint_save() })).toBeDisabled();
    await userEvent.click(replay);
    await expect(await canvas.findByText(m.book_reader_checkpoint_cleared())).toBeVisible();
  },
};
export const FailedRead: Story = {
  args: { scenario: 'failed-read' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.book_reader_checkpoint_retry_read() }));
    await expect(await canvas.findByText(m.book_reader_checkpoint_none())).toBeVisible();
  },
};
export const ReplacedVisit: Story = {
  args: { scenario: 'replaced-visit' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.book_reader_checkpoint_save() }));
    await canvas.findByText(m.book_reader_checkpoint_saving());
    await userEvent.click(canvas.getByRole('button', { name: 'Replace reading visit' }));
    await canvas.findByText(m.book_reader_checkpoint_none());
    await userEvent.click(canvas.getByRole('button', { name: 'Deliver retired response' }));
    await expect(canvas.queryByText(m.book_reader_checkpoint_saved())).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.book_reader_checkpoint_resume() })).toBeNull();
  },
};
