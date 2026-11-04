import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { catalogueFileReaderVisit, type CatalogueFileReaderVisit } from '../features/catalogue/catalogue-file-reader/model';
import { CatalogueFileReader } from '../features/catalogue/catalogue-file-reader/reader';
import { catalogueFileProfileFixture, catalogueFile } from '../kernel/fake/catalogue-file-profile';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

function CatalogueFileReaderStory({ unsupported = false }: { unsupported?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => catalogueFileProfileFixture(unsupported ? 'unreleased' : 'ready', locale), [locale, unsupported]);
  const [visit, setVisit] = useState<CatalogueFileReaderVisit>();
  useEffect(() => {
    let live = true;
    void fixture.read(unsupported ? undefined : 'forward:schema:encodesCreativeWork').then((result) => {
      if (!live || !result.ok) return;
      const stream = result.stream;
      const relationPages = stream
        ? [{
            property: stream.property,
            direction: stream.direction,
            rows: result.rows.map((row) => ({
              property: stream.property,
              subject: row.holder,
              statement: row.statement,
              summary: row.summary,
              related: row.related,
            })),
            complete: result.next === null,
          }]
        : [];
      setVisit(catalogueFileReaderVisit({
        locale,
        public: result.public,
        release: result.release,
        digest: result.digest,
        relationPages,
      }));
    });
    return () => {
      live = false;
    };
  }, [fixture, locale, unsupported]);
  if (!visit) {
    return (
      <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed Out">
        <AppShell>
          <div className="mx-auto max-w-4xl p-6" role="status">{m.candidate_loading()}</div>
        </AppShell>
      </PatternStory>
    );
  }
  return (
    <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed Out">
      <AppShell>
        <div className="mx-auto max-w-4xl p-4 sm:p-6">
          <CatalogueFileReader visit={visit} />
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Catalogue file reader',
  component: CatalogueFileReaderStory,
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
        component: 'Illustrative ordinary-reader states built from a bounded supplied catalogue sample. The sample establishes neither native availability nor rendered acceptance.',
      },
    },
  },
} satisfies Meta<typeof CatalogueFileReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AdmittedFile: Story = {};
export const UnsupportedFileType: Story = { args: { unsupported: true } };
