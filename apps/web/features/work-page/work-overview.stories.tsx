import { conceptPath } from '../concept/state.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { direction, selectDisplayName } from '@rezics/main/language';
import { materializeData } from 'native-i18n';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import { AdoptionRegion } from './adoption.tsx';
import { AlsoEnjoyedSection } from './also-enjoyed.tsx';
import { AuthorSection, type WorkAuthor } from './author.tsx';
import { janeAusten } from '../author/fixtures.ts';
import { authorHref } from '../author/route.ts';
import { conceptFacet } from '../concept/fixtures.ts';
import { facetLabel } from '../concept/facets.ts';
import { ClassificationRegion, type CommunityGenres } from './classification.tsx';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { languageName } from './format.ts';
import { messages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import { WorkRecord } from './record.tsx';
import { chapterHref, type WorkScope, workHref } from './route.ts';
import { ScopeBar, type ScopeRealm } from './scope-bar.tsx';
import type { AdoptionPage, AgentCreditPage, AlsoEnjoyedPage, ClassificationPage, CreditPage, Loaded, RatingRead,
  WorkHeader, WorkStats } from './types.ts';
import type { ReadStart } from './read.ts';
import { hubLabels, hubSections } from './hub.ts';
import { OverviewLayout, ReadButton, WorkFrame } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';

interface OverviewArgs {
  work: WorkHeader; agentCredits: Loaded<AgentCreditPage>; credits: Loaded<CreditPage>; scope: WorkScope | null;
  realms: ScopeRealm[];
  ratings: Loaded<RatingRead>; classifications: Loaded<ClassificationPage> | null; adoptions: Loaded<AdoptionPage>;
  /** The header's reader numbers and the rows of Works to read next. */
  stats?: Loaded<WorkStats>; alsoEnjoyed?: Loaded<AlsoEnjoyedPage>;
  /** Concepts the Work's communities accepted, which everyone's view shows when everyone accepted none. */
  communities?: CommunityGenres[];
  locale: UiLocale; readerActions?: ReaderActions;
  authorOverride?: WorkAuthor;
  /** Where Read leads; the frame's Contents link when left out. */
  readAction?: ReadStart;
}

/** The Overview as the route composes it, with each region's Main answer given directly. */
function Overview({ work, agentCredits, credits, scope, realms, ratings, classifications, adoptions, stats,
  alsoEnjoyed, communities, locale, readerActions, readAction, authorOverride }: OverviewArgs) {
  const t = messages[locale];
  const view = scope ? fixture.scopeView(scope, realms) : null;
  const scopeBar = <ScopeBar workRef={fixture.workRef} scope={scope} realms={realms} locale={locale} messages={t} />;
  const author = agentCredits.ok ? agentCredits.data.items.find(credit => credit.role === 'author') : undefined;
  const authors = [...agentCredits.ok ? agentCredits.data.items.filter(credit => credit.role === 'author')
    .map(credit => ({ name: credit.displayName, href: authorHref({ kind: 'agent', handle: credit.handle }) })) : [],
  ...credits.ok ? credits.data.items.filter(credit => credit.role === 'author')
    .map(credit => ({ name: credit.displayName ?? credit.key,
      href: authorHref({ kind: 'external', key: credit.key }) })) : []];
  return <WorkFrame workRef={fixture.workRef} work={work} authors={authors} locale={locale} messages={t}
    readerActions={readerActions} sections={hubLabels(t, hubSections)}
    signedIn={Boolean(readerActions)} signInHref={`/auth/start?next=${encodeURIComponent(localizedPath(workHref(fixture.workRef), locale))}`}
    credits={<WorkCredits agentCredits={agentCredits} credits={credits} locale={locale} messages={t} />}
    ratingLine={scope?.kind === 'global' ? <RatingLine ratings={ratings} stats={stats} locale={locale} messages={t} />
      : null}
    readAction={readAction === undefined ? undefined
      : <ReadButton workRef={fixture.workRef} start={readAction} messages={t} />}>
    <OverviewLayout messages={t} plan={hubSections} about={<WorkAbout work={work} messages={t} />} scopeBar={scopeBar}
      ratings={view ? <RatingSummaryRegion ratings={ratings} view={view} scopeBar={scopeBar} locale={locale}
        messages={t} /> : null}
      classification={view ? <ClassificationRegion classifications={classifications} view={view}
        communities={communities} facet={{ id: conceptFacet.id, label: facetLabel(conceptFacet, locale) }}
        locale={locale} messages={t} /> : null}
      adoption={view ? <AdoptionRegion adoptions={adoptions} view={view} locale={locale} messages={t} /> : null}
      record={<WorkRecord work={work} locale={locale} messages={t}
        citation={`${work.title.value}. Maren Osei. REZICS. https://rezics.com${localizedPath(workHref(fixture.workRef), locale)}`} />}
      alsoEnjoyed={alsoEnjoyed ? <AlsoEnjoyedSection alsoEnjoyed={alsoEnjoyed} book realms={realms} locale={locale}
        messages={t} /> : null}
      author={authorOverride ? <AuthorSection author={authorOverride} work={fixture.workRef} locale={locale}
        messages={t} /> : author ? <AuthorSection author={{ kind: 'agent', name: author.displayName,
        handle: author.handle, works: fixture.agentWorks }} work={fixture.workRef} locale={locale} messages={t} /> : null} />
  </WorkFrame>;
}

const route = (scope: WorkScope | null = fixture.globalScope) => {
  const [pathname, search = ''] = workHref(fixture.workRef, 'overview', scope).split('?');
  return { route: { pathname: pathname!, search } };
};

const meta = {
  title: 'Work page/Overview',
  component: Overview,
  args: { work: fixture.work, agentCredits: fixture.agentCredits, credits: fixture.credits, scope: fixture.globalScope, realms: fixture.realms,
    ratings: fixture.globalRatings, classifications: fixture.globalClassifications, adoptions: fixture.adoptions,
    stats: fixture.workStats, alsoEnjoyed: fixture.alsoEnjoyed(fixture.coReaderPicks), locale: 'en' },
  parameters: route(),
} satisfies Meta<typeof Overview>;
export default meta;
type Story = StoryObj<typeof meta>;

const noOverflow = async () => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

export const Global: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'The Cartographer of Tides' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('link', { name: 'Read' })).toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'contents'), 'en'));
    // Authors by name: a native author opens their profile, a source author the source's page.
    const byline = canvas.getByRole('heading', { level: 1 }).parentElement!;
    await expect(within(byline).getByRole('link', { name: 'Maren Osei' })).toHaveAttribute('href', localizedPath(authorHref({ kind: 'agent', handle: 'maren' }), 'en'));
    await expect(within(byline).getByRole('link', { name: /^Idris Vale/ }))
      .toHaveAttribute('href', '/en/authors/open-library/OL2162284A');
    await expect(within(byline).getByRole('link', { name: /Open Library author OL7654321A/ })).toBeVisible();
    await expect(canvas.getByText(/Translated by/)).toHaveTextContent('Translated by 林晓');
    await expect(canvas.getAllByText('La Cartographe des marées')[0]).toHaveAttribute('lang', 'fr');
    await expect(canvas.getByText('Book · English')).toBeVisible();
    // A serial's state at a glance: status, length and last update.
    const stats = within(byline).getByText('Chapters').closest('dl')!;
    // Terms precede their values for assistive technology; the value shows first on screen.
    await expect(stats).toHaveTextContent(/Status\s*Completed/);
    await expect(stats).toHaveTextContent(/Chapters\s*24/);
    await expect(stats).toHaveTextContent(/Words\s*86\.4K/);
    await expect(stats).toHaveTextContent('Updated');
    await expect(canvas.getByText('A novel of rivers, maps and the stories a city tells about itself.')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'About this Work' })).toHaveTextContent('A surveyor maps a delta');
    // The numbers under the title, as Goodreads gives them: ratings and reviews lead down to their sections.
    await expect(canvas.getByRole('link', { name: '1,287 ratings' })).toHaveAttribute('href', '#work-ratings');
    await expect(within(byline).getByRole('link', { name: '214 reviews' })).toHaveAttribute('href', '#work-reviews');
    await expect(within(byline).getByText('38 people are currently reading')).toBeVisible();
    // Signed out, the shelf and rating controls lead to sign-in, which returns here.
    await expect(canvas.getByRole('link', { name: /^Want to read/ }))
      .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(localizedPath(workHref(fixture.workRef), 'en'))}`);
    const ratings = canvas.getByRole('region', { name: 'Ratings' });
    const scope = within(ratings).getByRole('navigation', { name: 'Community' });
    await expect(within(scope).getByRole('link', { name: 'Everyone' })).toHaveAttribute('aria-current', 'true');
    await expect(ratings).toHaveTextContent('1,287 ratings');
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' }).children).toHaveLength(5);
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' })).toHaveTextContent('5 stars');
    await expect(within(ratings).getByRole('link', { name: 'How good is this Work overall?' }))
      .toHaveAttribute('aria-current', 'true');
    // Accepted Concepts are grouped by the Facet they are read through, labelled as Main names it.
    const values = canvas.getByRole('region', { name: 'Classification' });
    await expect(within(values).getByRole('term')).toHaveTextContent('Tags');
    const chips = within(within(values).getByRole('list', { name: 'Tags' })).getAllByRole('listitem');
    // Recorded relevance orders the values, most central first; unrecorded ones keep Main's order after them.
    await expect(chips.map(chip => chip.textContent)).toEqual(['Maritime fictionRelevance: Central',
      'AdventureRelevance: Substantial', 'Coming of ageRelevance: Incidental', 'Maps and cartography', '海洋']);
    // Each opens its Concept's page.
    await expect(within(values).getByRole('link', { name: 'Adventure' }))
      .toHaveAttribute('href', expect.stringMatching(/^\/en\/concepts\/[0-9a-f-]{36}$/));
    // Lists and discovery come after ratings and reviews, as the Work page documents.
    const regions = canvas.getAllByRole('region').map(region => region.getAttribute('aria-labelledby'));
    await expect(regions.indexOf('work-also-co-readers')).toBeGreaterThan(regions.indexOf('work-ratings'));
    await expect(regions.indexOf('work-ratings')).toBeLessThan(regions.indexOf('work-adoption'));
    await expect(within(canvas.getByRole('region', { name: 'Readers also enjoyed' })).getAllByRole('article'))
      .toHaveLength(9);
    await expect(within(canvas.getByRole('region', { name: 'Communities' })).getByRole('link', { name: /Tidewater Readers/ }))
      .toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'overview', { kind: 'realm', realm: fixture.realms[0]!.id }), 'en'));
    const author = canvas.getByRole('region', { name: 'About the author' });
    await expect(within(author).getAllByRole('link', { name: /Maren Osei/ })[0])
      .toHaveAttribute('href', localizedPath(authorHref({ kind: 'agent', handle: 'maren' }), 'en'));
    const more = within(author).getByRole('region', { name: 'More by Maren Osei' });
    // The Work itself is not offered again.
    await expect(within(more).getAllByRole('article')).toHaveLength(3);
    // Details say what the Work is in plain words; identifiers wait one step further in, under Cite.
    await expect(canvas.getByText(fixture.work.id)).not.toBeVisible();
    await userEvent.click(canvas.getByText('Details', { exact: true }));
    await expect(canvas.getByText('Added to REZICS')).toBeVisible();
    await expect(canvas.getByText('Mar 4, 2026')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy citation' })).toBeVisible();
    await expect(canvas.getByText(fixture.work.id)).not.toBeVisible();
    await userEvent.click(canvas.getByText('Identifiers'));
    await expect(canvas.getByText(fixture.work.id)).toBeVisible();
    await expect(canvas.queryByText(/Main Version/)).toBeNull();
  },
};

export const ExternalAuthor: Story = {
  args: { agentCredits: fixture.noAgentCredits,
    authorOverride: { kind: 'external', key: janeAusten.key, name: 'Jane Austen', years: '1775–1817',
      works: fixture.ok({ ...janeAusten.works, sourcePosition: janeAusten.sourcePosition,
        count: { value: janeAusten.works.items.length, kind: 'exact-page', total: null } }) } },
  async play({ canvasElement }) {
    const author = within(canvasElement).getByRole('region', { name: 'About the author' });
    await expect(within(author).getAllByRole('link', { name: /Jane Austen/ })[0])
      .toHaveAttribute('href', '/en/authors/open-library/OL21594A');
    await expect(author).toHaveTextContent('1775–1817');
    await expect(within(author).getByRole('region', { name: 'More by Jane Austen' }))
      .toHaveTextContent('Pride and Prejudice');
    await noOverflow();
  },
};

/** Signed in with Main's reader state (G-285): shelve and rate from under the cover. */
export const SignedInActions: Story = {
  args: { readerActions: memoryReaderActions() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'More shelves' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Currently reading' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: /^Currently reading — Shelve/ })).toBeVisible());
    await userEvent.click(canvas.getAllByRole('radio')[4]!);
    await waitFor(() => expect(canvas.getByText('Your rating')).toBeVisible());
  },
};

export const Realm: Story = {
  args: { scope: fixture.realmScope, ratings: fixture.realmRatings, classifications: fixture.realmClassifications },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const ratings = canvas.getByRole('region', { name: 'Ratings' });
    const scope = within(ratings).getByRole('navigation', { name: 'Community' });
    await expect(within(scope).getByRole('link', { name: 'Community: Tidewater Readers' }))
      .toHaveAttribute('aria-current', 'true');
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' }).children).toHaveLength(10);
    const values = canvas.getByRole('region', { name: 'Classification' });
    const local = within(values).getByRole('list', { name: 'Accepted in Tidewater Readers' });
    await expect(within(values).getByRole('list', { name: 'Accepted by everyone' })).toBeVisible();
    // In a community, every value opens its Concept page in that community.
    if (!fixture.realmClassifications.ok) throw new Error('Expected classification fixture');
    await expect(within(local).getByRole('link', { name: 'Estuary cycle' })).toHaveAttribute('href',
      localizedPath(conceptPath(fixture.realmClassifications.data.items[0]!.concept,
        { kind: 'realm', realm: fixture.realms[0]!.id }), 'en'));
    await expect(canvas.getByRole('region', { name: 'Communities' })).toHaveTextContent('Showing');
    // The chosen scope travels with the tabs.
    await expect(canvas.getByRole('link', { name: 'Versions' }))
      .toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'versions', { kind: 'realm', realm: fixture.realms[0]!.id }), 'en'));
  },
};

export const MineSignedOut: Story = {
  args: { scope: fixture.mineScope, ratings: { ok: false, failure: 'sign-in' }, classifications: null },
  parameters: route(fixture.mineScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(localizedPath(workHref(fixture.workRef, 'overview', { kind: 'mine' }), 'en'))}`);
    await expect(canvas.getByRole('region', { name: 'Classification' })).toHaveTextContent('Classification isn’t personal');
    await expect(canvas.getByRole('link', { name: 'See everyone' })).toBeVisible();
  },
};

export const MineChooseIdentity: Story = {
  args: { scope: fixture.mineScope, ratings: { ok: false, failure: 'identity' }, classifications: null },
  parameters: route(fixture.mineScope),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Choose identity' }))
      .toHaveAttribute('href', expect.stringMatching(/^\/en\/identity\?next=/));
  },
};

export const MineRated: Story = {
  args: { scope: fixture.mineScope, ratings: fixture.mineRating, classifications: null },
  parameters: route(fixture.mineScope),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: 'Ratings' }))
      .toHaveTextContent('You rated this 4 out of 5');
  },
};

export const EmptyGlobal: Story = {
  args: { ratings: fixture.noGlobalRatings, classifications: fixture.noClassifications },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole('region', { name: 'Ratings' })).getByText('No ratings yet')).toBeVisible();
    // Everyone's view with nothing classified leaves the section out rather than lead with an empty box.
    await expect(canvas.queryByRole('region', { name: 'Classification' })).toBeNull();
    // Everyone's view offers the first community that features the Work, never silently switching to it.
    await expect(canvas.getAllByRole('link', { name: 'See Tidewater Readers' })).toHaveLength(1);
  },
};

/** Nobody classified the Work for everyone, but its communities did: their Concepts show, each named, opening their page there. */
export const CommunityGenresOnly: Story = {
  args: { classifications: fixture.noClassifications, communities: fixture.communityGenres },
  async play({ canvasElement }) {
    const values = within(canvasElement).getByRole('region', { name: 'Classification' });
    const tidewater = within(values).getByRole('list', { name: 'Accepted in Tidewater Readers' });
    await expect(within(tidewater).getAllByRole('listitem').map(item => item.textContent))
      .toEqual(['Book club pick 2026Relevance: Central', 'Estuary cycle']);
    await expect(within(tidewater).getByRole('link', { name: 'Estuary cycle' })).toHaveAttribute('href',
      localizedPath(conceptPath(fixture.communityGenres[0]!.items[0]!.concept, { kind: 'realm', realm: fixture.realms[0]!.id }), 'en'));
    await expect(within(values).getByRole('list', { name: 'Accepted in 海洋文学研究会' })).toHaveTextContent('海洋文学');
  },
};

/** Past what Main counts, the numbers say "at least"; nobody reading now is no line at all. */
export const ReaderNumbers: Story = {
  args: { stats: fixture.busyWorkStats },
  async play({ canvasElement }) {
    const byline = within(canvasElement).getByRole('heading', { level: 1 }).parentElement!;
    await expect(within(byline).getByRole('link', { name: '10,000+ reviews' })).toBeVisible();
    await expect(within(byline).getByText('10,000+ people are currently reading')).toBeVisible();
  },
};

export const NoRatingsYetReaders: Story = {
  args: { ratings: fixture.noGlobalRatings, stats: fixture.workStats },
  async play({ canvasElement }) {
    const byline = within(canvasElement).getByRole('heading', { level: 1 }).parentElement!;
    await expect(within(byline).getByText('No ratings yet')).toBeVisible();
    await expect(within(byline).getByText('38 people are currently reading')).toBeVisible();
  },
};

export const QuietReaderNumbers: Story = {
  args: { stats: fixture.quietWorkStats },
  async play({ canvasElement }) {
    const byline = within(canvasElement).getByRole('heading', { level: 1 }).parentElement!;
    await expect(within(byline).getByText('1,287 ratings')).toBeVisible();
    await expect(within(byline).queryByText(/review|reading/)).toBeNull();
  },
};

export const EmptyRealm: Story = {
  args: { scope: fixture.realmScope, ratings: fixture.noRealmRatings, classifications: fixture.noClassifications },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No ratings in Tidewater Readers yet')).toBeVisible();
    await expect(canvas.getByText('Tidewater Readers hasn’t classified this Work')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'See everyone' })[0]).toHaveAttribute('href', localizedPath(workHref(fixture.workRef), 'en'));
  },
};

export const NoRatingQuestion: Story = {
  args: { ratings: fixture.noQuestion },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Ratings aren’t open for this Work yet')).toBeVisible();
  },
};

export const PartialFailure: Story = {
  args: { agentCredits: { ok: false, failure: 'unavailable' }, credits: { ok: false, failure: 'unavailable' },
    ratings: { ok: false, failure: 'unavailable' },
    adoptions: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const alerts = canvas.getAllByRole('alert');
    await expect(alerts.map(alert => alert.textContent)).toEqual([
      expect.stringContaining('Credits unavailable'), expect.stringContaining('Ratings unavailable'),
      expect.stringContaining('Communities unavailable')]);
    await expect(canvas.getAllByRole('button', { name: 'Retry' })).toHaveLength(3);
    // The regions that loaded are unaffected.
    await expect(within(canvas.getByRole('region', { name: 'Classification' })).getAllByRole('listitem')).toHaveLength(5);
  },
};

export const InvalidScope: Story = {
  args: { scope: null },
  parameters: { route: { pathname: localizedPath(workHref(fixture.workRef), 'en'), search: 'scope=everyone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This view isn’t available');
    await expect(canvas.queryByRole('region', { name: 'Ratings' })).toBeNull();
    // Works to read next don't depend on the scope.
    await expect(canvas.getByRole('region', { name: 'Readers also enjoyed' })).toBeVisible();
    for (const link of within(canvas.getByRole('navigation', { name: 'Community' })).getAllByRole('link')) {
      await expect(link).not.toHaveAttribute('aria-current');
    }
  },
};

export const MetadataOnly: Story = {
  args: { work: fixture.metadataOnlyWork, agentCredits: fixture.noAgentCredits, credits: fixture.noCredits, realms: [],
    ratings: fixture.noQuestion,
    classifications: fixture.noClassifications, adoptions: fixture.noAdoptions },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Private')).toBeVisible();
    // No credit is no line at all, not a sentence about credits.
    await expect(canvas.queryByText(/credit/i)).toBeNull();
    await expect(canvas.getByText('No community features this Work yet', { exact: true })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'About the author' })).toBeNull();
  },
};

export const TitleFallback: Story = {
  args: { work: fixture.fallbackTitleWork, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/尚无.*标题，以英语显示/)).toBeVisible();
  },
};

export const G504OtherScriptTitle: Story = {
  args: { work: { ...fixture.work, title: selectDisplayName(
    { original: 'zh-Hans', labels: { 'zh-Hans': '雨夜书店' } }, ['zh-Hant'])!,
    originalTitle: null, tagline: null, description: null, selectedLanguage: null }, locale: 'zh-Hant' },
  globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: '雨夜书店' })).toHaveAttribute('lang', 'zh-Hans');
    const t = materializeData(messages['zh-Hant'], { locale: 'zh-Hant' });
    await expect(canvas.getByText(t.titleFallback({ requested: languageName('zh-Hant', 'zh-Hant'),
      shown: languageName('zh-Hans', 'zh-Hant') }))).toBeVisible();
    await noOverflow();
  },
};

export const G504UndeterminedRtlTitle: Story = {
  args: { work: { ...fixture.work, title: selectDisplayName(new Map([['und', '١٢٣ … مكتبة ليلة المطر']]))!,
    originalTitle: null, tagline: null, description: null, selectedLanguage: null } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const title = canvas.getByRole('heading', { level: 1 });
    await expect(title).toHaveAttribute('lang', 'und');
    await expect(title).toHaveAttribute('dir', 'rtl');
    await expect(canvas.queryByText(/No .* title yet/)).toBeNull();
    await noOverflow();
  },
};

/** G-516: a Japanese title in a Korean interface, with a Hebrew author and an Arabic translator in the credits. */
export const G516NonLatinNames: Story = {
  args: { work: { ...fixture.work, title: { value: '吾輩は猫である', language: 'ja', direction: direction('ja', '吾輩は猫である'), basis: 'fallback' },
    originalTitle: { value: 'مكتبة الأدب', language: 'ar', direction: direction('ar', 'مكتبة الأدب') },
    tagline: null, description: null, selectedLanguage: null },
  agentCredits: fixture.agentCredits.ok ? fixture.ok({ ...fixture.agentCredits.data,
    items: fixture.agentCredits.data.items.map((credit, index) =>
      ({ ...credit, displayName: index ? 'ليلى' : 'עמוס עוז' })) }) : fixture.agentCredits,
  credits: fixture.noCredits, locale: 'ko' },
  globals: { locale: 'ko' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'ja');
    const author = canvas.getAllByText('עמוס עוז').find(node => node.tagName === 'BDI')!;
    await expect(author).toBeVisible();
    await expect(author).toHaveAttribute('dir', 'rtl');
    await expect(author).toHaveAttribute('lang', '');
    const original = canvas.getAllByText('مكتبة الأدب').find(node => node.tagName === 'BDI')!;
    await expect(original).toHaveAttribute('lang', 'ar');
    await expect(original).toHaveAttribute('dir', 'rtl');
    await noOverflow();
  },
};

/** A Chinese title an older record tags as English reads as Chinese already; no "shown in English" note. */
export const TitleAlreadyInReadersLanguage: Story = {
  args: { work: fixture.mislabeledTitleWork, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1 })).toHaveTextContent('雨夜书店');
    await expect(within(canvasElement).queryByText(/以英语显示/)).toBeNull();
  },
};

/** A reader part-way through continues at the next unread chapter, which is named under the button. */
export const ContinueReading: Story = {
  args: { readAction: { kind: 'continue', href: chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000004'),
    chapter: 'Chapter 4: Neap Tide' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Continue reading' }))
      .toHaveAttribute('href', localizedPath(chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000004'), 'en'));
    await expect(canvas.getByText('Chapter 4: Neap Tide')).toBeVisible();
  },
};

/** Anyone else starts at chapter 1; a Work with nothing to read has no Read button. */
export const StartReading: Story = {
  args: { readAction: { kind: 'start', href: chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000002'),
    chapter: 'Low Water' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Start reading' }))
      .toHaveAttribute('href', localizedPath(chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000002'), 'en'));
  },
};

export const NothingToRead: Story = {
  args: { readAction: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('link', { name: /^(Read|Start reading)$/ })).toBeNull();
  },
};

export const LongCjkTitle: Story = {
  args: { work: fixture.cjkWork, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'zh-Hans');
    // Tabs give way to "On this page" on a phone.
    await expect(canvas.getByRole('button', { name: '本页内容' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: '概览' })).toBeNull();
    await expect(canvas.getByRole('region', { name: '评分' })).toHaveTextContent('1,287 个评分');
    await expect(canvas.getByRole('link', { name: '214 篇书评' })).toHaveAttribute('href', '#work-reviews');
    await expect(canvas.getByText('38 人正在读')).toBeVisible();
    await expect(canvas.getByRole('region', { name: '读过的人也喜欢' })).toBeVisible();
    await noOverflow();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', scope: fixture.realmScope, ratings: fixture.realmRatings,
    classifications: fixture.realmClassifications },
  globals: { locale: 'zh-Hans' },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(within(canvas.getByRole('navigation', { name: '社区' })).getByRole('link', { name: '社区: Tidewater Readers' }))
      .toHaveAttribute('aria-current', 'true');
    await expect(canvas.getByRole('region', { name: '分类' })).toHaveTextContent('Tidewater Readers接受');
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  play: noOverflow,
};

export const PhoneDarkRealm: Story = {
  args: { scope: fixture.realmScope, ratings: fixture.realmRatings, classifications: fixture.realmClassifications },
  parameters: route(fixture.realmScope),
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  play: noOverflow,
};

export const SomeCreditsUnavailable: Story = {
  args: { agentCredits: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Some credits could not load.');
    const byline = canvas.getByRole('heading', { level: 1 }).parentElement!;
    await expect(within(byline).getByRole('link', { name: /^Idris Vale/ })).toBeVisible();
  },
};
