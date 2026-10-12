import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import { ChapterProgress } from './chapter-progress.tsx';
import type { EpisodeProgress } from './episode-api.ts';
import type { ChapterStanding, MediaApi, PositionPage } from './media-api.ts';
import type { Place } from './media.ts';
import { copyOf } from './messages.ts';

const occurrence = (volume: number, number: number) => `https://example.test/occ/${volume}-${number}`;
const place = (volume: number, number: number): Place => ({
  structure: 'https://example.test/book', occurrence: occurrence(volume, number),
  label: `Volume ${volume}, chapter ${number}`,
});
const places = [1, 2].flatMap(volume => [1, 2, 3, 4].map(number => place(volume, number)));

/** Two volumes, one page at a time. One write can come back stale so the conflict panel opens. */
function memoryChapters(read: string[] = [], stale = false, failRead = false): MediaApi {
  const rows = new Map<string, EpisodeProgress>(read.map(id => [id, { completed: true, position: 'read', version: 1 }]));
  let once = stale;
  const standing = (): ChapterStanding => {
    const index = places.reduce((found, item, at) => rows.get(item.occurrence)?.completed ? at : found, -1);
    if (index < 0) return { last: null, next: null, opened: null };
    return { last: places[index] ?? null, next: null, opened: null };
  };
  const page = (cursor?: string): PositionPage => cursor
    ? { items: places.slice(4), next: null }
    : { items: places.slice(0, 4), next: 'more' };
  const api: MediaApi = {
    types: async () => ({ ok: true, data: ['https://schema.org/BookSeries'] }),
    volumes: async () => ({ ok: true, data: [] }),
    chapters: async () => ({ ok: true, data: null }),
    routes: async () => ({ ok: true, data: { items: [], next: null } }),
    standing: async () => ({ ok: true, data: standing() }),
    positions: async (_work, cursor) => ({ ok: true, data: page(cursor) }),
    completions: async () => ({ ok: true, data: {
      occurrences: [...rows].filter(([, progress]) => progress.completed).map(([id]) => id), next: null, complete: true,
    } }),
    progress: async part => failRead
      ? { ok: false, failure: 'unavailable' }
      : { ok: true, data: rows.get(part.occurrence) ?? { completed: false, position: null, version: 0 } },
    mark: async (part, change) => {
      const current = rows.get(part.occurrence) ?? { completed: false, position: null, version: 0 };
      if (once) {
        once = false;
        return { ok: false, failure: 'stale', current, submitted: { completed: change.completed, position: change.position ?? null } };
      }
      const saved = { completed: change.completed, position: change.position ?? null, version: current.version + 1 };
      rows.set(part.occurrence, saved);
      return { ok: true, data: saved };
    },
    workParts: async () => ({ ok: true, data: false }),
    workStanding: async () => ({ ok: true, data: { standing: 'not-started', version: 0 } }),
    markWork: async () => ({ ok: true, data: { standing: 'not-started', version: 1 } }),
  };
  return api;
}

function Sheet({ api }: { api: MediaApi }) {
  return <PageContainer className="grid max-w-md gap-6">
    <ChapterProgress work="https://example.test/series" api={api} t={copyOf('en')} />
  </PageContainer>;
}

const meta = {
  title: 'Tracking/Chapter progress',
  component: Sheet,
  parameters: { docs: { description: { component:
    'A manga with volumes: the last chapter read, the next one, and the chapters one page at a time. Another device writing the same chapter keeps both versions on screen.' } } },
  args: { api: memoryChapters() },
  globals: { viewport: { value: 'phone' } },
} satisfies Meta<{ api: MediaApi }>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Volume 2 chapter 3 is on the next chooser page. Main names it after a mark. */
export const MarkVolumeChapter: Story = {
  args: { api: memoryChapters() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('No chapter read yet');
    await expect(canvasElement.querySelector('[data-next]')).toBeNull();
    await expect(view.queryByRole('button', { name: 'Volume 2, chapter 3' })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: 'Show more' }));
    await userEvent.click(view.getByRole('button', { name: 'Volume 2, chapter 3' }));
    await userEvent.click(await view.findByRole('button', { name: /^Mark read$/ }));
    await view.findByText('Last read: Volume 2, chapter 3');
    await expect(canvasElement.querySelector('[data-next]')).toBeNull();
  },
};

/** The same chapter on a wide screen, named by Main without coverage counts. */
export const ResumesOnDesktop: Story = {
  args: { api: memoryChapters([occurrence(2, 3)]) },
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 3');
    await expect(canvasElement.querySelector('[data-next]')).toBeNull();
  },
};

/** Another device wrote this chapter first. Both versions stay until the reader keeps theirs. */
export const Conflict: Story = {
  args: { api: memoryChapters([occurrence(2, 3)], true) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 3');
    await userEvent.click(view.getByRole('button', { name: 'Show more' }));
    await userEvent.click(view.getByRole('button', { name: 'Volume 2, chapter 3' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark not read' }));
    await view.findByText('Changed on another device');
    await expect(view.getByText('Your change')).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Keep my change' }));
    await view.findByText('No chapter read yet');
  },
};

/** A chapter whose progress could not be read stays failed, and is not shown as unread. */
export const ReadFailed: Story = {
  args: { api: memoryChapters([], false, true) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('No chapter read yet');
    await userEvent.click(view.getByRole('button', { name: 'Volume 1, chapter 1' }));
    await view.findByText('Couldn’t save. Try again.');
    await expect(view.queryByText('Not read')).toBeNull();
  },
};

export const SparseFinalChapter: Story = {
  args: { api: memoryChapters([occurrence(1, 1), occurrence(2, 4)]) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 4');
    await expect(canvasElement.querySelector('[data-caught-up]')).toBeNull();
    await expect(canvasElement.querySelector('[data-next]')).toBeNull();
    await expect(view.getByRole('button', { name: 'Show more' })).toBeVisible();
  },
};

export const SparseMiddleChapter: Story = {
  args: { api: memoryChapters([occurrence(1, 1), occurrence(2, 2)]) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 2');
    await expect(canvasElement.querySelector('[data-next]')).toBeNull();
    await expect(canvasElement.querySelector('[data-caught-up]')).toBeNull();
  },
};

export const UnmarkEarlierChapter: Story = {
  args: { api: memoryChapters(places.map(item => item.occurrence)) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 4');
    await expect(canvasElement.querySelector('[data-caught-up]')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: 'Volume 1, chapter 2' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark not read' }));
    await view.findByRole('button', { name: /^Mark read$/ });
    await expect(view.getByText('Last read: Volume 2, chapter 4')).toBeVisible();
    await waitFor(() => expect(canvasElement.querySelector('[data-caught-up]')).toBeNull());
  },
};

export const UnknownChapterCoverage: Story = {
  args: { api: memoryChapters(places.map(item => item.occurrence)) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 4');
    await expect(canvasElement.querySelector('[data-caught-up]')).toBeNull();
  },
};

export const UnmarkPendingRefresh: Story = {
  args: { api: (() => {
    const api = memoryChapters(places.map(item => item.occurrence));
    let blocked = false;
    const mark = api.mark;
    const standing = api.standing;
    api.mark = async (...input) => { const written = await mark(...input); blocked = written.ok; return written; };
    api.standing = work => blocked ? new Promise(() => {}) : standing(work);
    return api;
  })() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 4');
    await userEvent.click(view.getByRole('button', { name: 'Volume 1, chapter 2' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark not read' }));
    await view.findByText('Unknown');
    await expect(view.queryByText('Last read: Volume 2, chapter 4')).toBeNull();
    await expect(canvasElement.querySelector('[data-caught-up]')).toBeNull();
  },
};
