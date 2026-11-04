import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { pickText } from '@rezics/composition';
import { RecordingReader } from '../features/catalogue/recording-reader/view';
import { recordingReaderVisit, recordingType } from '../features/catalogue/recording-reader/model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { albumFixture, albumId, artistId } from '../kernel/fake/catalogue-album-profile';
import { connectionReturnHref } from '../features/pages/subject-visit-navigation';
import { PatternStory } from './page';

function RecordingReaderStory({ admitted = true }: { admitted?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    const value = albumFixture('ready', locale);
    value.publicRead.subject.type = recordingType;
    if (admitted) {
      const album = value.release.types['schema:MusicAlbum'];
      if (!album) throw new Error('The fixture release has no album definition');
      value.release.types[recordingType] = {
        ...structuredClone(album),
        bases: ['schema:Thing'],
        labels: { en: 'recording' },
        properties: ['schema:contributor', 'schema:datePublished'],
      };
    }
    const ensemble = value.publicRead.related[artistId];
    if (ensemble)
      ensemble.labels = {
        ...ensemble.labels,
        en: `${ensemble.labels.en ?? 'The Harbour Ensemble'} — international recording archive, restoration collective, and performance catalogue — `.repeat(
          2,
        ),
      };
    return value;
  }, [admitted, locale]);
  const read = fixture.publicRead;
  const releaseDigest = read.subject.release;
  const returnTo = connectionReturnHref(albumId, 'Harbour sessions', locale);
  const currentHref = `/${locale}/subjects/${read.subject.id}/harbour-recording`;
  const visit = recordingReaderVisit({
    locale,
    public: read,
    release: fixture.release,
    releaseDigest,
    ...(admitted
      ? { bounds: [{ property: 'schema:contributor', loaded: 1, next: 'example-cursor', complete: false }] }
      : {}),
  });
  const title = pickText(read.subject.labels, locale);
  return (
    <PatternStory path={`/subjects/${read.subject.id}/harbour-recording`} visitor="Signed Out">
      <AppShell>
        <main className="mx-auto w-full max-w-5xl min-w-0 space-y-6 px-4 py-8">
          <h1 lang={title.lang ?? undefined} className="text-3xl font-semibold">
            {title.text}
          </h1>
          <p>
            <a className="inline-flex min-h-11 min-w-11 items-center underline underline-offset-4" href={returnTo}>
              {m.recording_reader_return({}, { locale: locale as never })}
            </a>
          </p>
          <RecordingReader
            visit={visit}
            read={read}
            release={fixture.release}
            locale={locale}
            returnTo={returnTo}
            currentHref={currentHref}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Recording reader',
  component: RecordingReaderStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
      },
    },
    docs: {
      description: {
        component:
          'UNRUN source examples. The supported example adds MusicRecording to an in-memory fixture using existing released properties; it is not native publication. The current bundled release has no MusicRecording type and renders the unsupported state.',
      },
    },
  },
} satisfies Meta<typeof RecordingReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function inspectQualifiedFact({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const inspect = canvas.getAllByRole('button', { name: m.recording_reader_inspect() })[0]!;
  inspect.focus();
  await userEvent.keyboard('{Enter}');
  const heading = await canvas.findByRole('heading', { name: m.recording_reader_fact_inspection() });
  await expect(document.activeElement).toBe(heading);
  await expect(canvas.getByRole('region', { name: m.recording_reader_fact_inspection() })).toHaveTextContent('Performer');
  await expect(canvas.getByRole('region', { name: m.recording_reader_fact_inspection() })).toHaveTextContent(
    'The Harbour Ensemble',
  );
  for (const control of canvasElement.querySelectorAll('a, button'))
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
}

export const AdmittedExample: Story = {
  args: { admitted: true },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: inspectQualifiedFact,
};
export const CurrentReleaseUnsupported: Story = { args: { admitted: false } };
export const QualifiedFactPhoneDark: Story = {
  args: { admitted: true },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: inspectQualifiedFact,
};
export const QualifiedFactDesktopLight: Story = {
  args: { admitted: true },
  globals: { viewport: { value: 'desktop1440' }, theme: 'light' },
  play: inspectQualifiedFact,
};
export const QualifiedFactDesktopDark: Story = {
  args: { admitted: true },
  globals: { viewport: { value: 'desktop1440' }, theme: 'dark' },
  play: inspectQualifiedFact,
};
