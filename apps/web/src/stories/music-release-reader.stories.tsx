import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MusicReleaseReader } from '../features/catalogue/music-release-reader/view';
import {
  musicReleaseExample,
  musicAddress,
  type MusicReleaseExample,
} from '../features/catalogue/music-release-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function MusicReleaseStory({ scenario = 'admitted' }: { scenario?: MusicReleaseExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => musicReleaseExample(scenario, locale), [scenario, locale]);
  return (
    <PatternStory path={`/subjects/${musicAddress.id}/harbour-sessions`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">Harbour sessions</h1>
          <MusicReleaseReader
            {...musicAddress}
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
  title: 'Pages/Catalogue/Music release reader',
  component: MusicReleaseStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Configured source examples through the installed generated relations client. These examples do not publish a native Release or establish native/rendered acceptance.',
      },
    },
  },
} satisfies Meta<typeof MusicReleaseStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AdmittedEdition: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const occurrences = await canvas.findAllByRole('button', { name: new RegExp(m.music_release_inspect()) });
    await userEvent.click(occurrences[1]!);
    const inspector = canvas.getByRole('region', { name: new RegExp(m.music_release_occurrence()) });
    await expect(within(inspector).getByRole('link', { name: m.album_tracks_open() })).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(canvas.getAllByRole('button', { pressed: true }).length).toBe(2);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_close() }));
    await userEvent.click(canvas.getByRole('button', { name: m.work_parts_more() }));
    await canvas.findByText(m.album_tracks_complete());
    await userEvent.click(canvas.getByRole('button', { name: m.album_tracks_previous() }));
    await canvas.findAllByRole('button', { name: new RegExp(m.music_release_inspect()) });
  },
};
export const MissingConfiguration: Story = { args: { scenario: 'unconfigured' } };
export const UnavailableContinuation: Story = {
  args: { scenario: 'continuation-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = await canvas.findByRole('button', { name: m.work_parts_more() });
    await userEvent.click(next);
    await canvas.findByText(m.music_release_window_unavailable());
    await expect(canvas.getAllByRole('button', { name: new RegExp(m.music_release_inspect()) }).length).toBe(3);
  },
};
export const ExplicitTba: Story = { args: { scenario: 'tba' } };
export const EmptyAssociations: Story = { args: { scenario: 'empty' } };
