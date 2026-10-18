import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { FeedProvider } from '../feed/feed-context.tsx';
import { memoryFeed } from '../feed/fixtures.ts';
import { messages as english, type FeedMessages } from '../feed/messages.ts';
import zhHans from '../feed/messages/zh-Hans.ts';
import zhHant from '../feed/messages/zh-Hant.ts';
import ja from '../feed/messages/ja.ts';
import ko from '../feed/messages/ko.ts';
import de from '../feed/messages/de.ts';
import fr from '../feed/messages/fr.ts';
import es from '../feed/messages/es.ts';
import { memoryThreads, storyRealm, storyThread, storyThreads, THREAD_NOW } from '../feed/thread-fixtures.ts';
import type { ThreadRead, ThreadsPage } from '../feed/thread.ts';
import type { Loaded } from '../feed/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { communityZone } from '../zones/fixtures.ts';
import { DiscussionBoards, DiscussionListContent, DiscussionListSkeleton } from './discussion-content.tsx';
import { realmDiscussionReads, type BoardPage } from './discussion-read.ts';
import { RealmNotFound } from './states.tsx';
import { RealmPageStory, realmMessagesFor } from './story-page.tsx';
import { RealmThreadContent, ThreadSkeleton } from './thread-content.tsx';
import { realmHref } from './route.ts';
import { DiscussionColumns, ThreadRail } from './thread-rail.tsx';

type State = 'populated' | 'empty' | 'error' | 'gone' | 'loading' | 'thread' | 'thread-empty' | 'thread-loading' | 'thread-error' | 'thread-gone' | 'siblings';
const concept = 'https://rezics.com/id/00000001-aaaa-4000-a000-000000000001';
const context = 'https://rezics.com/id/00000002-aaaa-4000-a000-000000000001';
const realm = storyRealm.id.slice(-36);
const threadPath = `${storyRealm.path}/discussions/${storyThread.focus.slice(-36)}`;
const feedCatalogs = { en: {}, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja, ko, de, fr, es };

/** Missing recordings: these are contract-built answers, never captured HTTP evidence.
 * Prove requests: GET /v1/realms/{realm}/classification-context; GET /v1/classification-vocabulary?context={context}&limit=20;
 * GET /v1/realms/{realm}/threads?sort=best&concept={concept} (200 populated/empty, 503, 404);
 * GET /v1/realms/{realm}/threads/{reply}?sort=best (200 thread/branch/opener without replies, 503, 404);
 * GET /v1/realms/{realm}/threads/{reply}?sort=best&cursor=siblings%2F%2B%3D%3D (200 next siblings).
 * Loading holds the request. These GET contracts declare no 202 pending state.
 */
function contractClient(state: State) {
  const page: ThreadsPage = { profile: 'realm-threads-v1', realm: storyRealm.id, sort: 'best', window: 'week',
    items: state === 'empty' ? [] : storyThreads, nextCursor: state === 'empty' ? null : 'threads/+==',
    count: { value: state === 'empty' ? 0 : storyThreads.length, kind: 'exact-page', total: null }, sourcePosition: storyThread.sourcePosition };
  const boards: BoardPage = { profile: 'shared-vocabulary-v1', context, scheme: null, items: [
    { id: concept, label: 'Reading together · 一起阅读' },
  ], hasMore: true, nextCursor: 'boards/+==', sourcePosition: storyThread.sourcePosition };
  const fetcher = (async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/classification-context')) return Response.json({ context });
    if (url.pathname.endsWith('/classification-vocabulary')) return Response.json(boards);
    if (!url.pathname.includes('/threads')) throw new Error(`Unexpected contract story request: ${url.pathname}`);
    if (state === 'loading' || state === 'thread-loading') return new Promise<Response>(() => {});
    if (state === 'error' || state === 'thread-error') return Response.json({ type: 'https://rezics.com/problems/work_read_unavailable', title: 'Work read is unavailable', status: 503, code: 'work_read_unavailable' }, { status: 503 });
    if (state === 'gone' || state === 'thread-gone') return Response.json({ type: 'https://rezics.com/problems/work_unavailable', title: 'Work is unavailable', status: 404, code: 'work_unavailable' }, { status: 404 });
    if (url.pathname.endsWith('/threads')) return Response.json(page);
    const read: ThreadRead = state === 'siblings' ? { ...storyThread, complete: false,
      continuations: [{ kind: 'siblings', reply: storyThread.focus, cursor: 'siblings/+==' }],
    } : state === 'thread-empty' ? { ...storyThread, items: [storyThread.items[0]!] } : storyThread;
    return Response.json(url.searchParams.has('cursor') ? storyThread : read);
  }) as typeof fetch;
  return browserMainApi('https://contract.invalid', { anonymous: true, fetcher });
}

function DiscussionPage({ state, locale, signedIn }: { state: State; locale: UiLocale; signedIn: boolean }) {
  const [loaded, setLoaded] = useState<{ state: State; page: Loaded<ThreadsPage>; boards: Loaded<BoardPage> } | null>(null);
  const [thread, setThread] = useState<{ state: State; read: Loaded<ThreadRead> } | null>(null);
  const feed: FeedMessages = { ...english, ...feedCatalogs[locale] };
  const messages = realmMessagesFor(locale);
  const isThread = state.startsWith('thread') || state === 'siblings';
  const actor = signedIn ? storyThread.items[0]!.author!.id : undefined;
  useEffect(() => {
    let active = true;
    const reads = realmDiscussionReads(contractClient(state), realm, actor);
    if (isThread) void reads.thread(storyThread.focus, 'best').then(read => { if (active) setThread({ state, read }); });
    else void Promise.all([reads.threads({ sort: 'best', window: 'week', concept }), reads.boards()])
      .then(([page, boards]) => { if (active) setLoaded({ state, page, boards }); });
    return () => { active = false; };
  }, [state, isThread, actor]);
  const here = isThread ? threadPath : `${storyRealm.path}/discussions`;
  const query = { sort: 'best' as const, window: 'week' as const, concept };
  if (loaded?.state === state && !loaded.page.ok && loaded.page.failure === 'missing') return <RealmNotFound messages={messages} />;
  if (thread?.state === state && !thread.read.ok && thread.read.failure === 'missing') return <RealmNotFound messages={messages} />;
  const zone = { ...communityZone(locale), realm: storyRealm.id,
    name: zoneContentText(storyRealm.name, 'en'),
    links: { home: realmHref(locale, realm), browse: '', works: '',
      discussions: realmHref(locale, realm, 'discussions'), decisions: realmHref(locale, realm, 'decisions'),
      about: realmHref(locale, realm, 'about') } };
  return <RealmPageStory zone={zone} realmRef={realm} locale={locale} compactCommunity={isThread}>
    <DiscussionColumns rail={<ThreadRail name={{ value: zone.name.value, lang: zone.name.lang }}
      description={zone.description ? { value: zone.description.value, lang: zone.description.lang } : null}
      members={null} aboutHref={zone.links.about} rules={[{ id: 'civility', title: 'Be considerate',
        body: 'Discuss the work and respect other readers.', lang: 'en' }]}
      labels={{ about: feed.aboutCommunity, rules: feed.communityRules, more: feed.moreAboutCommunity }} />}>
    <FeedProvider locale={locale} messages={feed} now={THREAD_NOW} signedIn={signedIn} actingSubject={actor ?? null}
      signInHref="/auth/start" avatarQuery="" tab="all" followedRealms={null} api={memoryFeed()}>
      {isThread ? thread?.state === state ? <RealmThreadContent read={thread.read} sort="best" here={here} feed={feed}
        locale={locale} messages={messages} realm={storyRealm} replyMode={signedIn ? 'open' : 'sign-in'} threadApi={memoryThreads()}
        readPage={async (reply, cursor) => {
          const read = await realmDiscussionReads(contractClient(state), realm, actor).thread(reply, 'best', undefined, cursor);
          if (!read.ok) throw new Error('Contract continuation unavailable');
          return read.data;
        }} /> : <ThreadSkeleton />
        : loaded?.state === state ? <>
          <DiscussionBoards read={loaded.boards} path={storyRealm.path} query={query} messages={messages} />
          <DiscussionListContent page={loaded.page} path={storyRealm.path} query={query} locale={locale} feed={feed} messages={messages} />
        </> : <DiscussionListSkeleton />}
    </FeedProvider>
    </DiscussionColumns>
  </RealmPageStory>;
}

const meta = { title: 'Realm/Discussion pages/Contract states awaiting recording', component: DiscussionPage,
  args: { state: 'populated', locale: 'en', signedIn: false }, globals: { viewport: { value: 'desktop' } },
  render: (args, { globals }) => <DiscussionPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof DiscussionPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { value: 'phone' } };
export const Populated: Story = { async play({ canvasElement }) {
  await expect(await within(canvasElement).findByRole('link', { name: 'Reading together · 一起阅读' })).toHaveAttribute('aria-current', 'page');
} };
export const PopulatedPhone: Story = { ...Populated, globals: phone };
export const Empty: Story = { args: { state: 'empty' }, async play({ canvasElement, globals }) {
  const locale = (globals.locale as UiLocale | undefined) ?? 'en';
  await expect(await within(canvasElement).findByText(({ ...english, ...feedCatalogs[locale] }).emptyDiscussions)).toBeVisible();
} };
export const EmptyPhone: Story = { ...Empty, globals: phone };
export const ServerError: Story = { args: { state: 'error' }, async play({ canvasElement, globals }) {
  const locale = (globals.locale as UiLocale | undefined) ?? 'en';
  await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(({ ...english, ...feedCatalogs[locale] }).serverBody);
} };
export const ServerErrorPhone: Story = { ...ServerError, globals: phone };
export const Gone: Story = { args: { state: 'gone' } };
export const GonePhone: Story = { ...Gone, globals: phone };
export const Loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(canvasElement.querySelector('[aria-busy=true]')).not.toBeNull();
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };
export const PublicThread: Story = { args: { state: 'thread' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: storyThread.items[0]!.title! });
  const header = canvasElement.querySelector('[data-subject-header]') as HTMLElement;
  await expect(header).not.toBeNull();
  await expect(canvas.queryByRole('link', { name: 'Report this post' })).toBeNull();
  const more = within(header).getByRole('button', { name: /^More actions/ });
  more.focus();
  await userEvent.keyboard('{Enter}');
  const report = await within(document.body).findByRole('menuitem', { name: 'Report this post' });
  const params = new URL(report.getAttribute('href')!, location.origin).searchParams;
  await expect(params.get('target')).toBe(storyThread.focus);
  await expect(params.get('realm')).toBe(storyRealm.id);
  await userEvent.keyboard('{Escape}');
  await expect(more).toHaveFocus();
  if (window.innerWidth < 1024) {
    const rules = canvas.getByRole('link', { name: 'Rules' });
    await expect(rules).toHaveAttribute('href', expect.stringContaining('#realm-rules'));
    await expect(rules.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
} };
export const PublicThreadPhone: Story = { ...PublicThread, globals: phone };
export const MemberThread: Story = { args: { state: 'thread', signedIn: true } };
export const MemberThreadPhone: Story = { ...MemberThread, globals: phone };
export const ThreadError: Story = { args: { state: 'thread-error' } };
export const ThreadErrorPhone: Story = { ...ThreadError, globals: phone };
export const ClosedThread: Story = { args: { state: 'thread-gone' } };
export const ClosedThreadPhone: Story = { ...ClosedThread, globals: phone };
export const Siblings: Story = { args: { state: 'siblings' } };
export const SiblingsPhone: Story = { ...Siblings, globals: phone };

export const ThreadWithoutReplies: Story = { args: { state: 'thread-empty' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText('No comments yet')).toBeVisible();
  await expect(canvas.queryByRole('button', { name: /^Sort comments/ })).toBeNull();
  await expect(canvas.getByRole('button', { name: /^More actions/ })).toBeVisible();
} };
export const ThreadWithoutRepliesPhone: Story = { ...ThreadWithoutReplies, globals: phone };
export const ThreadLoading: Story = { args: { state: 'thread-loading' } };
export const ThreadLoadingPhone: Story = { ...ThreadLoading, globals: phone };
