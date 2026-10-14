import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { catalogs } from '../../i18n/catalogs.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { HomePosts } from '../home/home-page.tsx';
import type { HomeMessages } from '../home/messages.ts';
import { type FeedApi, mainFeedApi } from './api.ts';
import { closedRealm, closureActor, closureCreditHref, closureOwner, closureQuery,
  closureTransport, independentOriginals, type ClosureState } from './closure-feed-fixtures.ts';
import { FeedProvider } from './feed-context.tsx';
import { FeedSkeleton } from './feed-list.tsx';
import { NOW } from './fixtures.ts';
import type { FeedMessages } from './messages.ts';
import { readFeedPage } from './read.ts';
import { parseFeedState } from './state.ts';
import type { FeedPage, Loaded } from './types.ts';

interface Args { persona: AnswerPersona; state: ClosureState; locale: UiLocale }

/** Uses the production first-page reader, typed HTTP client, HomePosts and list.
 * The transport supplies contract-built answers until closure-feed records exist. */
function ClosureFeed({ persona, state, locale }: Args) {
  const [frame, setFrame] = useState<{
    api: FeedApi; messages: { home: HomeMessages; feed: FeedMessages };
  } | null>(null);
  const [read, setRead] = useState<Loaded<FeedPage> | null>(null);
  useEffect(() => {
    let active = true;
    const transport = closureTransport(persona, state);
    const api = mainFeedApi(transport.main);
    void Promise.all([catalogs.home[locale](), catalogs.feed[locale]()]).then(([home, feed]) => {
      if (active) setFrame({ api, messages: { home, feed } });
    });
    void readFeedPage(transport.main, closureQuery(persona, state === 'empty')).then(page => {
      if (active) setRead(page);
    });
    return () => { active = false; transport.dispose(); };
  }, [persona, state, locale]);
  if (!frame) return <FeedSkeleton />;
  const copy = materializeData(frame.messages.feed, { locale });
  const actor = closureActor(persona) ?? null;
  const view = parseFeedState({ tab: 'all', sort: 'new', ...(state === 'empty' ? { realm: closedRealm } : {}) },
    Boolean(actor));
  return <FeedProvider locale={locale} messages={frame.messages.feed} now={NOW} signedIn={Boolean(actor)}
    actingSubject={actor} signInHref="/auth/start?next=%2Fen" avatarQuery="" tab="all"
    followedRealms={null} api={frame.api}>
    <div className="mx-auto max-w-[46rem] py-6 sm:px-6">
      {read ? <HomePosts locale={locale} messages={frame.messages} signedIn={Boolean(actor)} actingSubject={actor}
        signInHref="/auth/start?next=%2Fen" state={view} defaults={{ tab: 'all', sort: 'new' }}
        query={closureQuery(persona, state === 'empty')} page={read} readerActions={memoryReaderActions({})} />
        : <><p role="status" className="sr-only">{copy.loadingMore}</p><FeedSkeleton /></>}
    </div>
  </FeedProvider>;
}

const meta = {
  title: 'Feed/Closed Realm (contract specimens)',
  component: ClosureFeed,
  args: { persona: 'visitor', state: 'populated', locale: 'en' },
  parameters: { docs: { description: { component:
    'Contract-built states: realm/closure-feed has no recorded answers yet. Requests for prove are listed in missingClosureAnswers. Feed reads declare no HTTP 202; projection catch-up is a 200 state, not pending.' } } },
} satisfies Meta<typeof ClosureFeed>;
export default meta;
type Story = StoryObj<typeof meta>;

function specimen(persona: AnswerPersona, state: ClosureState, phone = false, locale: UiLocale = 'en'): Story {
  return {
    args: { persona, state, locale },
    globals: { locale, viewport: { value: phone ? 'phone' : 'desktop' } },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      const t = materializeData(await catalogs.feed[locale](), { locale });
      if (state === 'loading') {
        await expect(await canvas.findByRole('status')).toHaveTextContent(t.loadingMore);
        await expect(canvas.queryByRole('article')).toBeNull();
      } else if (state === 'empty') {
        await expect(await canvas.findByRole('heading', { name: t.emptyFiltered })).toBeVisible();
        await expect(canvas.queryByRole('article')).toBeNull();
        await expect(canvas.queryByRole('button', { name: t.loadMore })).toBeNull();
      } else if (state === 'forbidden') {
        await expect(await canvas.findByRole('status')).toHaveTextContent(t.forbiddenTitle);
        await expect(canvas.queryByRole('link', { name: t.signIn })).toBeNull();
        await expect(canvas.queryByRole('article')).toBeNull();
      } else if (state === 'unavailable') {
        await expect(await canvas.findByRole('alert')).toHaveTextContent(t.serverBody);
        await expect(canvas.getByRole('button', { name: t.retry })).toBeVisible();
        await expect(canvas.queryByRole('link', { name: t.signIn })).toBeNull();
      } else {
        const first = independentOriginals[state === 'sparse' ? 1 : 0]!;
        await expect(await canvas.findByRole('article', { name: first.target.title!.value })).toBeVisible();
        // Exercise the actual successor boundary, including an error without losing the first original.
        window.scrollTo(0, document.documentElement.scrollHeight);
        if (state === 'continuation-forbidden') {
          await expect(await canvas.findByRole('status')).toHaveTextContent(t.forbiddenTitle);
          await expect(canvas.queryByRole('link', { name: t.signIn })).toBeNull();
          await expect(canvas.getAllByRole('article')).toHaveLength(1);
        } else if (state === 'continuation-error') {
          await expect(await canvas.findByRole('alert')).toHaveTextContent('feed-read-contract-503');
          await expect(canvas.getAllByRole('article')).toHaveLength(1);
        } else {
          await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(state === 'sparse' ? 1 : 2));
          for (const original of state === 'sparse' ? independentOriginals.slice(1) : independentOriginals) {
            const article = canvas.getByRole('article', { name: original.target.title!.value });
            await expect(within(article).getAllByRole('link', { name: closureOwner.name })
              .some(link => link.getAttribute('href') === `/en${closureCreditHref}`)).toBe(true);
            await expect(within(article).getByRole('link', { name: original.target.title!.value })).toHaveAttribute(
              'href', `/en${original.links.target}`);
          }
          await expect(canvas.queryByRole('button', { name: t.loadMore })).toBeNull();
        }
        await expect(canvasElement.textContent).not.toContain('Chinese Web Fiction');
        await expect(canvas.queryByRole('button', { name: /new posts?$/ })).toBeNull();
      }
      window.scrollTo(0, 0);
    },
  };
}

export const VisitorDesktop = specimen('visitor', 'populated');
export const VisitorPhone = specimen('visitor', 'populated', true);
export const StrangerDesktop = specimen('stranger', 'populated');
export const StrangerPhone = specimen('stranger', 'populated', true);
export const MemberDesktop = specimen('member', 'populated');
export const MemberPhone = specimen('member', 'populated', true);
export const OwnerDesktop = specimen('owner', 'populated');
export const OwnerPhone = specimen('owner', 'populated', true);
export const ModeratorDesktop = specimen('moderator', 'populated');
export const ModeratorPhone = specimen('moderator', 'populated', true);
export const OperatorDesktop = specimen('operator', 'populated');
export const OperatorPhone = specimen('operator', 'populated', true);
export const LoadingDesktop = specimen('member', 'loading');
export const LoadingPhone = specimen('member', 'loading', true);
export const ClosedRealmEmptyDesktop = specimen('member', 'empty');
export const ClosedRealmEmptyPhone = specimen('member', 'empty', true);
export const RefusalDesktop = specimen('member', 'forbidden');
export const RefusalPhone = specimen('member', 'forbidden', true);
export const UnavailableDesktop = specimen('member', 'unavailable');
export const UnavailablePhone = specimen('member', 'unavailable', true);
export const SuccessorErrorDesktop = specimen('member', 'continuation-error');
export const SuccessorErrorPhone = specimen('member', 'continuation-error', true);
export const SuccessorRefusalDesktop = specimen('member', 'continuation-forbidden');
export const SuccessorRefusalPhone = specimen('member', 'continuation-forbidden', true);
export const EmptyPageContinuesDesktop = specimen('member', 'sparse');
export const EmptyPageContinuesPhone = specimen('member', 'sparse', true);
export const RefusalGerman = specimen('member', 'forbidden', false, 'de');
export const RefusalSpanish = specimen('member', 'forbidden', false, 'es');
export const RefusalFrench = specimen('member', 'forbidden', false, 'fr');
export const RefusalJapanese = specimen('member', 'forbidden', true, 'ja');
export const RefusalKorean = specimen('member', 'forbidden', true, 'ko');
export const RefusalSimplifiedChinese = specimen('member', 'forbidden', true, 'zh-Hans');
export const RefusalTraditionalChinese = specimen('member', 'forbidden', true, 'zh-Hant');
