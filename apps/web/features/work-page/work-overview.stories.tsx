import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { AdoptionRegion } from './adoption.tsx';
import { ClassificationRegion } from './classification.tsx';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { RatingSummaryRegion } from './ratings.tsx';
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
  locale: UiLocale;
}

/** The Overview as the route composes it, with each region's Main answer given directly. */
function Overview({ work, agentCredits, credits, scope, realms, ratings, classifications, adoptions,
  locale }: OverviewArgs) {
  const t = messages[locale];
  const view = scope ? fixture.scopeView(scope, realms) : null;
  return <WorkFrame workRef={fixture.workRef} work={work} locale={locale} messages={t}
    credits={<WorkCredits agentCredits={agentCredits} credits={credits} locale={locale} messages={t} />}>
    <OverviewLayout messages={t} about={<WorkAbout work={work} messages={t} />}
      scopeBar={<ScopeBar workRef={fixture.workRef} scope={scope} realms={realms} locale={locale} messages={t} />}
      ratings={view ? <RatingSummaryRegion ratings={ratings} view={view} locale={locale} messages={t} /> : null}
      classification={view ? <ClassificationRegion classifications={classifications} view={view} locale={locale}
        messages={t} /> : null}
      adoption={view ? <AdoptionRegion adoptions={adoptions} view={view} locale={locale} messages={t} /> : null}
      record={<WorkRecord work={work} locale={locale} messages={t} />} />
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
    await expect(canvas.getByRole('link', { name: 'Read' })).toHaveAttribute('href', `/w/${fixture.workRef}/contents`);
    await expect(canvas.getByRole('link', { name: /Open Library author OL2162284A/ }))
      .toHaveAttribute('href', 'https://openlibrary.org/authors/OL2162284A');
    await expect(canvas.getByText('Maren Osei')).toBeVisible();
    await expect(canvas.getByText('Translator')).toBeVisible();
    await expect(canvas.getByText('La Cartographe des marées')).toHaveAttribute('lang', 'fr');
    await expect(canvas.getByRole('region', { name: 'About this Work' })).toHaveTextContent('A surveyor maps a delta');
    const scope = canvas.getByRole('navigation', { name: 'Scope' });
    await expect(within(scope).getByRole('link', { name: 'Global' })).toHaveAttribute('aria-current', 'true');
    await expect(scope).toHaveTextContent('Showing ratings and classification from everyone on REZICS.');
    const ratings = canvas.getByRole('region', { name: 'Ratings' });
    await expect(ratings).toHaveTextContent('1,287 ratings');
    await expect(ratings).toHaveTextContent('How good is this Work overall?');
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' }).children).toHaveLength(5);
    await expect(within(ratings).getByRole('link', { name: 'How good is this Work overall?' }))
      .toHaveAttribute('aria-current', 'true');
    const chips = within(canvas.getByRole('region', { name: 'Classification' })).getAllByRole('listitem');
    // Recorded relevance orders the chips, most central first; unrecorded ones keep Main's order after them.
    await expect(chips.map(chip => chip.textContent)).toEqual(['Maritime fictionRelevance: Central',
      'AdventureRelevance: Substantial', 'Coming of ageRelevance: Incidental', 'Maps and cartography', '海洋']);
    await expect(within(canvas.getByRole('region', { name: 'Realm adoption' })).getByRole('link', { name: /Tidewater Readers/ }))
      .toHaveAttribute('href', `/w/${fixture.workRef}?scope=realm&realm=${fixture.realms[0]!.id}`);
  },
};

export const Realm: Story = {
  args: { scope: fixture.realmScope, ratings: fixture.realmRatings, classifications: fixture.realmClassifications },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const scope = canvas.getByRole('navigation', { name: 'Scope' });
    await expect(within(scope).getByRole('link', { name: 'Realm: Tidewater Readers' })).toHaveAttribute('aria-current', 'true');
    const ratings = canvas.getByRole('region', { name: 'Ratings' });
    await expect(within(ratings).getByRole('list', { name: 'Rating distribution' }).children).toHaveLength(10);
    await expect(ratings).toHaveTextContent('Scale 1–10');
    const classification = canvas.getByRole('region', { name: 'Classification' });
    await expect(within(classification).getByRole('list', { name: 'Decided in Tidewater Readers' })).toBeVisible();
    await expect(within(classification).getByRole('list', { name: 'From Global' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'Realm adoption' })).toHaveTextContent('In scope');
    // The chosen scope travels with the tabs.
    await expect(canvas.getByRole('link', { name: 'Versions' }))
      .toHaveAttribute('href', `/w/${fixture.workRef}/versions?scope=realm&realm=${fixture.realms[0]!.id}`);
  },
};

export const MineSignedOut: Story = {
  args: { scope: fixture.mineScope, ratings: { ok: false, failure: 'sign-in' }, classifications: null },
  parameters: route(fixture.mineScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', `/sign-in?next=${encodeURIComponent(`/w/${fixture.workRef}?scope=mine`)}`);
    await expect(canvas.getByRole('region', { name: 'Classification' })).toHaveTextContent('Classification isn’t personal');
    await expect(canvas.getByRole('link', { name: 'See Global' })).toBeVisible();
  },
};

export const MineChooseIdentity: Story = {
  args: { scope: fixture.mineScope, ratings: { ok: false, failure: 'identity' }, classifications: null },
  parameters: route(fixture.mineScope),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Choose identity' }))
      .toHaveAttribute('href', expect.stringMatching(/^\/identity\?next=/));
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
    await expect(canvas.getByText('No Global ratings yet')).toBeVisible();
    await expect(canvas.getByText('No Global classification yet')).toBeVisible();
    // Global offers the first Realm that adopted the Work, never silently switching to it.
    await expect(canvas.getAllByRole('link', { name: 'See Tidewater Readers' })).toHaveLength(2);
  },
};

export const EmptyRealm: Story = {
  args: { scope: fixture.realmScope, ratings: fixture.noRealmRatings, classifications: fixture.noClassifications },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No ratings in Tidewater Readers yet')).toBeVisible();
    await expect(canvas.getByText('Tidewater Readers hasn’t classified this Work')).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'See Global' })[0]).toHaveAttribute('href', `/w/${fixture.workRef}`);
  },
};

export const NoRatingQuestion: Story = {
  args: { ratings: fixture.noQuestion },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Global has no rating question for this Work')).toBeVisible();
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
      expect.stringContaining('Realm adoption unavailable')]);
    await expect(canvas.getAllByRole('button', { name: 'Retry' })).toHaveLength(3);
    // The regions that loaded are unaffected.
    await expect(within(canvas.getByRole('region', { name: 'Classification' })).getAllByRole('listitem')).toHaveLength(5);
  },
};

export const InvalidScope: Story = {
  args: { scope: null },
  parameters: { route: { pathname: `/w/${fixture.workRef}`, search: 'scope=everyone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This scope isn’t available');
    await expect(canvas.queryByRole('region', { name: 'Ratings' })).toBeNull();
    for (const link of within(canvas.getByRole('navigation', { name: 'Scope' })).getAllByRole('link')) {
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
    await expect(canvas.getByText('No Realm has adopted this Work yet', { exact: true })).toBeVisible();
    await expect(canvas.getByRole('navigation', { name: 'Scope' })).toHaveTextContent('No Realm has adopted this Work yet.');
  },
};

export const TitleFallback: Story = {
  args: { work: fixture.fallbackTitleWork, locale: 'zh-CN' },
  globals: { locale: 'zh-CN' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/尚无.*标题，以英语显示/)).toBeVisible();
  },
};

export const LongCjkTitle: Story = {
  args: { work: fixture.cjkWork, locale: 'zh-CN' },
  globals: { locale: 'zh-CN', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'zh-Hans');
    await expect(canvas.getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('region', { name: '评分' })).toHaveTextContent('1,287 个评分');
    await noOverflow();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-CN', scope: fixture.realmScope, ratings: fixture.realmRatings,
    classifications: fixture.realmClassifications },
  globals: { locale: 'zh-CN' },
  parameters: route(fixture.realmScope),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: '范围' })).toHaveTextContent('显示在Tidewater Readers中决定的评分和分类。');
    await expect(canvas.getByRole('region', { name: '分类' })).toHaveTextContent('由Tidewater Readers决定');
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
