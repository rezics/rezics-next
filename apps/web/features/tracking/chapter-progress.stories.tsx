import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import { ChapterProgress } from './chapter-progress.tsx';
import type { EpisodeProgress } from './episode-api.ts';
import type { MediaApi } from './media-api.ts';
import type { ChapterRef } from './media.ts';
import { copyOf } from './messages.ts';

const occurrence = (volume: number, number: number) => `https://example.test/occ/${volume}-${number}`;
const chapter = (volume: number, number: number): ChapterRef => ({
  structure: 'https://example.test/book', occurrence: occurrence(volume, number), number, label: null,
  volume: { number: volume, label: String(volume) },
});
const books = [
  { number: 1, label: '1', work: 'https://example.test/vol/1', chapters: [1, 2, 3, 4].map(number => chapter(1, number)) },
  { number: 2, label: '2', work: 'https://example.test/vol/2', chapters: [1, 2, 3, 4].map(number => chapter(2, number)) },
];

/** Chapters of two volumes, with one optional stale write so the conflict panel can be opened. */
function memoryChapters(read: string[] = [], stale = false): MediaApi {
  const rows = new Map<string, EpisodeProgress>(read.map(id => [id, { completed: true, position: 'read', version: 1 }]));
  let once = stale;
  return {
    types: async () => ({ ok: true, data: ['https://schema.org/BookSeries'] }),
    volumes: async () => ({ ok: true, data: books.map(({ chapters: _chapters, ...volume }) => volume) }),
    chapters: async work => ({ ok: true, data: books.find(volume => volume.work === work)?.chapters ?? [] }),
    routes: async () => ({ ok: true, data: [] }),
    resume: async () => ({ ok: true, data: [...rows].reverse().find(([, row]) => row.completed)?.[0] ?? null }),
    progress: async part => ({ ok: true, data: rows.get(part.occurrence) ?? { completed: false, position: null, version: 0 } }),
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
  };
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
    'A manga with volumes: the last chapter read, the next one, and a jump to a chapter inside a volume. Another device writing the same chapter keeps both versions on screen.' } } },
  args: { api: memoryChapters() },
  globals: { viewport: { value: 'phone' } },
} satisfies Meta<{ api: MediaApi }>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Volume 2 chapter 3 is marked from the jump, and the next chapter is the one after it. */
export const MarkVolumeChapter: Story = {
  args: { api: memoryChapters() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('No chapter read yet');
    await userEvent.type(view.getByLabelText('Volume'), '2');
    await userEvent.type(view.getByLabelText('Chapter'), '3');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await view.findByText('Volume 2, chapter 3');
    await userEvent.click(view.getByRole('button', { name: /^Mark read$/ }));
    await view.findByText('Last read: Volume 2, chapter 3');
    await expect(view.getByText('Continue from Volume 2, chapter 4')).toBeVisible();
  },
};

/** The same chapter on a wide screen, already read, continues at the next one. */
export const ResumesOnDesktop: Story = {
  args: { api: memoryChapters([occurrence(2, 3)]) },
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 3');
    await expect(view.getByText('Continue from Volume 2, chapter 4')).toBeVisible();
  },
};

/** Another device wrote this chapter first. Both versions stay until the reader keeps theirs. */
export const Conflict: Story = {
  args: { api: memoryChapters([occurrence(2, 3)], true) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Last read: Volume 2, chapter 3');
    await userEvent.type(view.getByLabelText('Volume'), '2');
    await userEvent.type(view.getByLabelText('Chapter'), '3');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark not read' }));
    await view.findByText('Changed on another device');
    await expect(view.getByText('Your change')).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Keep my change' }));
    await view.findByText('No chapter read yet');
  },
};
