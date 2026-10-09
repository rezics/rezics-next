import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import type { EpisodeProgress } from './episode-api.ts';
import { GameProgress } from './game-progress.tsx';
import type { MediaApi } from './media-api.ts';
import type { RouteRef } from './media.ts';
import { copyOf } from './messages.ts';

const story: RouteRef = { structure: 'https://example.test/game', occurrence: 'https://example.test/story',
  label: 'Story', required: true };
const route: RouteRef = { structure: 'https://example.test/game', occurrence: 'https://example.test/route',
  label: 'True route', required: false };

function memoryGame(done: string[] = []): MediaApi {
  const rows = new Map<string, EpisodeProgress>(done.map(id => [id, { completed: true, position: 'completed', version: 1 }]));
  return {
    types: async () => ({ ok: true, data: ['https://schema.org/VideoGame'] }),
    volumes: async () => ({ ok: true, data: [] }),
    chapters: async () => ({ ok: true, data: null }),
    routes: async () => ({ ok: true, data: { items: [story, route], next: null } }),
    standing: async () => ({ ok: true, data: { last: null, next: null, caughtUp: false, opened: null } }),
    positions: async () => ({ ok: true, data: { items: [], next: null } }),
    completions: async () => ({ ok: true, data: {
      occurrences: [...rows].filter(([, row]) => row.completed).map(([id]) => id), next: null, complete: true } }),
    progress: async part => ({ ok: true, data: rows.get(part.occurrence) ?? { completed: false, position: null, version: 0 } }),
    mark: async (part, change) => {
      const saved = { completed: change.completed, position: change.position ?? null,
        version: (rows.get(part.occurrence)?.version ?? 0) + 1 };
      rows.set(part.occurrence, saved);
      return { ok: true, data: saved };
    },
  };
}

function Sheet({ api }: { api: MediaApi }) {
  return <PageContainer className="grid max-w-md gap-6">
    <GameProgress work="https://example.test/game" api={api} t={copyOf('en')} />
  </PageContainer>;
}

const meta = {
  title: 'Tracking/Game progress',
  component: Sheet,
  parameters: { docs: { description: { component:
    'A game is played and completed on the parts it already has. A named extra part is a route and does not by itself finish the game. A completed game can be marked not completed.' } } },
  args: { api: memoryGame() },
  globals: { viewport: { value: 'phone' } },
} satisfies Meta<{ api: MediaApi }>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One tap completes the required part. The named route stays beside it, and completion can be taken back. */
export const MarkCompleted: Story = {
  args: { api: memoryGame() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Not played yet');
    await expect(view.getByRole('button', { name: 'True route' })).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Mark completed' }));
    await view.findByText('Completed', { exact: true });
    await expect(canvasElement.querySelector('[data-play-state="completed"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-route-state="none"]')).not.toBeNull();
    await userEvent.click(view.getByRole('button', { name: 'Mark not completed' }));
    await view.findByText('Not played yet');
  },
};

/** A game already completed on another device, on a wide screen, can be marked not completed. */
export const CompletedOnDesktop: Story = {
  args: { api: memoryGame([story.occurrence]) },
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Completed', { exact: true });
    await expect(view.getByRole('button', { name: 'Mark not completed' })).toBeVisible();
    await expect(view.getByRole('button', { name: 'True route' })).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Mark not completed' }));
    await view.findByText('Not played yet');
  },
};
