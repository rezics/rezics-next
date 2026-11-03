import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedItem, FeedPage } from '../features/pages/home-feed-read';
import type { FeedReaction } from '../features/feed/vote-control';
import { getLocale } from '../paraglide/runtime.js';

function preparedPage(anonymous: boolean, revision: number, state: 'counts' | 'unavailable' | 'mismatch'): FeedPage {
  const feedItems: FeedItem[] = ['discussion', 'review', 'post', 'reply'].map((kind, index) => {
    const id = `00000000-0000-7000-8000-${String(revision * 10 + index).padStart(12, '0')}`;
    const threadId = '00000000-0000-7000-8000-000000000099';
    const post = kind === 'post' || kind === 'reply';
    const baseline = {
      reactionTarget: { targetKind: post ? 'post' as const : 'thread' as const, targetId: state === 'mismatch' ? threadId : id },
      ...(state === 'unavailable' ? {} : { reactions: { upvote: 1234567890123, downvote: 1234567890130 } }),
      ...(anonymous ? {} : { viewerReaction: 'upvote' as const }),
    };
    return post
      ? {
          id: `prepared:${id}`, source: 'following', occurredAt: null,
          key: { owner: 'content', kind: 'post', route: 0, id },
          summary: { id, threadId, title: `Prepared ${kind}`, createdAt: '2026-11-04T00:00:00Z', ...baseline },
          destination: { kind: 'post', id, postId: id, threadId, title: `Prepared ${kind}` },
        }
      : {
          id: `prepared:${id}`, source: 'following', occurredAt: null,
          key: { owner: 'content', kind: 'thread', route: 0, id },
          summary: { id, kind: kind === 'review' ? 'review' : 'discussion', title: `Prepared ${kind}`, createdAt: '2026-11-04T00:00:00Z', ...baseline },
          destination: { kind: 'thread', id, title: `Prepared ${kind}` },
        };
  });
  return {
    feedItems, next: null, asOf: '2026-11-04T00:00:00Z', reactionsAsOf: { epoch: 1, position: String(revision + 1) },
    sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' },
  };
}

function PreparedHome({ anonymous = false, state = 'counts' }: { anonymous?: boolean; state?: 'counts' | 'unavailable' | 'mismatch' }) {
  const locale = getLocale();
  const [signedIn, setSignedIn] = useState(!anonymous);
  const [revision, setRevision] = useState(0);
  const client = useMemo(() => {
    const client = new QueryClient();
    client.setQueryData(['session'], anonymous
      ? { state: 'signed-out', subject: null, csrfToken: null }
      : { state: 'signed-in', subject: 'prepared-reader', csrfToken: 'prepared-csrf' });
    return client;
  }, [anonymous]);
  const result = useMemo(() => ({ state: 'ready' as const, page: preparedPage(anonymous, revision, state) }), [anonymous, revision, state]);
  const transport = useMemo<FeedReaction['preparedTransport']>(() => {
    const values = new Map<string, FeedReaction['value']>();
    return {
      change: async ({ data }) => { values.set(data.id, data.kind); return { ok: true }; },
      read: async ({ data }) => {
        const value = values.has(data.id) ? values.get(data.id)! : 'upvote';
        return { ok: true, counts: { upvote: 1234567890122 + Number(value === 'upvote'), downvote: 1234567890130 + Number(value === 'downvote') }, value };
      },
    };
  }, [revision]);
  return (
    <QueryClientProvider client={client}>
      <div className="space-y-4 p-4">
        <p role="note">Prepared Home responses and reaction transport. These fixtures do not prove native delivery, including anonymous Content discovery.</p>
        <div className="flex flex-wrap gap-4">
          <button className="min-h-11 underline" onClick={() => setRevision(revision + 1)}>Replace page and targets</button>
          <button className="min-h-11 underline" onClick={() => {
            client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
            setSignedIn(false);
          }}>Revoke viewer</button>
        </div>
        <HomeFeed result={result} locale={locale} signedIn={signedIn} preparedReactionTransport={transport} />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Pages/Discovery/Home native reactions (prepared)', component: PreparedHome,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
    } },
  },
} satisfies Meta<typeof PreparedHome>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentViewerPhone: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' } };
export const CurrentViewerPhoneDark: Story = { ...CurrentViewerPhone, globals: { viewport: { value: 'phone390' }, theme: 'dark' } };
export const CurrentViewerDesktop: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' } };
export const CurrentViewerDesktopDark: Story = { ...CurrentViewerDesktop, globals: { viewport: { value: 'desktop1280' }, theme: 'dark' } };
export const AnonymousPhone: Story = { ...CurrentViewerPhone, args: { anonymous: true } };
export const AnonymousPhoneDark: Story = { ...CurrentViewerPhoneDark, args: { anonymous: true } };
export const AnonymousDesktop: Story = { ...CurrentViewerDesktop, args: { anonymous: true } };
export const AnonymousDesktopDark: Story = { ...CurrentViewerDesktopDark, args: { anonymous: true } };
export const UnavailablePhone: Story = { ...CurrentViewerPhone, args: { state: 'unavailable' } };
export const UnavailableDesktopDark: Story = { ...CurrentViewerDesktopDark, args: { state: 'unavailable' } };
export const TargetMismatchPhone: Story = { ...CurrentViewerPhone, args: { state: 'mismatch' } };
export const TargetMismatchDesktopDark: Story = { ...CurrentViewerDesktopDark, args: { state: 'mismatch' } };
