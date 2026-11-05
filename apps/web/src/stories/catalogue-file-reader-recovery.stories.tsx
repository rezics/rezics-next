import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import {
  catalogueFileReaderVisit,
  type CatalogueFileReaderVisit,
} from '../features/catalogue/catalogue-file-reader/model';
import { CatalogueFileReader } from '../features/catalogue/catalogue-file-reader/reader';
import { CatalogueFileProfileContextUnavailable } from '../features/catalogue/catalogue-file-profile/session';
import { catalogueFileGlobalHref } from '../features/catalogue/catalogue-file-profile/origin';
import { catalogueFileProfileFixture, catalogueFile } from '../kernel/fake/catalogue-file-profile';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

function CatalogueFileReaderRecoveryStory({ reject = false }: { reject?: boolean }) {
  const locale = getLocale();
  const fixture = useMemo(() => catalogueFileProfileFixture('ready', locale), [locale]);
  const [visit, setVisit] = useState<CatalogueFileReaderVisit>();
  useEffect(() => {
    let live = true;
    void fixture.read().then((result) => {
      if (!live || !result.ok) return;
      const publicRead = structuredClone(result.public);
      publicRead.subject.labels = {
        [locale]: `${publicRead.subject.labels.en ?? 'Catalogue file'} ${'wrapped-metadata-'.repeat(8)}`,
      };
      setVisit(
        catalogueFileReaderVisit({
          locale,
          public: publicRead,
          release: result.release,
          digest: result.digest,
          unavailable: true,
        }),
      );
    });
    return () => {
      live = false;
    };
  }, [fixture, locale]);
  if (!visit)
    return (
      <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed Out">
        <AppShell>
          <div className="mx-auto max-w-4xl p-6" role="status">
            {m.candidate_loading()}
          </div>
        </AppShell>
      </PatternStory>
    );
  return (
    <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed Out">
      <AppShell>
        <div className="mx-auto max-w-4xl p-4 sm:p-6">
          <CatalogueFileReader
            visit={visit}
            currentHref={`/${locale}/subjects/${catalogueFile}/episode-file`}
            recoverCurrentPage={async () => {
              if (reject) throw new Error('Subject page refresh failed');
            }}
          />
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Catalogue file reader recovery',
  component: CatalogueFileReaderRecoveryStory,
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
        component: 'Unavailable current definitions with deliberate page retry and visible rejected-recovery feedback.',
      },
    },
  },
} satisfies Meta<typeof CatalogueFileReaderRecoveryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
const retryCurrentPage: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const o = { locale: getLocale() as never };
  const link = canvas.getByRole('link', { name: m.catalogue_file_reader_open_again({}, o) });
  await expect(link).toHaveAttribute('href', '/' + getLocale() + '/subjects/' + catalogueFile + '/episode-file');
  const retry = canvas.getByRole('button', { name: m.catalogue_file_reader_retry({}, o) });
  await userEvent.click(retry);
  await expect(retry).toHaveAttribute('data-recovery-state', 'pending');
  await waitFor(() => expect(retry).toHaveAttribute('data-recovery-state', 'idle'));
};
const showRejectedRecovery: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const retry = canvas.getByRole('button', {
    name: m.catalogue_file_reader_retry({}, { locale: getLocale() as never }),
  });
  await userEvent.click(retry);
  await canvas.findByRole('alert');
  await expect(canvas.getByRole('alert')).toBeVisible();
};

export const KoreanPhoneDark: Story = {
  globals: { locale: 'ko', theme: 'dark', viewport: { value: 'phone390' } },
  play: retryCurrentPage,
};
export const GermanPhoneLight: Story = {
  globals: { locale: 'de', theme: 'light', viewport: { value: 'phone390' } },
};
export const FrenchDesktopDark: Story = {
  globals: { locale: 'fr', theme: 'dark', viewport: { value: 'desktop1280' } },
  args: { reject: true },
  play: showRejectedRecovery,
};
export const SpanishDesktopLight: Story = {
  globals: { locale: 'es', theme: 'light', viewport: { value: 'desktop1280' } },
};

function SelectedContextCorrectionUnsupported() {
  const locale = getLocale();
  const returnHref = `/${locale}/subjects/${catalogueFile}/episode-file#catalogue-file-reader`;
  return (
    <PatternStory path={`/subjects/${catalogueFile}/episode-file/file`} visitor="Signed In">
      <AppShell>
        <CatalogueFileProfileContextUnavailable
          locale={locale}
          returnHref={returnHref}
          globalHref={catalogueFileGlobalHref(catalogueFile, locale, catalogueFile, returnHref)}
        />
      </AppShell>
    </PatternStory>
  );
}

export const SelectedContextNeedsFreshGlobalVisit: Story = {
  render: () => <SelectedContextCorrectionUnsupported />,
  globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390' } },
};
