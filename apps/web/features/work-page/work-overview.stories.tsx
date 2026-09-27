import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import { AdoptionRegion } from './adoption.tsx';
import { AuthorSection } from './author.tsx';
import { ClassificationRegion } from './classification.tsx';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import { WorkRecord } from './record.tsx';
import { type WorkScope, workHref } from './route.ts';
import { ScopeBar, type ScopeRealm } from './scope-bar.tsx';
import type { AdoptionPage, AgentCreditPage, ClassificationPage, CreditPage, Loaded, RatingRead,
  WorkHeader } from './types.ts';
import { OverviewLayout, WorkFrame } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';

interface OverviewArgs {
  work: WorkHeader; agentCredits: Loaded<AgentCreditPage>; credits: Loaded<CreditPage>; scope: WorkScope | null;
  realms: ScopeRealm[];
  ratings: Loaded<RatingRead>; classifications: Loaded<ClassificationPage> | null; adoptions: Loaded<AdoptionPage>;
  locale: UiLocale; readerActions?: ReaderActions;
}

/** The Overview as the route composes it, with each region's Main answer given directly. */
function Overview({ work, agentCredits, credits, scope, realms, ratings, classifications, adoptions,
  locale, readerActions }: OverviewArgs) {
  const t = messages[locale];
  const view = scope ? fixture.scopeView(scope, realms) : null;
  const scopeBar = <ScopeBar workRef={fixture.workRef} scope={scope} realms={realms} locale={locale} messages={t} />;
  const author = agentCredits.ok ? agentCredits.data.items.find(credit => credit.role === 'author') : undefined;
  return <WorkFrame workRef={fixture.workRef} work={work} locale={locale} messages={t} readerActions={readerActions}
    signedIn={Boolean(readerActions)} signInHref={`/auth/start?next=%2F${locale}%2Fw%2F${fixture.workRef}`}
    credits={<WorkCredits agentCredits={agentCredits} credits={credits} locale={locale} messages={t} />}
    ratingLine={scope?.kind === 'global' ? <RatingLine ratings={ratings} locale={locale} messages={t} /> : null}>
    <OverviewLayout messages={t} about={<WorkAbout work={work} messages={t} />} scopeBar={scopeBar}
      ratings={view ? <RatingSummaryRegion ratings={ratings} view={view} scopeBar={scopeBar} locale={locale}
        messages={t} /> : null}
      classification={view ? <ClassificationRegion classifications={classifications} view={view} locale={locale}
        messages={t} /> : null}
      adoption={view ? <AdoptionRegion adoptions={adoptions} view={view} locale={locale} messages={t} /> : null}
      record={<WorkRecord work={work} locale={locale} messages={t}
        citation={`${work.title.value}. Maren Osei. REZICS. https://rezics.com/${locale}/w/${fixture.workRef}`} />}
      author={author ? <AuthorSection credit={author} works={fixture.agentWorks} work={work.id} locale={locale}
        messages={t} /> : null} />
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
    locale: 'en' },
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
    await expect(canvas.getByRole('link', { name: 'Read' })).toHaveAttribute('href', `/en/w/${fixture.workRef}/contents`);
    await expect(canvas.getByRole('link', { name: /Open Library author OL2162284A/ }))
      .toHaveAttribute('href', 'https://openlibrary.org/authors/OL2162284A');
    await expect(canvas.getAllByText('Maren Osei')[0]).toBeVisible();
    await expect(canvas.getByText(/Translated by/)).toHaveTextContent('Translated by 林晓');
    await expect(canvas.getAllByText('La Cartographe des marées')[0]).toHaveAttribute('lang', 'fr');
    await expect(canvas.getByText('Book · English')).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'About this Work' })).toHaveTextContent('A surveyor maps a delta');
    // The summary under the title leads down to the full ratings.
    await expect(canvas.getByRole('link', { name: '1,287 ratings' })).toHaveAttribute('href', '#work-ratings');
    // Signed out, the shelf and rating controls lead to sign-in, which returns here.
    await expect(canvas.getByRole('link', { name: /^Want to read/ }))
      .toHaveAttribute('href', `/auth/start?next=%2Fen%2Fw%2F${fixture.workRef}`);
    const ratings = canvas.getByRole('region', { name: 'Ratings' });
    const scope = within(ratings).getByRole('navigation', { name: 'Community' });
    await expect(within(scope).getByRole('link', { name: 'Everyone' })).toHaveAttribute('aria-current', 'true');
    await expect(ratings).toHaveTextContent('1,287 ratings');
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' }).children).toHaveLength(5);
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' })).toHaveTextContent('5 stars');
    await expect(within(ratings).getByRole('link', { name: 'How good is this Work overall?' }))
      .toHaveAttribute('aria-current', 'true');
    const genres = canvas.getByRole('region', { name: 'Genres' });
    const chips = within(genres).getAllByRole('listitem');
    // Recorded relevance orders the genres, most central first; unrecorded ones keep Main's order after them.
    await expect(chips.map(chip => chip.textContent)).toEqual(['Maritime fictionRelevance: Central',
      'AdventureRelevance: Substantial', 'Coming of ageRelevance: Incidental', 'Maps and cartography', '海洋']);
    await expect(within(genres).getByRole('link', { name: 'Adventure' }))
      .toHaveAttribute('href', expect.stringMatching(/^\/en\/discover\?term=[0-9a-f-]{36}$/));
    await expect(within(canvas.getByRole('region', { name: 'Communities' })).getByRole('link', { name: /Tidewater Readers/ }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}?scope=realm&realm=${fixture.realms[0]!.id}`);
    const author = canvas.getByRole('region', { name: 'About the author' });
    const more = within(author).getByRole('region', { name: 'More by Maren Osei' });
    // The Work itself is not offered again.
    await expect(within(more).getAllByRole('article')).toHaveLength(3);
    // Model detail is folded away until asked for.
    await expect(canvas.getByText(fixture.work.id)).not.toBeVisible();
    await userEvent.click(canvas.getByText('Details and identifiers'));
    await expect(canvas.getByText(fixture.work.id)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy citation' })).toBeVisible();
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
    const genres = canvas.getByRole('region', { name: 'Genres' });
    await expect(within(genres).getByRole('list', { name: 'Chosen in Tidewater Readers' })).toBeVisible();
    await expect(within(genres).getByRole('list', { name: 'Chosen by everyone' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Communities' })).toHaveTextContent('Showing');
    // The chosen scope travels with the tabs.
    await expect(canvas.getByRole('link', { name: 'Versions' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/versions?scope=realm&realm=${fixture.realms[0]!.id}`);
  },
};

export const MineSignedOut: Story = {
  args: { scope: fixture.mineScope, ratings: { ok: false, failure: 'sign-in' }, classifications: null },
  parameters: route(fixture.mineScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(`/en/w/${fixture.workRef}?scope=mine`)}`);
    await expect(canvas.getByRole('region', { name: 'Genres' })).toHaveTextContent('Genres aren’t personal');
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
    await expect(canvas.getByText('No genres yet')).toBeVisible();
    // Everyone's view offers the first community that features the Work, never silently switching to it.
    await expect(canvas.getAllByRole('link', { name: 'See Tidewater Readers' })).toHaveLength(2);
  },
};

export const EmptyRealm: Story = {
  args: { scope: fixture.realmScope, ratings: fixture.noRealmRatings, classifications: fixture.noClassifications },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No ratings in Tidewater Readers yet')).toBeVisible();
    await expect(canvas.getByText('Tidewater Readers hasn’t tagged this Work')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'See everyone' })[0]).toHaveAttribute('href', `/en/w/${fixture.workRef}`);
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
    await expect(within(canvas.getByRole('region', { name: 'Genres' })).getAllByRole('listitem')).toHaveLength(5);
  },
};

export const InvalidScope: Story = {
  args: { scope: null },
  parameters: { route: { pathname: `/en/w/${fixture.workRef}`, search: 'scope=everyone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This view isn’t available');
    await expect(canvas.queryByRole('region', { name: 'Ratings' })).toBeNull();
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
    await expect(canvas.getByText('No confirmed credits yet')).toBeVisible();
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

export const LongCjkTitle: Story = {
  args: { work: fixture.cjkWork, locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'zh-Hans');
    await expect(canvas.getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('region', { name: '评分' })).toHaveTextContent('1,287 个评分');
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
    await expect(canvas.getByRole('region', { name: '类型' })).toHaveTextContent('Tidewater Readers选定');
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
    await expect(canvas.getByRole('link', { name: /Open Library author OL2162284A/ })).toBeVisible();
  },
};
