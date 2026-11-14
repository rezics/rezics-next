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
    if (!admitted) delete value.release.types[recordingType];
    if (admitted) {
      const album = value.release.types['schema:MusicAlbum'];
      if (!album) throw new Error('The fixture release has no album definition');
      value.release.types[recordingType] = {
        ...structuredClone(album),
        bases: ['schema:Thing'],
        labels: { en: 'recording' },
        properties: ['schema:contributor', 'schema:datePublished', 'wdt:P179'],
      };
      const credits = value.publicRead.subject.statements['schema:contributor']!;
      credits.push({ ...structuredClone(credits[0]!), id: '123e4567-e89b-42d3-a456-426614174001' });
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
  title: 'Catalogue/Recording reader',
  id: 'pages-catalogue-recording-reader',
  component: RecordingReaderStory,
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'Illustrative responses: the supported example supplies existing released properties in an in-memory Recording fixture; it is not native publication. The unsupported example explicitly omits MusicRecording from its prepared release, independently of the current bundled catalogue.',
      },
    },
  },
} satisfies Meta<typeof RecordingReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function inspectQualifiedFact({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const rows = [...canvasElement.querySelectorAll<HTMLElement>('[data-recording-statement]')];
  const credit = rows.find((row) => row.textContent?.includes('Performer'))!;
  const inspect = within(credit).getByRole('button', { name: m.recording_reader_inspect() });
  inspect.focus();
  await userEvent.keyboard('{Enter}');
  await canvas.findByRole('heading', { name: m.recording_reader_fact_inspection() });
  await expect(document.activeElement).toBe(inspect);
  await expect(canvas.getByRole('region', { name: m.recording_reader_fact_inspection() })).toHaveTextContent(
    'Performer',
  );
  await expect(canvas.getByRole('region', { name: m.recording_reader_fact_inspection() })).toHaveTextContent(
    'The Harbour Ensemble',
  );
  await userEvent.tab();
  await expect(document.activeElement).toBe(within(credit).getByRole('region').querySelector('button'));
  await userEvent.keyboard('{Escape}');
  await expect(document.activeElement).toBe(inspect);
  for (const row of rows) {
    const opener = within(row).getByRole('button', { name: m.recording_reader_inspect() });
    const scroll = window.scrollY;
    await userEvent.click(opener);
    const detail = canvas.getByRole('region', { name: m.recording_reader_fact_inspection() });
    await expect(opener.nextElementSibling).toBe(detail);
    await expect(document.activeElement).toBe(opener);
    await expect(window.scrollY).toBe(scroll);
    await expect(canvas.getAllByRole('region', { name: m.recording_reader_fact_inspection() })).toHaveLength(1);
    await userEvent.click(within(detail).getByRole('button', { name: m.recording_reader_close_inspection() }));
    await expect(document.activeElement).toBe(opener);
  }
  for (const control of canvasElement.querySelectorAll('a, button'))
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
}

export const AdmittedExample: Story = {
  args: { admitted: true },
  play: inspectQualifiedFact,
};
export const CurrentReleaseUnsupported: Story = { args: { admitted: false } };
