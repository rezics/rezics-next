import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import {
  catalogueFileReaderVisit,
  type CatalogueFileReaderVisit,
} from '../features/catalogue/catalogue-file-reader/model';
import { CatalogueFileReader } from '../features/catalogue/catalogue-file-reader/reader';
import { catalogueFileProfileFixture, catalogueFile } from '../kernel/fake/catalogue-file-profile';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

function CatalogueFileReaderStory({
  unsupported = false,
  longValue = false,
  empty = false,
}: {
  unsupported?: boolean;
  longValue?: boolean;
  empty?: boolean;
}) {
  const locale = getLocale();
  const fixture = useMemo(
    () => catalogueFileProfileFixture(unsupported ? 'unreleased' : 'ready', locale),
    [locale, unsupported],
  );
  const [visit, setVisit] = useState<CatalogueFileReaderVisit>();
  useEffect(() => {
    let live = true;
    void fixture.read(unsupported ? undefined : 'forward:schema:encodesCreativeWork').then((result) => {
      if (!live || !result.ok) return;
      const publicRead = structuredClone(result.public);
      if (longValue) {
        const codec = publicRead.subject.statements['rezics:codec']?.[0];
        if (codec) codec.value = { type: 'value', content: `unknown-codec-${'x'.repeat(96)}` };
      }
      if (empty) {
        publicRead.subject.statements = {};
        publicRead.subject.sourceRecords = [];
      }
      const stream = result.stream;
      const relationPages =
        stream && !empty
          ? [
              {
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
              },
            ]
          : [];
      setVisit(
        catalogueFileReaderVisit({
          locale,
          public: publicRead,
          release: result.release,
          digest: result.digest,
          relationPages,
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [empty, fixture, locale, longValue, unsupported]);
  if (!visit) {
    return (
      <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed Out">
        <AppShell>
          <div className="mx-auto max-w-4xl p-6" role="status">
            {m.candidate_loading()}
          </div>
        </AppShell>
      </PatternStory>
    );
  }
  return (
    <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed Out">
      <AppShell>
        <div className="mx-auto max-w-4xl p-4 sm:p-6">
          <CatalogueFileReader
            visit={visit}
            currentHref={`/${locale}/subjects/${catalogueFile}/episode-file`}
            recoverCurrentPage={async () => {}}
          />
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Catalogue file reader',
  id: 'pages-subjects-catalogue-file-reader',
  component: CatalogueFileReaderStory,
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'Illustrative ordinary-reader states built from a bounded supplied catalogue sample. The sample establishes neither native availability nor rendered acceptance.',
      },
    },
  },
} satisfies Meta<typeof CatalogueFileReaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const inspectByKeyboard: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const trigger = canvasElement.querySelector<HTMLButtonElement>('[data-inspection-kind="association"]');
  if (!trigger) throw new Error('Expected an admitted association inspection control');
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const heading = canvasElement.querySelector<HTMLElement>('#catalogue-file-inspection-heading');
  await expect(heading).toHaveFocus();
  const close = canvasElement.querySelector<HTMLButtonElement>('[data-slot="catalogue-file-inspection"] button');
  if (!close) throw new Error('Expected a close control in the selected inspection');
  await userEvent.click(close);
  await expect(trigger).toHaveFocus();
};

export const AdmittedFile: Story = {
  globals: { locale: 'en' },
};
export const TraditionalChinese: Story = {
  globals: { locale: 'zh-Hant' },
};
export const SimplifiedChinese: Story = {
  globals: { locale: 'zh-Hans' },
};
export const Japanese: Story = {
  globals: { locale: 'ja' },
};
export const UnsupportedFileType: Story = {
  args: { unsupported: true },
  globals: { locale: 'en' },
};
export const LongMetadataAndKeyboardInspection: Story = {
  args: { longValue: true },
  globals: { locale: 'de' },
  play: inspectByKeyboard,
};
export const AdmittedEmptyPage: Story = {
  args: { empty: true },
  globals: { locale: 'es' },
};
