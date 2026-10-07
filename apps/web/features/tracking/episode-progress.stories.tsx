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
  for (const [index, item] of episodes.mains.slice(0, count).entries()) {
    episodes.progress.set(item.occurrence, { completed: true, position: `episode:${index + 1}`, version: 1 });
  }
  return episodes;
};

const meta = {
  title: 'Tracking/Episode progress',
  component: Device,
  parameters: { docs: { description: { component:
    'A series that places its episodes as Structure occurrences: where the reader is, the next one to mark in a tap, a jump by number, and specials kept apart from the main run.' } } },
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

/** Jump to any episode by number and mark it; one past the run marks itself and leaves the count where it was. */
export const JumpByNumber: Story = {
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('No episode watched yet');
    await userEvent.click(await view.findByRole('button', { name: 'Mark episode 1 watched' }));
    await view.findByText('Watched through episode 1 of 12');
    const go = async (number: string) => {
      await userEvent.clear(view.getByLabelText('Go to episode number'));
      await userEvent.type(view.getByLabelText('Go to episode number'), number);
      await userEvent.click(view.getByRole('button', { name: 'Go' }));
    };
    await go('2');
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await view.findByText('Watched through episode 2 of 12');
    await expect(view.getByText('Continue from episode 3')).toBeVisible();
    await go('9');
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="main"] [data-state="done"]')).not.toBeNull());
    await expect(view.getByText('Watched through episode 2 of 12')).toBeVisible();
    await go('40');
    await expect(await view.findByText('There is no episode 40 in this series.')).toBeVisible();
  },
};

/** A hundred and fifty watched, across two pages: the run is found without reading every episode. */
export const ResumesBeyondTheFirstPage: Story = {
  args: { main: withEpisodes(finishedThrough(createMemoryEpisodes(episodeSeries({ mains: 400 })), 150)) },
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('Watched through episode 150');
    await expect(view.getByText('Continue from episode 151')).toBeVisible();
  },
};

/** A thousand episodes, a hundred to a page: episode 1000 is reached by its number. */
export const ThousandEpisodes: Story = {
  args: { main: withEpisodes(createMemoryEpisodes(episodeSeries({ mains: 1000 }))) },
  async play({ canvasElement }) {
    const view = panel(canvasElement);
    await view.findByText('No episode watched yet');
    await userEvent.type(view.getByLabelText('Go to episode number'), '1000');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await expect(await view.findByText('Episode 1000')).toBeVisible();
    await userEvent.click(await view.findByRole('button', { name: 'Mark watched' }));
    await waitFor(() => expect(canvasElement.querySelector('[data-selected="main"] [data-state="done"]')).not.toBeNull());
    await userEvent.clear(view.getByLabelText('Go to episode number'));
    await userEvent.type(view.getByLabelText('Go to episode number'), '1001');
    await userEvent.click(view.getByRole('button', { name: 'Go' }));
    await expect(await view.findByText('There is no episode 1001 in this series.')).toBeVisible();
  },
};

export const Desktop: Story = { globals: { viewport: { value: 'desktop' } } };
