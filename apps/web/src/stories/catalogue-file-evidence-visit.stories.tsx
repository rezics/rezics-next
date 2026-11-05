import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import { CatalogueFileReader, CatalogueFileReturnLink } from '../features/catalogue/catalogue-file-reader/reader';
import {
  catalogueFileReaderVisit,
  type CatalogueFileReaderVisit,
} from '../features/catalogue/catalogue-file-reader/model';
import { fileEvidenceAt } from '../features/catalogue/catalogue-file-reader/navigation';
import { catalogueFile, catalogueFileProfileFixture } from '../kernel/fake/catalogue-file-profile';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import type { PageLink } from '../features/pages/shared';

function EvidenceVisit({
  replaced = false,
  partial = false,
  signedIn = false,
}: {
  replaced?: boolean;
  partial?: boolean;
  signedIn?: boolean;
}) {
  const locale = getLocale();
  const source = `/${locale}/subjects/${catalogueFile}/episode-1-file-a?realm=00000000-0000-4000-8000-00000000b001`;
  const [href, setHref] = useState(source);
  const [visit, setVisit] = useState<CatalogueFileReaderVisit>();
  const [retirement, setRetirement] = useState(0);
  const fixture = useMemo(() => catalogueFileProfileFixture('ready', locale), [locale]);
  const returning = !!fileEvidenceAt(href, locale) && href.includes(`/subjects/${catalogueFile}/`);
  const target = !href.includes(`/subjects/${catalogueFile}/`);
  useEffect(() => {
    let live = true;
    if (target) return;
    void fixture.read('forward:schema:encodesCreativeWork').then((result) => {
      if (!live || !result.ok) return;
      const read = structuredClone(result.public);
      read.subject.labels = {
        en: 'Episode 1 file — a long catalogue name with original evidence and several qualified sources',
        'zh-Hant': '第一集檔案：保留原始證據與多項來源限定條件的長名稱',
        ja: '第1話のファイル：元の証拠と複数の情報源を持つ長い名前',
      };
      const assertion = read.subject.statements['schema:encodesCreativeWork']![0]!;
      for (let index = 0; index < 8; index++)
        assertion.qualifiers.push({
          property: { id: 'schema:description', data_type: 'string' },
          value: { type: 'value', content: `Source ${index + 1} — 原始資料・出典` },
        });
      if (partial)
        assertion.references = [
          {
            hash: '0000000000000000000000000000000000000001',
            parts: [
              {
                property: { id: 'schema:encodesCreativeWork', data_type: 'wikibase-item' },
                value: { type: 'value', content: '00000000-0000-4000-8000-00000000ffff' },
              },
            ],
          },
        ];
      if (returning && replaced) assertion.rezics.revision++;
      setVisit(catalogueFileReaderVisit({ public: read, locale, release: result.release, digest: result.digest }));
    });
    return () => {
      live = false;
    };
  }, [fixture, target, returning, partial, replaced, retirement, locale]);
  const Link: PageLink = ({ href: next, children, ...props }) => (
    <a
      {...props}
      href={next}
      onClick={(event) => {
        if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          setVisit(undefined);
          setHref(next);
        }
      }}
    >
      {children}
    </a>
  );
  return (
    <PatternStory path={`/subjects/${catalogueFile}/episode-1-file-a`} visitor={signedIn ? 'Signed In' : 'Signed Out'}>
      <AppShell>
        <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
          {target ? (
            <section className="space-y-4">
              <h1 className="text-xl font-semibold">{m.catalogue_file_episode()}</h1>
              <CatalogueFileReturnLink id={catalogueFile} locale={locale} currentHref={href} link={Link} />
            </section>
          ) : visit ? (
            <>
              <CatalogueFileReader
                key={returning ? 'returned' : 'source'}
                visit={visit}
                currentHref={href}
                link={Link}
              />
              {returning && (
                <button
                  type="button"
                  className="min-h-11 rounded border p-3"
                  onClick={() => setRetirement((value) => value + 1)}
                >
                  {m.catalogue_file_reader_open_again()}
                </button>
              )}
            </>
          ) : (
            <p role="status">{m.candidate_loading()}</p>
          )}
        </div>
      </AppShell>
    </PatternStory>
  );
}
const meta = { title: 'Catalogue/File evidence visit', component: EvidenceVisit } satisfies Meta<typeof EvidenceVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TargetAndCurrentReturn: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const inspect = await canvas.findAllByRole('button', { name: m.catalogue_file_inspect_association() });
    await userEvent.click(inspect[0]!);
    const panel = canvasElement.querySelector('[data-slot="catalogue-file-inspection"]')!;
    await userEvent.click(within(panel as HTMLElement).getByRole('link'));
    await userEvent.click(await canvas.findByRole('link', { name: m.catalogue_file_reader_return() }));
    await expect(await canvas.findByRole('region', { name: m.catalogue_file_inspection_title() })).toBeVisible();
  },
};
export const ReplacedAssertion: Story = {
  args: { replaced: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const inspect = await canvas.findAllByRole('button', { name: m.catalogue_file_inspect_association() });
    await userEvent.click(inspect[0]!);
    await userEvent.click(
      within(canvasElement.querySelector<HTMLElement>('[data-slot="catalogue-file-inspection"]')!).getByRole('link'),
    );
    await userEvent.click(await canvas.findByRole('link', { name: m.catalogue_file_reader_return() }));
    await expect(await canvas.findByText(m.catalogue_file_return_changed())).toBeVisible();
  },
};
export const RetiredReading: Story = {
  async play(context) {
    await TargetAndCurrentReturn.play!(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.catalogue_file_reader_open_again() }));
    await expect(await canvas.findByText(m.catalogue_file_return_retired())).toBeVisible();
  },
};
export const PartialEvidence: Story = { args: { partial: true } };
export const SignedIn: Story = { args: { signedIn: true } };
