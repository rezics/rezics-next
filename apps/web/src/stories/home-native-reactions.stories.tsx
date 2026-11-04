import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedItem, FeedPage } from '../features/pages/home-feed-read';
import { getLocale } from '../paraglide/runtime.js';

function PreparedHome({ anonymous = false }: { anonymous?: boolean }) {
  const [signedIn, setSignedIn] = useState(!anonymous);
  const [revision, setRevision] = useState(0);
  const client = useMemo(() => {
    const client = new QueryClient();
    client.setQueryData(
      ['session'],
      anonymous
        ? { state: 'signed-out', subject: null, csrfToken: null }
        : { state: 'signed-in', subject: 'prepared-reader', csrfToken: 'prepared-csrf' },
    );
    return client;
  }, [anonymous]);
  const result = useMemo(() => {
    const feedItems = ['discussion', 'review', 'post', 'reply'].map((kind, index): FeedItem => {
      const id = `00000000-0000-7000-8000-${String(revision * 10 + index).padStart(12, '0')}`;
      const threadId = '00000000-0000-7000-8000-000000000099';
      const post = kind === 'post' || kind === 'reply';
      return post
        ? {
            id: `prepared:${id}`,
            source: 'following',
            occurredAt: null,
            key: { owner: 'content', kind: 'post', route: 0, id },
            summary: { id, threadId, title: `Prepared ${kind}`, createdAt: '2026-11-04T00:00:00Z' },
            destination: { kind: 'post', id, postId: id, threadId, title: `Prepared ${kind}` },
          }
        : {
            id: `prepared:${id}`,
            source: 'following',
            occurredAt: null,
            key: { owner: 'content', kind: 'thread', route: 0, id },
            summary: {
              id,
              kind: kind === 'review' ? 'review' : 'discussion',
              title: `Prepared ${kind}`,
              createdAt: '2026-11-04T00:00:00Z',
            },
            destination: { kind: 'thread', id, title: `Prepared ${kind}` },
          };
    });
    return {
      state: 'ready' as const,
      page: {
        feedItems,
        next: null,
        asOf: '2026-11-04T00:00:00Z',
        sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' },
      } satisfies FeedPage,
    };
  }, [revision]);
  return (
    <QueryClientProvider client={client}>
      <div className="space-y-4 p-4">
        <p role="note">
          Prepared Home responses intentionally omit native reaction advice. These fixtures do not prove native
          delivery, including anonymous Content discovery.
        </p>
        <div className="flex flex-wrap gap-4">
          <button className="min-h-11 underline" onClick={() => setRevision(revision + 1)}>
            Replace page
          </button>
          <button
            className="min-h-11 underline"
            onClick={() => {
              client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
              setSignedIn(false);
            }}
          >
            Revoke viewer
          </button>
        </div>
        <HomeFeed result={result} locale={getLocale()} signedIn={signedIn} />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Pages/Discovery/Home native reactions (prepared)',
  component: PreparedHome,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof PreparedHome>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentViewerPhone: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' } };
export const CurrentViewerPhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' } };
export const CurrentViewerDesktop: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' } };
export const CurrentViewerDesktopDark: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'dark' } };
export const AnonymousPhone: Story = { ...CurrentViewerPhone, args: { anonymous: true } };
export const AnonymousPhoneDark: Story = { ...CurrentViewerPhoneDark, args: { anonymous: true } };
export const AnonymousDesktop: Story = { ...CurrentViewerDesktop, args: { anonymous: true } };
export const AnonymousDesktopDark: Story = { ...CurrentViewerDesktopDark, args: { anonymous: true } };
