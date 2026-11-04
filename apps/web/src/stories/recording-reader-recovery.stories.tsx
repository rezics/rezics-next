import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecordingReleaseRead } from '../features/catalogue/recording-reader/read';
import { RecordingOverview } from '../features/catalogue/recording-reader/overview';
import { recordingType } from '../features/catalogue/recording-reader/model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { albumFixture, albumId, artistId } from '../kernel/fake/catalogue-album-profile';
import { connectionReturnHref } from '../features/pages/subject-visit-navigation';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type Scenario = 'failed' | 'retired';
const retiredStatement = '123e4567-e89b-42d3-a456-426614174000';

function fixtureFor(locale: string) {
  const value = albumFixture('ready', locale);
  value.publicRead.subject.type = recordingType;
  const album = value.release.types['schema:MusicAlbum'];
  if (!album) throw new Error('The fixture release has no album definition');
  value.release.types[recordingType] = {
    ...structuredClone(album),
    bases: ['schema:Thing'],
    labels: { en: 'recording' },
    properties: ['schema:contributor', 'schema:datePublished'],
  };
  const ensemble = value.publicRead.related[artistId];
  if (ensemble)
    ensemble.labels = {
      ...ensemble.labels,
      en: `${ensemble.labels.en ?? 'The Harbour Ensemble'} — international recording archive, restoration collective, and performance catalogue — `.repeat(2),
    };
  return value;
}

function RecordingReaderRecovery({ scenario = 'failed' }: { scenario?: Scenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => fixtureFor(locale), [locale]);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
  const attempt = useRef(0);
  useEffect(() => () => client.clear(), [client]);
  const loadRelease = useCallback(
    async (digest: string): Promise<RecordingReleaseRead> => {
      attempt.current += 1;
      if (scenario === 'failed' && attempt.current === 1) return { ok: false, reason: 'unavailable' };
      return { ok: true, digest, release: fixture.release };
    },
    [fixture, scenario],
  );
  const returnTo = connectionReturnHref(albumId, 'Harbour sessions', locale);
  const focus = scenario === 'retired' ? `#recording-statement-${retiredStatement}` : '';
  const currentHref = `/${locale}/subjects/${albumId}/harbour-recording${focus}`;
  return (
    <PatternStory path={`/subjects/${albumId}/harbour-recording`} visitor="Signed Out">
      <AppShell>
        <QueryClientProvider client={client}>
          <main className="mx-auto w-full max-w-5xl min-w-0 space-y-6 px-4 py-8 sm:px-8">
            <h1 className="text-3xl font-semibold">Harbour sessions</h1>
            <RecordingOverview
              locale={locale}
              public={fixture.publicRead}
              bounds={[{ property: 'schema:contributor', loaded: 1, next: 'prepared-cursor', complete: false }]}
              returnTo={returnTo}
              currentHref={currentHref}
              loadRelease={loadRelease}
            />
          </main>
        </QueryClientProvider>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Recording reader recovery',
  component: RecordingReaderRecovery,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' }, type: 'desktop' },
      },
    },
    docs: {
      description: {
        component:
          'Mounted RecordingOverview examples use a prepared immutable release response. They demonstrate current browser behavior without publishing native recording data.',
      },
    },
  },
} satisfies Meta<typeof RecordingReaderRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;

async function recoverRelease({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const retry = await canvas.findByRole('button', { name: m.recording_reader_retry() });
  retry.focus();
  await userEvent.keyboard('{Enter}');
  const heading = await canvas.findByRole('heading', { name: 'recording' });
  await expect(document.activeElement).toBe(heading);
  await expect(canvas.getByText('Performer')).toBeVisible();
  await expect(canvas.getByRole('link', { name: m.subject_details() })).toBeVisible();
  await expect(canvas.getByRole('link', { name: m.subject_relations() })).toBeVisible();
  for (const control of canvasElement.querySelectorAll('a, button'))
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
}

async function restartRetiredSelection({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await canvas.findByText(m.recording_reader_fact_retired());
  await expect(canvas.queryByRole('region', { name: m.recording_reader_fact_inspection() })).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: m.recording_reader_restart() }));
  await expect(canvas.queryByText(m.recording_reader_fact_retired())).toBeNull();
  await expect(canvas.getByRole('link', { name: m.subject_relations() })).toBeVisible();
}

export const FailedReleaseRecoveredPhone: Story = {
  args: { scenario: 'failed' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: recoverRelease,
};
export const FailedReleaseRecoveredDesktop: Story = {
  args: { scenario: 'failed' },
  globals: { viewport: { value: 'desktop1440' }, theme: 'dark' },
  play: recoverRelease,
};
export const RetiredExactSelectionPhone: Story = {
  args: { scenario: 'retired' },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: restartRetiredSelection,
};
export const RetiredExactSelectionDesktop: Story = {
  args: { scenario: 'retired' },
  globals: { viewport: { value: 'desktop1440' }, theme: 'light' },
  play: restartRetiredSelection,
};
