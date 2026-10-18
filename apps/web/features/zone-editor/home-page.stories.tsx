import { fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import { spaceHref } from '../address/path.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { DiscoverResourceCard } from '../discover/resource-card.tsx';
import type { ResourceCard } from '../discover/api.ts';
import { contentText, zoneContentText } from '../language/untagged.ts';
import { PageContainer } from '../shell/page.tsx';
import { localizedPath } from '../../i18n/locale.ts';
import { fictionZone, zoneMessagesFor } from '../zones/fixtures.ts';
import { presetTokens } from '../zones/presentation.ts';
import { savedSiteCuts } from '../zones/site-cuts.ts';
import { ZoneDocumentHome } from '../zones/site-pages.tsx';
import { zoneTheme } from '../zones/theme.ts';
import { ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import type { PlacedModule } from '../zones/zone-home.tsx';
import { ZoneDraftPreview, ZonePreviewHome } from './preview.tsx';
import { loadPreviewHomeModules, localizedHomePresentation } from './home-modules.ts';
import { collectionPreview, previewCollection, previewReaders, previewShowcaseWork, previewWork } from './home-modules.fixtures.ts';
import { messages } from './messages.ts';
import type { ZoneHomePage } from './home-document.tsx';

const homeDocument = structuredClone(fromPlainText('Morning edition of the harbor', 'blocks'));
const definition = 'https://rezics.com/definition/showcase-block-v1';
homeDocument.doc.content!.push({ type: 'extensionBlock', attrs: {
  id: 'showcase', definition, version: '2', fallback: 'Showcase fallback text',
  payload: {
    'rv:module': [{ id: 'showcase', type: 'hero-carousel', title: 'Harbor showcase',
      source: { kind: 'query-block', block: 'new-adoptions' } }],
    'rv:slides': [{ id: 'harbor', title: 'The harbor exhibition', href: '/harbor-exhibition' }],
    'rv:titleEffect': ['plain'],
  },
} });
const page: ZoneHomePage = { document: homeDocument, blocks: [{ id: 'showcase', definition, version: '2',
  fallback: 'Showcase fallback text', status: 'resolved', kind: 'showcase', showcase: 'showcase' }] };
const modules: PlacedModule[] = [
  { module: { id: 'showcase', type: 'hero-carousel', title: 'Harbor showcase', rail: false,
    layout: 'covers', shuffle: false, more: null },
  state: { state: 'ready', data: { slides: [{ id: 'harbor', title: zoneContentText('The harbor exhibition', 'en'),
    href: '/harbor-exhibition', work: null }] } } },
  { module: { id: 'notice', type: 'announcement', title: 'The harbor is open', rail: false,
    layout: 'covers', shuffle: false, more: null },
  state: { state: 'ready', data: { text: zoneContentText('The harbor is open', 'en'), href: null } } },
];
const zone = { ...fictionZone('en'), name: zoneContentText('Harbor notes', 'en'),
  description: null, icon: null, hero: null,
  tokens: { ...presetTokens.clean, density: 'compact' as const, pageSurface: 'cards' as const } };
const cuts = savedSiteCuts({ tokens: zone.tokens, navigation: [{ label: 'Saved visitor guide', href: '/harbor-guide' }] },
  [{ segment: 'charts', name: zoneContentText('Harbor charts', 'en') }], 'harbor', 'en', 'Home');
const sitePath = spaceHref('harbor', 'site');

function Home({ preview = false }: { preview?: boolean }) {
  const body = <ZoneDocumentHome page={page} modules={modules} zone={zone} pkg={null} locale="en"
    messages={zoneMessagesFor('en')} representedShowcases={['showcase']} preview={preview} />;
  return <ZoneFrame zone={zone} dataZone="harbor" theme={zoneTheme(zone.tokens, { reader: 'light', enabled: true })}
    pkg={null} members={null} actions={null} tabs={null}
    masthead={<ZoneMasthead zone={zone} members={null} actions={null} />}
    site={{ label: zone.name.value, links: cuts.navigation }}>
    {preview ? <PageContainer><ZoneDraftPreview copy={messages.en} document={homeDocument} editorPath="/manage/z/harbor"
      sitePath={sitePath} status="private">{body}</ZoneDraftPreview></PageContainer> : body}
  </ZoneFrame>;
}

const meta = { title: 'Zone editor/Complete home', beforeEach: seedServedTypes,
  parameters: { route: { pathname: localizedPath(sitePath, 'en') } } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function checkHome(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getByText('The harbor exhibition', { exact: true })).toBeVisible();
  await expect(canvasElement.querySelectorAll('.showcase-slide')).toHaveLength(1);
  await expect(canvas.getByText('The harbor is open', { exact: true })).toBeVisible();
  await expect(canvas.getByText('Morning edition of the harbor')).toBeVisible();
  await expect(canvas.queryByText('Showcase fallback text')).not.toBeInTheDocument();
  const navigation = within(canvasElement.querySelector<HTMLElement>('[data-zone-site-navigation]')!);
  await expect(navigation.getAllByRole('link').map(link => link.textContent)).toEqual(['Home', 'Saved visitor guide', 'Harbor charts']);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const PublishedHome: Story = { render: () => <Home />, async play({ canvasElement }) { await checkHome(canvasElement); } };
export const PublishedHomePhone: Story = { ...PublishedHome, globals: { viewport: { value: 'phone' } } };
export const SavedPreview: Story = { render: () => <Home preview />,
  async play({ canvasElement }) {
    await checkHome(canvasElement);
    await expect(within(canvasElement).getByRole('heading', { name: 'Draft preview' })).toBeVisible();
  } };
export const SavedPreviewPhone: Story = { ...SavedPreview, globals: { viewport: { value: 'phone' } } };

type SavedCollectionProps = { incomplete?: boolean; document?: boolean; compare?: boolean;
  moduleType?: 'shelf' | 'editorial-list' | 'hero-carousel'; unavailable?: boolean; rtl?: boolean };
function SavedCollection({ incomplete = false, document = true, compare = false,
  moduleType = 'shelf', unavailable = false, rtl = false }: SavedCollectionProps) {
  const [savedModules, setSavedModules] = useState<PlacedModule[]>([]);
  const book = useMemo(() => ({ ...previewShowcaseWork, title: compare ? {
    ...contentText(rtl ? 'كبرياء وتحامل' : 'Pride and Prejudice', rtl ? 'ar' : 'en'),
    basis: 'requested' as const,
  } : previewShowcaseWork.title }), [compare, rtl]);
  useEffect(() => {
    const preview = collectionPreview(incomplete ? 'partial' : 'complete');
    preview.presentation.modules[0]!.type = moduleType;
    if (moduleType === 'hero-carousel') preview.presentation.slides = [{ id: 'saved-book', work: previewWork }];
    const readers = { ...previewReaders(), async summaries(targets: readonly string[]) {
      return new Map(targets.flatMap(target => !unavailable && target === book.id ? [[target, book] as const] : []));
    } };
    let active = true;
    void loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'), {
      locale: 'en', ref: 'harbor', realm: previewCollection,
      mounts: new Map([[previewCollection, 'saved-reading']]),
    }, readers).then(loaded => { if (active) setSavedModules(loaded.modules); });
    return () => { active = false; };
  }, [incomplete, moduleType, unavailable, book]);
  const canonical: ResourceCard = { id: book.id, kind: 'work', types: book.types, name: book.title, icon: book.cover,
    work: { primaryCredits: book.primaryCredits.map(credit => ({ ...credit, identityStatus: 'active' as const })),
      creditCount: { value: book.primaryCredits.length, kind: 'exact' }, rating: null } };
  return <ZoneFrame zone={zone} dataZone="harbor" theme={zoneTheme(zone.tokens, { reader: 'light', enabled: true })}
    pkg={null} members={null} actions={null} tabs={null}
    masthead={<ZoneMasthead zone={zone} members={null} actions={null} />}
    site={{ label: zone.name.value, links: cuts.navigation }}>
    <PageContainer>{compare && <section aria-label="Discover"><h2>Discover</h2>
      <div className="max-w-48"><DiscoverResourceCard item={canonical} locale="en" /></div>
    </section>}<ZoneDraftPreview copy={messages.en} document={document ? homeDocument : null}
      editorPath="/manage/z/harbor" sitePath={sitePath} status="private">
      <ZonePreviewHome page={document ? { document: fromPlainText('Morning edition of the harbor', 'blocks'), blocks: [] } : null}
        modules={savedModules} zone={zone} pkg={null} locale="en"
        messages={zoneMessagesFor('en')} copy={messages.en} />
    </ZoneDraftPreview></PageContainer>
  </ZoneFrame>;
}

export const SavedCollectionPreview: Story = { render: () => <SavedCollection />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'The saved Collection member' })).toBeVisible();
    await expect(canvas.getByText('Morning edition of the harbor')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  } };
export const SavedCollectionPreviewPhone: Story = { ...SavedCollectionPreview, globals: { viewport: { value: 'phone' } } };
export const PresentationOnlyPreview: Story = { render: () => <SavedCollection document={false} />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { name: 'The saved Collection member' })).toBeVisible();
    await expect(canvasElement.querySelector('.rezics-document')).not.toBeInTheDocument();
  } };
export const IncompleteCollectionPreview: Story = { render: () => <SavedCollection incomplete />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Couldn’t load Saved reading list')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(canvas.queryByText('The saved Collection member')).not.toBeInTheDocument();
  } };

async function checkBookIdentity(canvasElement: HTMLElement, rtl = false) {
  const canvas = within(canvasElement);
  const title = rtl ? 'كبرياء وتحامل' : 'Pride and Prejudice';
  await waitFor(() => expect(canvas.getAllByRole('heading', { name: title })).toHaveLength(2));
  const covers = canvasElement.querySelectorAll('[data-slot="work-cover"]');
  await expect(covers).toHaveLength(2);
  for (const cover of covers) await expect(cover).toHaveAttribute('data-kind', 'book');
  await expect(canvas.getAllByText('Jane Austen', { exact: true }).length).toBeGreaterThanOrEqual(2);
  if (rtl) for (const heading of canvas.getAllByRole('heading', { name: title })) {
    await expect(heading).toHaveAttribute('lang', 'ar');
    await expect(heading).toHaveAttribute('dir', 'rtl');
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const CanonicalAndSavedBook: Story = { render: () => <SavedCollection compare />,
  async play({ canvasElement }) { await checkBookIdentity(canvasElement); } };
export const CanonicalAndSavedBookPhone: Story = { ...CanonicalAndSavedBook, globals: { viewport: { value: 'phone' } } };
export const SavedEditorialBook: Story = { render: () => <SavedCollection compare moduleType="editorial-list" />,
  async play({ canvasElement }) { await checkBookIdentity(canvasElement); } };
export const SavedScheduledBook: Story = { render: () => <SavedCollection compare moduleType="hero-carousel" />,
  async play({ canvasElement }) { await checkBookIdentity(canvasElement); } };
export const SavedRtlBook: Story = { render: () => <SavedCollection compare rtl />,
  async play({ canvasElement }) { await checkBookIdentity(canvasElement, true); } };
export const SavedRtlBookPhone: Story = { ...SavedRtlBook, globals: { viewport: { value: 'phone' } } };
export const UnavailableSavedBook: Story = { render: () => <SavedCollection unavailable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Couldn’t load Saved reading list')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="work-cover"]')).not.toBeInTheDocument();
  } };
