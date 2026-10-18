import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { FeedProvider } from './feed-context.tsx';
import { FeedList } from './feed-list.tsx';
import { NOW, page, post, storyId } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

interface Call { cursor: string | null; head: boolean; actor: string | null; credentials?: RequestCredentials }
interface Args {
  signedIn: boolean;
  actingSubject: string | null;
  locale: 'en' | 'zh-Hans';
  failure: 'moved' | 'unavailable';
  calls: Call[];
}

const original = post(21, { primaryAction: { kind: 'open', href: '/en' }, realm: null });
const successor = post(22, { primaryAction: { kind: 'open', href: '/en' }, realm: null });

/** Exercises the provider's default browser adapter, rather than injecting a FeedApi. */
function ReaderIdentity({ signedIn, actingSubject, locale }: Args) {
  const query = { scope: actingSubject ? 'following' as const : 'all' as const, sort: 'best' as const,
    ...(actingSubject ? { actingSubject } : {}) };
  return <FeedProvider locale={locale} messages={locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages}
    now={NOW} signedIn={signedIn} actingSubject={actingSubject} signInHref="/auth/start?next=%2Fen"
    avatarQuery="" tab={actingSubject ? 'following' : 'all'} followedRealms={null}>
    <div className="mx-auto max-w-[46rem] py-6 sm:px-6">
      <FeedList initial={{ ok: true, data: page([original], { scope: query.scope, nextCursor: 'second' }) }}
        query={query} headInterval={100} empty={null} allHref="/en?tab=all" />
    </div>
  </FeedProvider>;
}

const meta = {
  title: 'Feed/Reader identity (transport specimens)',
  component: ReaderIdentity,
  args: { signedIn: true, actingSubject: null, locale: 'en', failure: 'unavailable', calls: [] },
  globals: { viewport: { value: 'desktop' } },
  beforeEach({ args }) {
    args.calls.length = 0;
    let refused = false;
    const send = window.fetch;
    window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (!url.pathname.startsWith('/api/main/')) return send(input, init);
      if (url.pathname.startsWith('/api/main/v1/me/feed-watermarks/')) return new Response(null, { status: 204 });
      if (url.pathname !== '/api/main/v1/feed' && url.pathname !== '/api/main/v1/feed/head')
        throw new Error(`Unexpected Main request: ${url.pathname}`);
      const call = { cursor: url.searchParams.get('cursor'), head: url.pathname.endsWith('/head'),
        actor: url.searchParams.get('actingSubject'), credentials: init?.credentials };
      args.calls.push(call);
      if (Boolean(call.actor) !== (call.credentials === 'same-origin'))
        return Response.json({ code: 'invalid_home_command' }, { status: 400 });
      const scope = args.actingSubject ? 'following' : 'all';
      if (call.head) return Response.json({ profile: 'home-feed-head-v1', scope,
        afterSequence: '40', newPosts: { value: 0, kind: 'exact' }, state: 'current',
        projection: { sequence: '40', reviewSequence: '7', dataEpoch: 'story' } });
      if (call.cursor && !refused) {
        refused = true;
        return Response.json({ code: args.failure === 'moved' ? 'cursor_conflict' : 'temporarily_unavailable' },
          { status: args.failure === 'moved' ? 409 : 503 });
      }
      return Response.json(call.cursor ? page([original, successor], { scope })
        : page([original], { scope, nextCursor: 'fresh-second' }));
    }, { preconnect: send.preconnect });
    return () => { window.fetch = send; };
  },
} satisfies Meta<typeof ReaderIdentity>;
export default meta;
type Story = StoryObj<typeof meta>;

async function readAndRecover(canvasElement: HTMLElement, args: Args) {
  const canvas = within(canvasElement);
  const alert = await canvas.findByRole('alert');
  const chinese = args.locale === 'zh-Hans';
  await expect(alert).toHaveTextContent(args.failure === 'moved'
    ? chinese ? '你浏览时动态有了变化' : 'The feed changed while you were reading'
    : chinese ? '我们这边出了问题' : 'Something went wrong on our side');
  await userEvent.click(within(alert).getByRole('button', { name: args.failure === 'moved'
    ? chinese ? '刷新' : 'Refresh' : chinese ? '重试' : 'Try again' }));
  await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(2));
  await waitFor(() => expect(args.calls.some(call => call.head)).toBe(true));
  for (const call of args.calls) {
    await expect(call.actor).toBe(args.actingSubject);
    await expect(call.credentials).toBe(args.actingSubject ? 'same-origin' : 'omit');
  }
  await expect(args.calls.filter(call => !call.head).map(call => call.cursor)).toEqual(args.failure === 'moved'
    ? ['second', null, 'fresh-second'] : ['second', 'second']);
  await expect(canvas.queryByRole('alert')).toBeNull();
}

export const NoSelectedAgent: Story = { play: async ({ canvasElement, args }) => readAndRecover(canvasElement, args) };
export const IneligibleAgent: Story = { args: { failure: 'moved' }, play: NoSelectedAgent.play };
export const ActingContextUnavailable: Story = {
  args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans', viewport: { value: 'phone' }, theme: 'dark' },
  play: NoSelectedAgent.play,
};
export const AnonymousVisitor: Story = { args: { signedIn: false }, play: NoSelectedAgent.play };
export const EligibleAgent: Story = {
  args: { actingSubject: storyId(801, 'bbbb'), failure: 'moved' }, play: NoSelectedAgent.play,
};
