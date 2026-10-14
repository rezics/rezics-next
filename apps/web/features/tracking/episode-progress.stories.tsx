import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import { mainEpisodeApi, type EpisodeApi } from './episode-api.ts';
import type { MainClient } from '../discover/types.ts';
import { createMemoryEpisodes, memoryEpisodeApi } from './episode-memory.ts';
import { EpisodeProgress } from './episode-progress.tsx';
import { episodeSeries, saoOne } from './fixtures.ts';
import { copyOf } from './messages.ts';

function fixture(count = 12, done: number[] = []) {
  const memory = createMemoryEpisodes(episodeSeries({ mains: count, specials: 2 }));
  for (const number of done) memory.progress.set(memory.mains[number - 1]!.occurrence,
    { completed: true, position: `episode:${number}`, version: 1 });
  return memoryEpisodeApi(memory);
}

interface Args { api: EpisodeApi; locale: UiLocale; refresh?: () => void; settleRead?: () => Promise<void>; pageStarted?: () => Promise<void>; marked?: () => string[] }
function Sheet({ api, locale }: Args) {
  return <PageContainer className="grid max-w-md gap-6"><EpisodeProgress work={saoOne} api={api} t={copyOf(locale)} /></PageContainer>;
}
const meta = {
  title: 'Tracking/Episode progress', component: Sheet,
  args: { api: fixture(), locale: 'en' },
  globals: { viewport: { value: 'mobile1' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const jump = async (canvasElement: HTMLElement, number: string) => {
  const view = within(canvasElement);
  await view.findByLabelText('Go to episode number');
  await userEvent.clear(view.getByLabelText('Go to episode number'));
  await userEvent.type(view.getByLabelText('Go to episode number'), number);
  await userEvent.click(view.getByRole('button', { name: 'Go' }));
};
const unknownCoverage = async (canvasElement: HTMLElement) => {
  const view = within(canvasElement);
  await expect(view.queryByRole('progressbar')).toBeNull();
  await expect(canvasElement.querySelector('[data-caught-up]')).toBeNull();
  await expect(canvasElement.querySelector('[data-next]')).toBeNull();
  await expect(canvasElement.querySelector('[data-through]')).toBeNull();
};

export const MarkEpisodeAndSpecial: Story = {
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByText('Unknown');
    await jump(canvasElement, '1');
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Last watched: Episode 1');
    await userEvent.click(view.getByRole('button', { name: 'Special 1' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="special"] [data-state="done"]')).not.toBeNull());
    await view.findByText('Last watched: Episode 1');
    await unknownCoverage(canvasElement);
  },
};

export const SparseFinalEpisode: Story = {
  args: { api: fixture(12, [1, 12]) },
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Last watched: Episode 12');
    await unknownCoverage(canvasElement);
  },
};
export const SparseMiddleEpisode: Story = {
  args: { api: fixture(12, [1, 6]) },
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Last watched: Episode 6');
    await unknownCoverage(canvasElement);
  },
};
export const SelectedRevisionCompletion: Story = {
  args: { api: (() => {
    const api = fixture(2, [1]);
    api.resume = async () => ({ ok: true, data: { occurrence: 'https://example.test/episode-2', label: 'Episode 2' } });
    return api;
  })() },
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Last watched: Episode 2');
    await unknownCoverage(canvasElement);
  },
};
export const ResumeReadFailed: Story = {
  args: { api: (() => {
    const api = fixture(201, Array.from({ length: 201 }, (_, index) => index + 1));
    api.resume = async () => ({ ok: false, failure: 'unavailable' });
    return api;
  })() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByRole('alert');
    await expect(view.queryByText('Unknown')).toBeNull();
    await unknownCoverage(canvasElement);
  },
};
export const ResumeBeyondInventoryBudget: Story = {
  args: { api: fixture(2020, [2019]) },
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Last watched: Episode 2019');
    await unknownCoverage(canvasElement);
  },
};

function pendingChange(done: number[]): Args {
  const api = fixture(12, done);
  let blocked = false;
  let refresh!: () => void;
  const pending = new Promise<void>(resolve => { refresh = resolve; });
  const resume = api.resume;
  const mark = api.mark;
  api.mark = async (...input) => { const written = await mark(...input); blocked = written.ok; return written; };
  api.resume = async work => { if (blocked) await pending; return resume(work); };
  return { api, locale: 'en', refresh };
}
export const UnmarkPendingRefresh: Story = {
  args: pendingChange(Array.from({ length: 12 }, (_, index) => index + 1)),
  async play({ canvasElement, args }) {
    const view = within(canvasElement);
    await view.findByText('Last watched: Episode 12');
    await jump(canvasElement, '2');
    await userEvent.click(await view.findByRole('button', { name: 'Mark not watched' }));
    await view.findByText('Unknown');
    await expect(view.queryByText('Last watched: Episode 12')).toBeNull();
    await unknownCoverage(canvasElement);
    args.refresh!();
    await view.findByText('Last watched: Episode 12');
    await expect(await view.findByRole('button', { name: 'Mark watched' })).toBeVisible();
    await unknownCoverage(canvasElement);
  },
};
export const PendingResume: Story = {
  args: { api: { ...fixture(), resume: () => new Promise(() => {}) } },
  async play({ canvasElement }) {
    await within(canvasElement).findByText('Unknown');
    await unknownCoverage(canvasElement);
  },
};

export const MarkPendingRefresh: Story = {
  args: pendingChange([1]),
  async play({ canvasElement, args }) {
    const view = within(canvasElement);
    await view.findByText('Last watched: Episode 1');
    await jump(canvasElement, '2');
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Unknown');
    await expect(view.queryByText('Last watched: Episode 1')).toBeNull();
    args.refresh!();
    await view.findByText('Last watched: Episode 2');
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="main"] [data-state="done"]')).not.toBeNull());
  },
};

export const OldReadAfterUnmark: Story = {
  args: (() => {
    const api = fixture(12, [1]);
    const progress = api.progress;
    let calls = 0;
    let resolve!: (value: { ok: true; data: { completed: boolean; position: string; version: number } }) => void;
    const held = new Promise<{ ok: true; data: { completed: boolean; position: string; version: number } }>(done => { resolve = done; });
    api.progress = episode => ++calls === 1 ? held : progress(episode);
    return { api, locale: 'en', settleRead: async () => {
      resolve({ ok: true, data: { completed: true, position: 'episode:1', version: 1 } });
      await new Promise<void>(done => requestAnimationFrame(() => done()));
    } };
  })(),
  async play({ canvasElement, args }) {
    const view = within(canvasElement);
    await view.findByText('Last watched: Episode 1');
    await jump(canvasElement, '1');
    await jump(canvasElement, '1');
    await userEvent.click(await view.findByRole('button', { name: 'Mark not watched' }));
    await view.findByRole('button', { name: 'Mark watched' });
    await args.settleRead!();
    await expect(canvasElement.querySelector('[data-selected="main"] [data-state="open"]')).not.toBeNull();
    await expect(view.queryByRole('button', { name: 'Mark not watched' })).toBeNull();
  },
};

export const JumpByNumber: Story = {
  args: { api: fixture() },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByLabelText('Go to episode number');
    await jump(canvasElement, '9');
    await expect(await view.findByText('Episode 9')).toBeVisible();
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Last watched: Episode 9');
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="main"] [data-state="done"]')).not.toBeNull());
    await jump(canvasElement, '40');
    await expect(await view.findByText('There is no episode 40 in this series.')).toBeVisible();
    await expect(canvasElement.querySelector('[data-selected]')).toBeNull();
  },
};

function cancelledPage(): Args {
  const memory = createMemoryEpisodes({ ...episodeSeries({ mains: 60, specials: 2 }), page: 20 });
  const api = memoryEpisodeApi(memory);
  const page = api.page;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  let delay = true;
  api.page = async (structure, options) => {
    const result = await page(structure, options);
    if (delay && !options?.parent && options?.after === '20') {
      delay = false;
      started();
      await held;
    }
    return result;
  };
  return { api, locale: 'en', pageStarted: () => requested,
    settleRead: async () => { release(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); },
    marked: () => [...memory.progress.entries()].filter(([, progress]) => progress.completed)
      .map(([occurrence, progress]) => `${occurrence}:${progress.position}`),
  };
}

export const CancelledPageJump: Story = {
  args: cancelledPage(),
  async play({ canvasElement, args }) {
    const view = within(canvasElement);
    await jump(canvasElement, '21');
    await args.pageStarted?.();
    await userEvent.click(view.getByRole('button', { name: 'Special 1' }));
    await view.findByRole('button', { name: 'Mark watched' });
    await jump(canvasElement, '21');
    await expect(await view.findByText('Episode 21')).toBeVisible();
    await view.findByRole('button', { name: 'Mark watched' });
    await args.settleRead?.();
    await jump(canvasElement, '41');
    await expect(await view.findByText('Episode 41')).toBeVisible();
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Last watched: Episode 41');
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="main"] [data-state="done"]')).not.toBeNull());
    const occurrence = episodeSeries({ mains: 60, specials: 2 }).mains[40]!.occurrence;
    await expect(args.marked?.()).toEqual([`${occurrence}:episode:41`]);
  },
};

export const ThousandEpisodes: Story = {
  args: { api: fixture(1000) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByLabelText('Go to episode number');
    await jump(canvasElement, '1000');
    await expect(await view.findByText('Episode 1000')).toBeVisible();
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Last watched: Episode 1000');
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="main"] [data-state="done"]')).not.toBeNull());
    await jump(canvasElement, '1001');
    await expect(await view.findByText('There is no episode 1001 in this series.')).toBeVisible();
    await expect(canvasElement.querySelector('[data-selected]')).toBeNull();
  },
};

function unreadMain(shape: { scope: string; resolved: string; complete: boolean; items: unknown[] }): EpisodeApi {
  const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000002';
  const occurrence = 'https://rezics.com/id/00000000-0000-7000-8000-000000000003';
  const client = { v1: {
    resources: () => ({ parts: { get: async () => ({ data: { structure, parts: [] }, error: null }) } }),
    compositions: () => ({ get: async () => ({ data: {
      occurrences: [{ occurrence, role: 'part', target: saoOne, labels: [{ value: 'Episode 1' }] }], next: null,
    }, error: null }) }),
    'reading-positions': () => ({ get: async () => ({ data: shape, error: null }) }),
  } } as unknown as MainClient;
  return mainEpisodeApi(saoOne, () => client);
}

export const UnreadSavedProgress: Story = {
  args: { api: unreadMain({ scope: 'positions', resolved: 'start', complete: true, items: [] }) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByLabelText('Go to episode number');
    await expect(view.getByText('Unknown')).toBeVisible();
    await expect(view.queryByText('No episode watched yet')).toBeNull();
  },
};
export const IncompleteResume: Story = {
  args: { api: unreadMain({ scope: 'resume', resolved: 'pending', complete: false, items: [] }) },
  async play({ canvasElement }) {
    const view = within(canvasElement);
    await view.findByLabelText('Go to episode number');
    await expect(view.getByText('Unknown')).toBeVisible();
    await expect(view.queryByRole('alert')).toBeNull();
    await expect(view.queryByText('No episode watched yet')).toBeNull();
  },
};
export const Desktop: Story = { globals: { viewport: { value: 'desktop' } } };
