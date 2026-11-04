import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import { RecordingReader } from '../features/catalogue/recording-reader/view';
import { recordingReaderVisit, recordingType } from '../features/catalogue/recording-reader/model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime';
import { AppShell } from '../shell/shell';
import { albumFixture, albumId } from '../kernel/fake/catalogue-album-profile';
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
    return value;
  }, [admitted, locale]);
  const read = fixture.publicRead;
  const releaseDigest = read.subject.release;
  const returnTo = connectionReturnHref(albumId, 'Harbour sessions', locale);
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
          <RecordingReader visit={visit} read={read} release={fixture.release} locale={locale} returnTo={returnTo} />
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
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
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

export const AdmittedExample: Story = { args: { admitted: true } };
export const CurrentReleaseUnsupported: Story = { args: { admitted: false } };
