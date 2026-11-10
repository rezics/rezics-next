import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CatalogueFileReader } from '../features/catalogue/catalogue-file-reader/reader';
import { catalogueFileReaderVisit } from '../features/catalogue/catalogue-file-reader/model';
import {
  CatalogueFileProfilePage,
  type CatalogueFileTransport,
} from '../features/catalogue/catalogue-file-profile/view';
import { CatalogueFileProfileContextUnavailable } from '../features/catalogue/catalogue-file-profile/context-unavailable';
import {
  catalogueFileGlobalHref,
  parseCatalogueFileCorrectionOrigin,
  type ParsedCatalogueFileCorrectionOrigin,
} from '../features/catalogue/catalogue-file-profile/origin';
import type { CatalogueFileRead } from '../features/catalogue/catalogue-file-profile/read';
import { catalogueFile, catalogueFileProfileFixture } from '../kernel/fake/catalogue-file-profile';
import { CandidateReaderBoundary } from '../subject/candidate-lifetime';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function PublicCorrection({ state = 'entry' }: { state?: 'entry' | 'restart' | 'unsupported' }) {
  const locale = getLocale();
  const initialHref = `/${locale}/subjects/${catalogueFile}/episode-file`;
  const [href, setHref] = useState(initialHref);
  const [origin, setOrigin] = useState<ParsedCatalogueFileCorrectionOrigin>();
  const fixture = useMemo(() => catalogueFileProfileFixture('ready', locale), [locale]);
  const [read, setRead] = useState<Extract<CatalogueFileRead, { ok: true }>>();
  // Each public return gets a fresh supplied composition, just as the ordinary route loader does.
  useEffect(() => {
    let current = true;
    setRead(undefined);
    void fixture.read().then((value) => {
      if (current && value.ok) setRead(value);
    });
    return () => {
      current = false;
    };
  }, [fixture, href]);
  const transport = useMemo<CatalogueFileTransport>(() => {
    const unexpected = async (): Promise<never> => {
      throw new Error('This navigation story does not submit commands');
    };
    return {
      read: fixture.read,
      facts: {
        read: async () =>
          read
            ? { ok: true, public: read.public, release: read.release, source: null }
            : { ok: false, reason: 'unavailable' },
        propose: unexpected,
      },
      relation: () => ({ read: unexpected, propose: unexpected, confirm: unexpected }),
      review: () => ({ read: async () => ({ ok: false, reason: 'denied' }), confirm: unexpected }),
    };
  }, [fixture, read]);
  const correction = state === 'restart' || !!origin;
  const returnHref = origin?.kind === 'valid' ? origin.origin.returnHref : `${initialHref}#catalogue-file-reader`;
  return (
    <PatternStory path={`/subjects/${catalogueFile}/episode-file`} visitor="Signed In">
      <AppShell>
        <div
          className="mx-auto max-w-4xl p-4 sm:p-6"
          onClick={(event) => {
            const anchor = (event.target as Element).closest('a');
            if (!anchor || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey) return;
            const url = new URL(anchor.href);
            if (url.pathname.endsWith('/file') && url.searchParams.has('origin')) {
              event.preventDefault();
              setOrigin(parseCatalogueFileCorrectionOrigin(url.searchParams.get('origin'), locale, catalogueFile));
            } else if (anchor.getAttribute('href') === returnHref) {
              event.preventDefault();
              setOrigin(undefined);
              setHref(returnHref);
            }
          }}
        >
          {state === 'unsupported' ? (
            <CatalogueFileProfileContextUnavailable
              locale={locale}
              returnHref={returnHref}
              globalHref={catalogueFileGlobalHref(catalogueFile, locale, catalogueFile, returnHref)}
            />
          ) : correction ? (
            <CandidateReaderBoundary
              observed={{ state: 'signed-in', subject: catalogueFile, csrfToken: 'story-observation' }}
              address={`${initialHref}/file`}
            >
              <CatalogueFileProfilePage
                id={catalogueFile}
                locale={locale}
                transport={transport}
                search={async () => []}
                returnSourceId={catalogueFile}
                returnHref={returnHref}
                origin={origin?.kind === 'valid' ? origin.origin : undefined}
                originInvalid={state === 'restart' || origin?.kind === 'invalid'}
              />
            </CandidateReaderBoundary>
          ) : read ? (
            <CatalogueFileReader
              key={href}
              visit={catalogueFileReaderVisit({
                public: read.public,
                locale,
                release: read.release,
                digest: read.digest,
                allowCorrection: true,
              })}
              currentHref={href}
            />
          ) : (
            <p role="status">{m.candidate_loading()}</p>
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/File public correction origin',
  id: 'pages-subjects-file-public-correction-origin',
  component: PublicCorrection,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'The actual public correction entry and installed receiver, with bounded supplied reads. Native and browser acceptance remain separate.',
      },
    },
  },
} satisfies Meta<typeof PublicCorrection>;
export default meta;
type Story = StoryObj<typeof meta>;
const correctAndReturn: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const inspect = await canvas.findAllByRole('button', { name: m.catalogue_file_inspect_assertion() });
  await userEvent.click(inspect[0]!);
  await userEvent.click(
    canvasElement.querySelector<HTMLAnchorElement>('[data-slot="catalogue-file-reader-correction"] a')!,
  );
  await userEvent.click(await canvas.findByRole('link', { name: m.catalogue_file_reader_return() }));
  await expect(await canvas.findByRole('region', { name: m.catalogue_file_inspection_title() })).toBeVisible();
};
export const PublicEntry: Story = { globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390' } } };
export const CurrentScalarReturn: Story = {
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'desktop1440' } },
  play: correctAndReturn,
};
export const Restart: Story = {
  args: { state: 'restart' },
  globals: { locale: 'zh-Hans', theme: 'light', viewport: { value: 'phone390' } },
};
export const UnsupportedAndGlobal: Story = {
  args: { state: 'unsupported' },
  globals: { locale: 'ja', theme: 'dark', viewport: { value: 'desktop1440' } },
};
export const KoreanEntry: Story = { globals: { locale: 'ko', theme: 'dark', viewport: { value: 'phone390' } } };
export const GermanReturn: Story = {
  globals: { locale: 'de', theme: 'light', viewport: { value: 'desktop1440' } },
  play: correctAndReturn,
};
export const FrenchRestart: Story = {
  args: { state: 'restart' },
  globals: { locale: 'fr', theme: 'dark', viewport: { value: 'phone390' } },
};
export const SpanishUnsupported: Story = {
  args: { state: 'unsupported' },
  globals: { locale: 'es', theme: 'light', viewport: { value: 'desktop1440' } },
};
