import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import anime from '../../zones/official/anime/index.tsx';
import manga from '../../zones/official/manga/index.tsx';
import games from '../../zones/official/games/index.tsx';
import visualNovels from '../../zones/official/visual-novels/index.tsx';
import books from '../../zones/official/books/index.tsx';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { RealmUnavailable } from '../realm/states.tsx';
import { RealmPageStory, realmMessagesFor } from '../realm/story-page.tsx';
import type { RealmView } from '../realm/realm-page.tsx';
import { siteHref, realmHref } from '../realm/route.ts';
import type { Loaded } from '../realm/types.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { PageContainer } from '../shell/page.tsx';
import { browseMessages } from '../discover/browse-messages.ts';
import { applyCatalogueYear } from './catalogue-browse.tsx';
import { catalogueContractSample, catalogueLabels, cataloguePersonas, catalogueRecords,
  type CatalogueSlug } from './catalogue-browse-fixtures.ts';
import { catalogueRequest, catalogueSample, readCatalogueStory } from './catalogue-browse-records.ts';
import { ZoneBrowse } from './browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { presetTokens } from './presentation.ts';
import { cardRenderer } from './zone-home.tsx';

const packages: Record<CatalogueSlug, ZonePackage> = { books, 'visual-novels': visualNovels, anime, manga, games };
type ContractState = Parameters<typeof catalogueContractSample>[1];
interface Args { slug: CatalogueSlug; persona: AnswerPersona; label?: string; loading?: boolean;
  contract?: ContractState; locale: UiLocale }

function source(args: Args) {
  const contract = args.slug === 'anime' || args.slug === 'games';
  const sample = contract ? catalogueContractSample(args.slug as 'anime' | 'games', args.contract ?? 'populated')
    : catalogueSample(catalogueRecords[args.slug]!, args.persona,
      args.label ?? catalogueLabels[args.slug as keyof typeof catalogueLabels].populated);
  const record: AnswerRecord = contract ? { version: 1, row: `${args.slug}/catalogue-browse-and-search-in-its-zone`,
    personas: Object.fromEntries(cataloguePersonas.map(persona => [persona, [sample]])) as AnswerRecord['personas'] }
    : catalogueRecords[args.slug]!;
  const facet = record.personas[args.persona].find(item => item.path === '/v1/facets');
  const state: RecordedState = args.loading ? 'loading' : sample.status >= 400 ? 'error' : 'populated';
  return { sample, record, facet, state };
}

function CatalogueDiscovery(args: Args) {
  const [shown, setShown] = useState<{ page: Loaded<BrowseModel>; header: ReactNode } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const { sample, record, facet, state } = source(args);
  const request = catalogueRequest(sample.path);
  const messages = zoneMessagesFor(args.locale);
  const zone: ZoneContext = { slug: args.slug, realm: `https://rezics.com/id/${request.realm}`,
    name: { value: { books: 'Books', 'visual-novels': 'Visual novels', anime: 'Anime', manga: 'Manga', games: 'Games' }[args.slug],
      lang: 'en', dir: 'ltr' }, description: null, icon: null, hero: null,
    tokens: presetTokens.editorial, locale: args.locale,
    links: { home: siteHref(args.locale, request.realm, []), browse: siteHref(args.locale, request.realm, ['browse']),
      works: siteHref(args.locale, request.realm, ['browse']), discussions: realmHref(args.locale, request.realm, 'discussions'),
      decisions: realmHref(args.locale, request.realm, 'decisions'), about: realmHref(args.locale, request.realm, 'about') } };
  const pkg = packages[args.slug];
  useEffect(() => {
    let active = true;
    setShown(null);
    setError(null);
    const replay = recordedFetch(record, args.persona, [{ label: sample.label, state },
      ...(facet ? [{ label: facet.label, state: 'populated' as const }] : [])], { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: args.persona === 'visitor', fetcher: replay.fetcher });
    async function load() {
      const page = await readCatalogueStory(main, sample.path, zone, args.locale, messages, !!facet, pkg.catalogue);
      const year = page.ok && pkg.catalogue ? await applyCatalogueYear({
        view: { kind: 'view', zone, pkg, context: { realm: zone.realm, ref: request.realm, locale: args.locale },
          zoneMessages: messages } as Extract<RealmView, { kind: 'view' }>, search: request.search, model: page.data,
      }) : null;
      if (active) setShown({ page, header: year?.header });
    }
    void load().catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error(String(reason))); });
    return () => { active = false; replay.dispose(); };
  }, [args.slug, args.persona, args.label, args.loading, args.contract, args.locale]);
  if (error) throw error;
  const loadingText = browseMessages[args.locale].loading;
  return <RealmPageStory zone={zone} pkg={pkg} execution={{ mode: 'package', slug: args.slug }} locale={args.locale} site>
    {!shown ? <PageContainer><p role="status" aria-busy="true">{loadingText}</p></PageContainer>
      : shown.page.ok ? <ZoneBrowse model={shown.page.data} messages={messages} header={shown.header}
        card={cardRenderer(zone, pkg, args.locale, messages)} />
        : <RealmUnavailable messages={realmMessagesFor(args.locale)} failure={shown.page.failure} />}
  </RealmPageStory>;
}

const meta = { title: 'Zones/Catalogue discovery', component: CatalogueDiscovery,
  args: { slug: 'books', persona: 'visitor', locale: 'en' },
  globals: { viewport: { value: 'desktop' } }, parameters: { route: { pathname: '/en/z/books/browse' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const { sample } = source(args);
    if (args.loading) await expect(await canvas.findByText(browseMessages[args.locale].loading)).toHaveAttribute('aria-busy', 'true');
    else if (sample.status >= 400) await expect(await canvas.findByRole(sample.status === 409 ? 'status' : 'alert')).toBeVisible();
    else {
      const page = sample.answer as import('../realm/types.ts').ZoneBrowsePage;
      if (page.items.length) await expect(await canvas.findByRole('link', { name: page.items[0]!.title.value })).toBeVisible();
      else await expect(await canvas.findByRole('status')).toBeVisible();
      if (page.nextCursor) {
        const next = await canvas.findByRole('link', { name: zoneMessagesFor(args.locale).next });
        await expect(new URL(next.getAttribute('href')!, 'https://recorded.invalid').searchParams.get('cursor')).toBe(page.nextCursor);
      }
    }
  },
} satisfies Meta<typeof CatalogueDiscovery>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BooksVisitor: Story = {};
export const BooksStranger: Story = { args: { persona: 'stranger' } };
export const BooksMember: Story = { args: { persona: 'member' } };
export const BooksOwner: Story = { args: { persona: 'owner' } };
export const BooksModerator: Story = { args: { persona: 'moderator' } };
export const BooksOperator: Story = { args: { persona: 'operator' } };
export const BooksContinuation: Story = { args: { label: catalogueLabels.books.continuation } };
export const BooksSearch: Story = { args: { label: catalogueLabels.books.search } };
export const BooksEmpty: Story = { args: { label: catalogueLabels.books.empty } };
export const BooksError: Story = { args: { label: catalogueLabels.books.error } };
export const BooksLoading: Story = { args: { loading: true } };
export const BooksPhone: Story = { globals: { viewport: { value: 'phone' } } };
export const VisualNovelsVisitor: Story = { args: { slug: 'visual-novels' } };
export const VisualNovelsStranger: Story = { args: { slug: 'visual-novels', persona: 'stranger' } };
export const VisualNovelsMember: Story = { args: { slug: 'visual-novels', persona: 'member' } };
export const VisualNovelsOwner: Story = { args: { slug: 'visual-novels', persona: 'owner' } };
export const VisualNovelsModerator: Story = { args: { slug: 'visual-novels', persona: 'moderator' } };
export const VisualNovelsOperator: Story = { args: { slug: 'visual-novels', persona: 'operator' } };
export const VisualNovelsSearchPhone: Story = { args: { slug: 'visual-novels', label: catalogueLabels['visual-novels'].search },
  globals: { viewport: { value: 'phone' } } };
export const VisualNovelsEmpty: Story = { args: { slug: 'visual-novels', persona: 'member', label: catalogueLabels['visual-novels'].empty } };
export const VisualNovelsError: Story = { args: { slug: 'visual-novels', label: catalogueLabels['visual-novels'].error } };
export const VisualNovelsLoading: Story = { args: { slug: 'visual-novels', loading: true } };
export const MangaVisitor: Story = { args: { slug: 'manga' } };
export const MangaStranger: Story = { args: { slug: 'manga', persona: 'stranger' } };
export const MangaMember: Story = { args: { slug: 'manga', persona: 'member' } };
export const MangaOwner: Story = { args: { slug: 'manga', persona: 'owner' } };
export const MangaModerator: Story = { args: { slug: 'manga', persona: 'moderator' } };
export const MangaOperator: Story = { args: { slug: 'manga', persona: 'operator' } };
export const MangaConditions: Story = { args: { slug: 'manga', label: 'combined-filters' } };
export const MangaYearAndTitle: Story = { args: { slug: 'manga', label: 'page-publication-year-and-search' } };
export const MangaYearRangePhone: Story = { args: { slug: 'manga', label: 'publication-year-range-and-format' },
  globals: { viewport: { value: 'phone' } } };
export const MangaEmpty: Story = { args: { slug: 'manga', label: catalogueLabels.manga.empty } };
export const MangaError: Story = { args: { slug: 'manga', label: catalogueLabels.manga.error } };
export const MangaLoading: Story = { args: { slug: 'manga', loading: true } };
export const AnimeContract: Story = { args: { slug: 'anime' }, parameters: { docs: { description: {
  story: 'Contract fixture; no recorded Anime answer. Exact requests/states are exported as missingCatalogueStates.' } } } };
export const AnimeEmptyContract: Story = { ...AnimeContract, args: { slug: 'anime', contract: 'empty' } };
export const AnimeStrangerContract: Story = { ...AnimeContract, args: { slug: 'anime', persona: 'stranger' } };
export const AnimeMemberContract: Story = { ...AnimeContract, args: { slug: 'anime', persona: 'member' } };
export const AnimeOwnerContract: Story = { ...AnimeContract, args: { slug: 'anime', persona: 'owner' } };
export const AnimeModeratorContract: Story = { ...AnimeContract, args: { slug: 'anime', persona: 'moderator' } };
export const AnimeOperatorContract: Story = { ...AnimeContract, args: { slug: 'anime', persona: 'operator' } };
export const AnimeLaggingContract: Story = { ...AnimeContract, args: { slug: 'anime', contract: 'lagging' } };
export const AnimeErrorContract: Story = { ...AnimeContract, args: { slug: 'anime', contract: 'error' } };
export const AnimeLoadingContract: Story = { ...AnimeContract, args: { slug: 'anime', loading: true } };
export const AnimePhoneContract: Story = { ...AnimeContract, globals: { viewport: { value: 'phone' } } };
export const GamesContract: Story = { ...AnimeContract, args: { slug: 'games' }, parameters: { docs: { description: {
  story: 'Contract fixture; no recorded Games answer. Exact requests/states are exported as missingCatalogueStates.' } } } };
export const GamesEmptyContract: Story = { ...GamesContract, args: { slug: 'games', contract: 'empty' } };
export const GamesStrangerContract: Story = { ...GamesContract, args: { slug: 'games', persona: 'stranger' } };
export const GamesMemberContract: Story = { ...GamesContract, args: { slug: 'games', persona: 'member' } };
export const GamesOwnerContract: Story = { ...GamesContract, args: { slug: 'games', persona: 'owner' } };
export const GamesModeratorContract: Story = { ...GamesContract, args: { slug: 'games', persona: 'moderator' } };
export const GamesOperatorContract: Story = { ...GamesContract, args: { slug: 'games', persona: 'operator' } };
export const GamesLaggingContract: Story = { ...GamesContract, args: { slug: 'games', contract: 'lagging' } };
export const GamesErrorContract: Story = { ...GamesContract, args: { slug: 'games', contract: 'error' } };
export const GamesLoadingContract: Story = { ...GamesContract, args: { slug: 'games', loading: true } };
export const GamesMovedContract: Story = { ...GamesContract, args: { slug: 'games', contract: 'moved' } };
export const GamesPhoneContract: Story = { ...GamesContract, globals: { viewport: { value: 'phone' } } };
export const MangaTraditionalChinese: Story = { args: { slug: 'manga', locale: 'zh-Hant' } };
export const MangaSimplifiedChinese: Story = { args: { slug: 'manga', locale: 'zh-Hans' } };
export const MangaJapanese: Story = { args: { slug: 'manga', locale: 'ja' } };
export const MangaKorean: Story = { args: { slug: 'manga', locale: 'ko' } };
export const MangaGerman: Story = { args: { slug: 'manga', locale: 'de' } };
export const MangaFrench: Story = { args: { slug: 'manga', locale: 'fr' } };
export const MangaSpanish: Story = { args: { slug: 'manga', locale: 'es' } };
