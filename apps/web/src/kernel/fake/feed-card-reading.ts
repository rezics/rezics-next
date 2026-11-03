import type { FeedItem } from '../../features/pages/home-feed-read';
import { homeFeedStoryPage } from './home-feed-stories';

/** Prepared native-shaped reading examples, not evidence of native selection or pending branch delivery. */
export function preparedFeedCardReading(long = false): FeedItem[] {
  const page = homeFeedStoryPage('en', true, 'mixed');
  const work = page.feedItems.find((item) => item.source === 'discovery')!;
  const continued = page.feedItems.find((item) => item.source === 'continue')!;
  const id = '01a1a000-0000-7000-8000-000000000921';
  const title = long ? '閱讀の記憶 · Les voix du monde · 긴 이름 '.repeat(12) : 'Prepared: voices of a reader';
  const author = {
    displayName: long ? '讀者 · Reader · 독자 '.repeat(15) : 'Prepared reader',
    handle: 'prepared_reader',
    avatar: null,
  };
  const thread: FeedItem = {
    id: 'prepared:discussion',
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 4660, id },
    occurredAt: '2026-11-03T08:30:00.000Z',
    summary: {
      id,
      kind: 'discussion',
      title,
      createdAt: '2026-10-01T09:00:00.000Z',
      author,
      excerpt: 'Prepared opening: a reader notices a new detail.\nAnother line keeps its own rhythm.',
    },
    destination: { kind: 'thread', id, title },
  };
  const review: FeedItem = {
    ...thread,
    id: 'prepared:review',
    summary: {
      ...thread.summary,
      kind: 'review',
      title: 'Prepared: a careful reread',
      subject: { id: work.summary.id, title: 'Prepared reviewed Subject' },
    },
  };
  const reply: FeedItem = {
    id: 'prepared:reply',
    source: 'following',
    key: { owner: 'content', kind: 'post', route: 4660, id: 'prepared-post' },
    occurredAt: '2026-11-03T09:00:00.000Z',
    summary: {
      id: 'prepared-post',
      threadId: id,
      title,
      createdAt: '2026-10-02T09:00:00.000Z',
      author,
      excerpt: 'Prepared reply: this opens the exact post in its discussion, not the first page alone.',
    },
    destination: { kind: 'post', threadId: id, postId: 'prepared-post', title },
  };
  const account: FeedItem = {
    id: 'prepared:account',
    source: 'discovery',
    key: { owner: 'accounts', kind: 'account', route: 4660, id: 'prepared-account' },
    occurredAt: null,
    summary: {
      id: 'prepared-account',
      displayName: author.displayName,
      handle: 'prepared_reader',
      accountKind: 'organization',
      automated: true,
      operatorId: null,
      avatar: null,
      verifiedAgent: { id: work.summary.id, label: 'Prepared identity', type: 'schema:Person' },
    },
    destination: { kind: 'account', id: 'prepared-account', title: author.displayName },
  };
  return [
    work,
    thread,
    reply,
    review,
    {
      id: 'prepared:collection',
      source: 'following',
      key: { owner: 'library', kind: 'collection', route: 4660, id: 'prepared-collection' },
      occurredAt: null,
      summary: {
        id: 'prepared-collection',
        title: 'Prepared: short novels',
        description: 'Prepared public description. No private Collection rules are supplied.',
      },
      destination: { kind: 'collection', id: 'prepared-collection', title: 'Prepared: short novels' },
    },
    account,
    {
      id: 'prepared:space',
      source: 'following',
      key: { owner: 'community', kind: 'space', route: 4660, id: 'prepared-space' },
      occurredAt: null,
      summary: {
        id: 'prepared-space',
        title: 'Prepared Space seam',
        address: 'prepared-reading-room',
        summary: 'Prepared Space preview; this branch awaits its native producer.',
        realm: { id: 'prepared-realm', title: 'Prepared carrier Realm' },
      },
      destination: {
        kind: 'space',
        id: 'prepared-space',
        title: 'Prepared Space seam',
        address: 'prepared-reading-room',
      },
    },
    continued,
  ];
}
