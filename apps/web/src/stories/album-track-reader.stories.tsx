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

function AlbumContentsStory({ scenario = 'admitted' }: { scenario?: AlbumTrackExample }) {
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
  title: 'Pages/Catalogue/Album contents reader',
  component: AlbumContentsStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Configured source examples through the installed generated relations client. These examples do not publish a native Release or establish native/rendered acceptance.',
      },
    },
  },
} satisfies Meta<typeof AlbumContentsStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AdmittedMemberships: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const links = await canvas.findAllByRole('link', { name: m.album_tracks_open() });
    await expect(links.length).toBe(3);
    await expect(links[0]).not.toHaveAttribute('href', links[1]!.getAttribute('href'));
    await userEvent.click(canvas.getByRole('button', { name: m.work_parts_more() }));
    await canvas.findByText(m.album_tracks_complete());
  },
};
export const MissingConfiguration: Story = { args: { scenario: 'unconfigured' } };
export const UnavailableContinuation: Story = {
  args: { scenario: 'continuation-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = await canvas.findByRole('button', { name: m.work_parts_more() });
    await userEvent.click(next);
    await canvas.findByText(m.album_tracks_next_unavailable());
    await expect(canvas.getAllByRole('link', { name: m.album_tracks_open() }).length).toBe(3);
  },
};
export const Withheld: Story = { args: { scenario: 'withheld' } };
