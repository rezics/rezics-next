import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { AlbumTrackReader } from '../features/catalogue/album-track-reader/view';
import {
  albumTrackExample,
  exampleAddress,
  type AlbumTrackExample,
} from '../features/catalogue/album-track-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function AlbumContentsRecoveryStory({ scenario = 'admitted' }: { scenario?: AlbumTrackExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => albumTrackExample(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path={`/subjects/${exampleAddress.id}/harbour-sessions`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour sessions</h1>
          <AlbumTrackReader
            {...exampleAddress}
            locale={locale}
            source={fixture}
            reader={null}
            transport={fixture.read}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Album contents recovery',
  component: AlbumContentsRecoveryStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Bounded page navigation and current album route recovery using admitted fixture responses.',
      },
    },
  },
} satisfies Meta<typeof AlbumContentsRecoveryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const PreviousAndStart: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.work_parts_more() }));
    const previous = await canvas.findByRole('button', { name: m.album_tracks_previous() });
    await expect(previous).toBeEnabled();
    await userEvent.click(previous);
    await expect(canvas.getAllByRole('button', { name: new RegExp(m.album_tracks_inspect()) }).length).toBe(3);
    await userEvent.click(canvas.getByRole('button', { name: m.work_parts_restart() }));
    await expect(canvas.getAllByRole('button', { name: new RegExp(m.album_tracks_inspect()) }).length).toBe(3);
  },
};

export const WithheldWindowCanRecoverFromCurrentAlbum: Story = {
  args: { scenario: 'withheld' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.album_tracks_withheld());
    await expect(canvas.queryAllByRole('listitem')).toHaveLength(0);
    await expect(canvas.getByRole('link', { name: m.album_tracks_subject_recovery() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.work_parts_restart() })).toBeEnabled();
  },
};
