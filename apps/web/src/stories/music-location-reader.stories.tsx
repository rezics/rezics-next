import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MusicLocationReader } from '../features/catalogue/music-location-reader/view';
import {
  musicLocationExample,
  type MusicLocationExample,
} from '../features/catalogue/music-location-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function MusicLocationStory({ scenario = 'admitted-place' }: { scenario?: MusicLocationExample }) {
  const locale = getLocale();
  const fixture = useMemo(() => musicLocationExample(scenario, locale), [scenario, locale]);
  const title = Object.values(fixture.public.subject.labels)[0] ?? 'Music context';
  return (
    <PatternStory path={`/subjects/${fixture.address.id}/music-context`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="text-3xl font-semibold">{title}</h1>
          <MusicLocationReader
            subject={fixture.public}
            context={fixture.address.context}
            source={fixture.source}
            reader={null}
            locale={locale}
            transport={fixture.read}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Music location reader',
  component: MusicLocationStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored examples exercise the ordinary Subject destination reader. They do not publish a native Release or establish native/rendered acceptance.',
      },
    },
  },
} satisfies Meta<typeof MusicLocationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AdmittedPlace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.music_context_place());
    await userEvent.click(await canvas.findByRole('button', { name: 'Venue for' }));
    const target = await canvas.findByRole('link', { name: m.album_tracks_open() });
    await expect(target).toHaveAttribute('href', expect.stringContaining('/en/subjects/'));
    await expect(target).toHaveAttribute('target', '_blank');
    await expect(canvas.getByText('Venue for')).toBeVisible();
    await expect(canvas.getByText(/2024/)).toBeVisible();
  },
};
export const AdmittedEvent: Story = { args: { scenario: 'admitted-event' } };
export const AdmittedArea: Story = { args: { scenario: 'admitted-area' } };
export const AdmittedInstrument: Story = { args: { scenario: 'admitted-instrument' } };
export const SparseSubject: Story = { args: { scenario: 'sparse' } };
export const HiddenDestination: Story = { args: { scenario: 'hidden-target' } };
export const UnsupportedType: Story = { args: { scenario: 'unsupported' } };
export const RetiredObservation: Story = { args: { scenario: 'retired' } };
