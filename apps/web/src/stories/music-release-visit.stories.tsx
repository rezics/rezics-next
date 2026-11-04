import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MusicReleaseReader } from '../features/catalogue/music-release-reader/view';
import {
  musicReleaseExample,
  musicAddress,
  releaseId,
  type MusicReleaseExample,
} from '../features/catalogue/music-release-reader/examples';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function MusicReleaseVisit({
  scenario = 'admitted',
  visitor = 'Signed Out',
  changed = false,
}: {
  scenario?: MusicReleaseExample;
  visitor?: 'Signed In' | 'Signed Out';
  changed?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const current = musicReleaseExample(scenario, locale);
    if (changed) current.publicRead.subject.revision = 2;
    return current;
  }, [scenario, locale, changed]);
  const address = changed
    ? {
        ...musicAddress,
        stream: 'forward:schema:track',
        expectedRevision: 1,
        expectedDigest: fixture.release.digest,
      }
    : undefined;
  const transport = useMemo(
    () => async (current: Parameters<typeof fixture.read>[0]) => {
      const result = await fixture.read(current);
      if (scenario === 'stream-unavailable' && !result.ok && result.reason === 'unavailable') fixture.recover();
      return result;
    },
    [fixture, scenario],
  );
  return (
    <PatternStory path={`/subjects/${releaseId}/harbour-sessions`} visitor={visitor}>
      <AppShell>
        <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
          <h1 className="break-words text-3xl font-semibold">Harbour sessions · Japan CD edition</h1>
          <MusicReleaseReader
            {...musicAddress}
            locale={locale}
            source={fixture}
            reader={null}
            transport={transport}
            {...(address ? { address } : {})}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Music release visit',
  component: MusicReleaseVisit,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Uses the retained Definition and existing Subject relation response shape. Medium and disc membership stay unavailable until their native descriptor and relation are released.',
      },
    },
  },
} satisfies Meta<typeof MusicReleaseVisit>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MediumGroupingUnavailable: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText(m.music_release_unconfigured())).resolves.toBeTruthy();
  },
};
export const QualifiedRecordingCredit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByText(m.album_tracks_inspect()))[0]!);
    await canvas.findByText('Mina Kato');
    await canvas.findByText('lead vocals');
  },
};
export const PartialDate: Story = {};
export const TbaDate: Story = { args: { scenario: 'tba' } };
export const ConcealedAssociation: Story = {
  args: { scenario: 'concealed' },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelectorAll<HTMLElement>('[data-slot="music-release-row"]')[0]!;
    await expect(row.textContent).toContain(m.music_release_withheld());
    await expect(row.querySelector('a')).toBeNull();
    await expect(row.hasAttribute('data-holder')).toBe(false);
  },
};
export const SourceUnavailable: Story = { args: { scenario: 'source-unavailable' } };
export const ExactContextReturn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click((await canvas.findAllByText(m.album_tracks_inspect()))[0]!);
    const target = await canvas.findByRole('link', { name: m.album_tracks_open() });
    const url = new URL(target.getAttribute('href')!, window.location.origin);
    await expect(url.searchParams.get('context')).toBe(musicAddress.context);
    await expect(url.searchParams.get('via')).toContain('musicReturnStream');
  },
};
export const ChangedReleaseOnReturn: Story = {
  args: { changed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.music_release_changed());
    await expect(canvasElement.querySelectorAll('[data-slot="music-release-row"]').length).toBe(0);
    await userEvent.click(canvas.getByRole('button', { name: m.work_parts_restart() }));
    await canvas.findAllByText(m.album_tracks_inspect());
  },
};
export const IndependentStreamRetryAndPrevious: Story = {
  args: { scenario: 'stream-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inverse = canvasElement.querySelector<HTMLButtonElement>('[data-stream-key="inverse:wdt:P361"]');
    if (!inverse) return;
    await userEvent.click(inverse);
    await canvas.findByText(m.music_release_next_unavailable());
    await expect(canvasElement.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);
    await userEvent.click(canvas.getByRole('button', { name: m.album_tracks_retry() }));
    await canvas.getByRole('button', { name: m.album_tracks_previous() });
    await userEvent.click(canvas.getByRole('button', { name: m.album_tracks_previous() }));
    await expect(canvasElement.querySelectorAll('[data-slot="music-release-row"]').length).toBe(2);
  },
};
export const PhoneLight: Story = {
  globals: { theme: 'light', viewport: { value: 'phone390', isRotated: false } },
};
export const DesktopDark: Story = {
  globals: { theme: 'dark', viewport: { value: 'desktop1440', isRotated: false } },
};
export const OrdinarySignedIn: Story = { args: { visitor: 'Signed In' } };
export const TraditionalChinesePhoneDark: Story = {
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
};
export const JapanesePhoneLight: Story = {
  globals: { locale: 'ja', theme: 'light', viewport: { value: 'phone390', isRotated: false } },
};
