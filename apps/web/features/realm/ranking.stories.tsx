import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { catalogs } from '../../i18n/catalogs.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { memoryFeed } from '../feed/fixtures.ts';
import type { FeedMessages } from '../feed/messages.ts';
import type { ThreadsPage } from '../feed/thread.ts';
import type { Loaded } from '../feed/types.ts';
import { communityZone } from '../zones/fixtures.ts';
import { rankingContractFetch, rankingContractState, rankingNow, rankingStateSource, type RankingState } from './ranking-contract-states.ts';
import { rankingHref, RankingSkeleton, RealmRankingPage } from './ranking-page.tsx';
import { readRankingAnswer } from './ranking-read.ts';
import { RealmPageStory } from './story-page.tsx';
import { DiscussionColumns } from './thread-rail.tsx';

const path = '/r/ranking-garden';
interface Args {
  persona: AnswerPersona; state: RankingState; privateRealm: boolean;
  sort: 'best' | 'top'; window: 'week' | 'month' | 'all'; locale: UiLocale;
}

/** Constructed contract answers go through Eden and the production page boundary. Capture nothing in this wave. */
function RankingStory(args: Args) {
  const [loaded, setLoaded] = useState<{ page: Loaded<ThreadsPage>; feed: FeedMessages } | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    const sample = rankingContractState(args);
    const transport = rankingContractFetch(sample);
    const main = browserMainApi('https://contract.invalid', { fetcher: transport.fetcher, anonymous: args.persona === 'visitor' });
    void Promise.all([readRankingAnswer(main, sample.request), catalogs.feed[args.locale]()]).then(([page, feed]) => {
      if (active) setLoaded({ page, feed });
    });
    return () => { active = false; transport.dispose(); };
  }, [args.persona, args.state, args.privateRealm, args.sort, args.window, args.locale]);
  const request = rankingContractState(args).request;
  return <RealmPageStory zone={communityZone(args.locale)} locale={args.locale}>
    <DiscussionColumns rail={null}>
      {loaded ? <FeedProvider locale={args.locale} messages={loaded.feed} now={rankingNow}
        signedIn={args.persona !== 'visitor'} actingSubject={request.actingSubject} signInHref="/auth/start"
        avatarQuery="" tab="all" followedRealms={null} api={memoryFeed()}>
        <RealmRankingPage page={loaded.page} path={path} sort={args.sort} window={args.window}
          cursor={request.cursor} locale={args.locale} feed={loaded.feed} />
      </FeedProvider> : <RankingSkeleton />}
    </DiscussionColumns>
  </RealmPageStory>;
}

const meta = {
  title: 'Realm/Ranking contract states', component: RankingStory,
  args: { persona: 'visitor', state: 'populated', privateRealm: false, sort: 'best', window: 'all', locale: 'en' },
  globals: { viewport: { value: 'desktop' } },
  parameters: { route: { pathname: '/en/r/ranking-garden/discussions' },
    docs: { description: { component: rankingStateSource + '. Exact requests and expected states are in ranking-contract-states.ts. Neither ranking read declares HTTP 202.' } } },
  render: (args, { globals }) => <RankingStory {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof RankingStory>;
export default meta;
type Story = StoryObj<typeof meta>;

const populated: Story = {
  async play({ canvasElement, args, globals }) {
    const canvas = within(canvasElement);
    const sample = rankingContractState(args);
    if (!('items' in sample.answer)) throw new Error('Expected a populated contract state');
    await expect(canvas.findByRole('article', { name: sample.answer.items[0]!.title })).resolves.toBeVisible();
    await expect(canvas.getAllByRole('article')).toHaveLength(sample.answer.items.length);
    await expect(canvas.getAllByRole('link', { name: 'Ranking garden author' })).toHaveLength(sample.answer.items.length);
    if (sample.answer.nextCursor) {
      const locale = (globals.locale as UiLocale | undefined) ?? args.locale;
      const href = localizedPath(rankingHref(path, args.sort, args.window, sample.answer.nextCursor), locale);
      await expect(canvasElement.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
  },
};
const missing: Story = {
  args: { state: 'missing' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('status')).resolves.toBeVisible();
    await expect(canvas.queryByRole('article')).toBeNull();
    await expect(canvas.queryByText(/closed Realm/i)).toBeNull();
  },
};
const refusal: Story = {
  args: { state: 'invalid-cursor' },
  async play({ canvasElement, args, globals }) {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('alert')).resolves.toBeVisible();
    const locale = (globals.locale as UiLocale | undefined) ?? args.locale;
    await expect(canvasElement.querySelector(`a[href="${localizedPath(rankingHref(path, args.sort, args.window), locale)}"]`)).not.toBeNull();
    await expect(canvas.queryByRole('article')).toBeNull();
  },
};
function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { ...story.globals, viewport: { value: viewport } } };
}

export const VisitorDesktop: Story = populated;
export const VisitorPhone: Story = at(populated, 'phone');
export const ContinuationDesktop: Story = { ...populated, args: { state: 'continuation', sort: 'top', window: 'month' } };
export const ContinuationPhone: Story = at(ContinuationDesktop, 'phone');
export const TopWeek: Story = { ...populated, args: { sort: 'top', window: 'week' } };
export const TopAll: Story = { ...populated, args: { sort: 'top', window: 'all' } };
export const EmptyDesktop: Story = { args: { state: 'empty', sort: 'top', window: 'month' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('heading', { name: 'No discussions in this period' })).resolves.toBeVisible(); } };
export const EmptyPhone: Story = at(EmptyDesktop, 'phone');
export const ErrorDesktop: Story = { args: { state: 'error' },
  async play({ canvasElement }) { await expect(within(canvasElement).findByRole('alert')).resolves.toBeVisible(); } };
export const ErrorPhone: Story = at(ErrorDesktop, 'phone');
export const CursorRefusalDesktop: Story = refusal;
export const CursorRefusalPhone: Story = at(refusal, 'phone');
export const MovedContinuation: Story = { ...refusal, args: { state: 'moved' } };
export const LoadingDesktop: Story = { args: { state: 'loading' },
  async play({ canvasElement }) { await expect(canvasElement.querySelector('[aria-busy="true"]')).not.toBeNull(); } };
export const LoadingPhone: Story = at(LoadingDesktop, 'phone');

export const StrangerPublic: Story = { ...populated, args: { persona: 'stranger' } };

export const MemberPublic: Story = { ...populated, args: { persona: 'member' } };

export const OwnerPublic: Story = { ...populated, args: { persona: 'owner' } };

export const ModeratorPublic: Story = { ...populated, args: { persona: 'moderator' } };

export const OperatorPublic: Story = { ...populated, args: { persona: 'operator' } };
export const VisitorPrivate: Story = { ...missing, args: { persona: 'visitor', privateRealm: true } };
export const VisitorClosed: Story = { ...missing, args: { persona: 'visitor', state: 'missing' } };
export const StrangerPrivate: Story = { ...missing, args: { persona: 'stranger', privateRealm: true } };
export const StrangerClosed: Story = { ...missing, args: { persona: 'stranger', state: 'missing' } };
export const MemberPrivate: Story = { ...populated, args: { persona: 'member', privateRealm: true } };
export const MemberClosed: Story = { ...missing, args: { persona: 'member', state: 'missing' } };
export const OwnerPrivate: Story = { ...populated, args: { persona: 'owner', privateRealm: true } };
export const OwnerClosed: Story = { ...missing, args: { persona: 'owner', state: 'missing' } };
export const ModeratorPrivate: Story = { ...populated, args: { persona: 'moderator', privateRealm: true } };
export const ModeratorClosed: Story = { ...missing, args: { persona: 'moderator', state: 'missing' } };
export const OperatorPrivate: Story = { ...missing, args: { persona: 'operator', privateRealm: true } };
export const OperatorClosed: Story = { ...missing, args: { persona: 'operator', state: 'missing' } };
export const TraditionalChinese: Story = { ...populated, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { ...populated, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { ...populated, globals: { locale: 'ja' } };
export const Korean: Story = { ...populated, globals: { locale: 'ko' } };
export const German: Story = { ...populated, globals: { locale: 'de' } };
export const French: Story = { ...populated, globals: { locale: 'fr' } };
export const Spanish: Story = { ...populated, globals: { locale: 'es' } };
