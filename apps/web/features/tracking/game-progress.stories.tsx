import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@rezics/ui/button';
import { useState } from 'react';
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

const many = Array.from({ length: 25 }, (_, index): RouteRef => ({ ...story,
  occurrence: `https://example.test/part-${index + 1}`, label: `Part ${index + 1}` }));

function memoryGame(done: string[] = [], options: {
  parts?: RouteRef[]; played?: string; failOnce?: string;
} = {}): MediaApi {
  const parts = options.parts ?? [story, route];
  let fail = options.failOnce;
  const rows = new Map<string, EpisodeProgress>(done.map(id => [id, { completed: true, position: 'completed', version: 1 }]));
  if (options.played) rows.set(options.played, { completed: false, position: 'played', version: 1 });
  return {
    types: async () => ({ ok: true, data: ['https://schema.org/VideoGame'] }),
    volumes: async () => ({ ok: true, data: [] }),
    chapters: async () => ({ ok: true, data: null }),
    routes: async (_work, after) => {
      const start = after ? Number(after) : 0;
      return { ok: true, data: { items: parts.slice(start, start + 20),
        next: start + 20 < parts.length ? String(start + 20) : null } };
    },
    standing: async () => ({ ok: true, data: { last: null, next: null, caughtUp: false, opened: null } }),
    positions: async () => ({ ok: true, data: { items: [], next: null } }),
    completions: async () => ({ ok: true, data: {
      occurrences: [...rows].filter(([, row]) => row.completed).map(([id]) => id), next: null, complete: true } }),
    progress: async part => ({ ok: true, data: rows.get(part.occurrence) ?? { completed: false, position: null, version: 0 } }),
    mark: async (part, change) => {
      if (part.occurrence === fail) { fail = undefined; return { ok: false, failure: 'unavailable' }; }
      const saved = { completed: change.completed, position: change.position ?? null,
        version: (rows.get(part.occurrence)?.version ?? 0) + 1 };
      rows.set(part.occurrence, saved);
      return { ok: true, data: saved };
    },
    workParts: async () => ({ ok: true, data: false }),
    workStanding: async () => ({ ok: true, data: { standing: 'not-started', version: 0 } }),
    markWork: async () => ({ ok: true, data: { standing: 'not-started', version: 1 } }),
  };
}

function Sheet({ api, reloadable = false }: { api: MediaApi; reloadable?: boolean }) {
  const [generation, setGeneration] = useState(0);
  return <PageContainer className="grid max-w-md gap-6">
    <GameProgress key={generation} work="https://example.test/game" api={api} t={copyOf('en')} />
    {reloadable ? <Button variant="outline" onClick={() => setGeneration(value => value + 1)}>Reload progress</Button> : null}
  </PageContainer>;
}

const meta = {
  title: 'Tracking/Game progress',
  component: Sheet,
  parameters: { docs: { description: { component:
    'A game is played and completed on the parts it already has. A named extra part is a route and does not by itself finish the game. A completed game can be marked not completed.' } } },
  args: { api: memoryGame() },
  globals: { viewport: { value: 'phone' } },
} satisfies Meta<typeof Sheet>;
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

/** Required parts page without optional routes, and a completed first page cannot finish the game. */
export const PagedRequiredParts: Story = {
  args: { api: memoryGame(many.slice(0, 20).map(part => part.occurrence), { parts: many }) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Played', { exact: true });
    await expect(canvasElement.querySelector('[data-play-state="completed"]')).toBeNull();
    await expect(canvasElement.querySelector('[data-routes]')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: 'Show more' }));
    await view.findByRole('button', { name: 'Part 25' });
    await userEvent.click(view.getByRole('button', { name: 'Mark completed' }));
    await view.findByText('Completed', { exact: true });
  },
};

/** A later failure leaves the first part completed, the game played, and a retry available. */
export const PartialFailure: Story = {
  args: { api: memoryGame([], { parts: many.slice(0, 3), failOnce: many[1]!.occurrence }) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Not played yet');
    await userEvent.click(view.getByRole('button', { name: 'Mark completed' }));
    await view.findByText('Couldn’t save. Try again.');
    await expect(canvasElement.querySelector('[data-play-state="played"]')).not.toBeNull();
    await expect(canvasElement.querySelector(`[data-route="${many[0]!.occurrence}"]`)).toHaveAttribute('data-route-state', 'completed');
    await expect(canvasElement.querySelector(`[data-route="${many[1]!.occurrence}"]`)).toHaveAttribute('data-route-state', 'none');
  },
};

/** Unfinished play on a later required part is read again after remounting. */
export const ReloadPlayed: Story = {
  args: { api: memoryGame([], { parts: many.slice(0, 3), played: many[1]!.occurrence }), reloadable: true },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Played', { exact: true });
    await expect(canvasElement.querySelector(`[data-route="${many[1]!.occurrence}"]`)).toHaveAttribute('data-route-state', 'played');
    await userEvent.click(view.getByRole('button', { name: 'Reload progress' }));
    await view.findByText('Played', { exact: true });
    await expect(canvasElement.querySelector(`[data-route="${many[1]!.occurrence}"]`)).toHaveAttribute('data-route-state', 'played');
  },
};
