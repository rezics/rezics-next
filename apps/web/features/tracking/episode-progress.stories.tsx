import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer } from '../shell/page.tsx';
import type { EpisodeApi } from './episode-api.ts';
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

interface Args { api: EpisodeApi; locale: UiLocale; refresh?: () => void }
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
    await view.findByText('No episode watched yet');
    await jump(canvasElement, '1');
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Last watched: Episode 1');
    await userEvent.click(view.getByRole('button', { name: 'Special 1' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
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
    await expect(view.queryByText('No episode watched yet')).toBeNull();
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

function pendingUnmark(): Args {
  const api = fixture(12, Array.from({ length: 12 }, (_, index) => index + 1));
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
  args: pendingUnmark(),
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
export const Desktop: Story = { globals: { viewport: { value: 'desktop' } } };
