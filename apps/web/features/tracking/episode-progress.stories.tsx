import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { PageContainer } from '../shell/page.tsx';
import { createMemoryEpisodes, type MemoryEpisodes } from './episode-memory.ts';
import { episodeSeries, saoOne } from './fixtures.ts';
import { createMemoryMain, type MemoryMain, memoryReader } from './memory.ts';
import { SeriesProgressPanel } from './series-progress-panel.tsx';

interface Args { locale: UiLocale; main: MemoryMain }

/** One device acting on the shared in-memory Main. */
function Device({ locale, main }: Args) {
  const [actions] = useState(() => memoryReader(main));
  return <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>
    <PageContainer className="grid max-w-md gap-6"><SeriesProgressPanel work={saoOne} locale={locale} /></PageContainer>
  </ReaderActionsProvider>;
}

const withEpisodes = (episodes: MemoryEpisodes) => createMemoryMain({ episodes });
const finishedThrough = (episodes: MemoryEpisodes, count: number) => {
  for (const item of episodes.items.slice(0, count)) {
    episodes.progress.set(item.occurrence, { completed: true, position: `episode:${item.ordinal}`, version: 1 });
  }
  return episodes;
};

const meta = {
  title: 'Tracking/Episode progress',
  component: Device,
  parameters: { docs: { description: { component:
    'A series that places its episodes or chapters as Structure occurrences: where the reader is, the next one to mark in a tap, a jump by number, and specials kept apart from the main run.' } } },
  args: { locale: 'en', main: withEpisodes(createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 }))) },
  globals: { viewport: { value: 'mobile1' } },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const panel = (canvasElement: HTMLElement) => within(canvasElement);

/** Marks the next episode seven times, then a special: the special leaves the main count where it was. */
export const MarkNextAndSpecial: Story = {
  args: { main: withEpisodes(createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 }))) },
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('No episode watched yet');
    for (let number = 1; number <= 7; number++) {
      await userEvent.click(await view.findByRole('button', { name: `Mark episode ${number} watched` }));
      await view.findByText(`Watched through episode ${number} of 12`);
    }
    await expect(view.getByText('Continue from episode 8')).toBeVisible();

    await userEvent.click(view.getByRole('button', { name: 'Special 1' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="special"] [data-state="done"]')).not.toBeNull());
    await view.findByText('Watched through episode 7 of 12');
    await expect(view.getByText('Continue from episode 8')).toBeVisible();
    await expect(view.getByRole('button', { name: 'Mark episode 8 watched' })).toBeVisible();
  },
};

/** Another device marked seven episodes: this one, loaded fresh, shows the same place. */
export const ResumesOnAnotherDevice: Story = {
  args: { main: withEpisodes(finishedThrough(createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 })), 7)) },
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('Watched through episode 7 of 12');
    await expect(view.getByText('Continue from episode 8')).toBeVisible();
    await expect(view.getByRole('progressbar')).toBeVisible();
  },
};

/** Jump to any episode by number, mark it, and the run continues from it. */
export const JumpByNumber: Story = {
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('No episode watched yet');
    await userEvent.type(view.getByLabelText('Go to episode number'), '9');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Watched through episode 9 of 12');
    await expect(view.getByText('Continue from episode 10')).toBeVisible();
    await userEvent.clear(view.getByLabelText('Go to episode number'));
    await userEvent.type(view.getByLabelText('Go to episode number'), '40');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await expect(await view.findByText('There is no episode 40 in this series.')).toBeVisible();
  },
};

/** A thousand chapters, a hundred listed: chapter 1000 is reached by its number. */
export const ThousandChapters: Story = {
  args: { main: withEpisodes(createMemoryEpisodes(episodeSeries({ mains: 1000, role: 'chapter' }))) },
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('No chapter read yet');
    await expect(view.getByText(/Only the first 100 are listed here/)).toBeVisible();
    await userEvent.type(view.getByLabelText('Go to chapter number'), '1000');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await userEvent.click(await view.findByRole('button', { name: 'Mark read' }));
    await view.findByText('Read through chapter 1000');
    await expect(view.getByText('You have read every chapter.')).toBeVisible();
  },
};

export const Desktop: Story = { globals: { viewport: { value: 'desktop' } } };
