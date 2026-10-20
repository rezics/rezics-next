import { RealmThreadContent, ThreadSkeleton } from './thread-content.tsx';
import { realmDiscussionReads } from './discussion-read.ts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { isUiLocale } from '../../i18n/define.ts';
import { threadPath } from '../feed/discussion.ts';
import type { FeedMessages } from '../feed/messages.ts';
import { parseThreadSort, type ThreadSort } from '../feed/thread.ts';
import { settle } from '../feed/types.ts';
import { mainApiWithToken } from '../api/main.ts';
import {
  DiscussionFrame,
  discussionView,
  discussionClient,
  readerMain,
  realmPathOf,
  replyModeOf,
  type Search,
} from './discussion-page.tsx';
import type { RealmReplay, RealmView } from './realm-page.tsx';
import { resolveRealm, type RealmReadClient } from './read.ts';
import { parseAddressSegment } from '../address/path.ts';
import { idOf, parseCursor } from './route.ts';
import { realmMetadata } from './routes.tsx';

// `/r/{realm}/discussions/{reply}`: one discussion, or one reply with its
// place in the discussion, in the Realm's frame with its rail.

export interface ThreadRouteProps {
  params: Promise<{ locale: string; realm: string; thread: string }>;
  searchParams: Promise<Search>;
}

export async function realmThreadMetadata({
  params,
}: Pick<ThreadRouteProps, 'params'>): Promise<Metadata> {
  const { locale, realm, thread } = await params;
  const parsed = parseAddressSegment(thread);
  if (!isUiLocale(locale) || !parsed || parsed.kind === 'alias') return {};
  const metadata = await realmMetadata(
    { params: Promise.resolve({ locale, realm }) },
    'discussions',
  );
  const resolved = await resolveRealm(realm, locale);
  if (resolved.kind !== 'realm') return metadata;
  const read = await settle(() =>
    mainApiWithToken(undefined)
      .v1.realms({ realm: idOf(resolved.realm) ?? resolved.realm })
      .threads({ reply: parsed.id })
      .get(),
  );
  if (!read.ok) return { ...metadata, title: resolved.header.name.value };
  const opening =
    read.data.focus === read.data.thread ? read.data.items[0] : read.data.ancestors[0];
  const title = opening?.title ?? '';
  return {
    ...metadata,
    title: title ? `${title} · ${resolved.header.name.value}` : resolved.header.name.value,
    description: opening?.body.slice(0, 200) || undefined,
  };
}

async function ThreadContent(props: { view: RealmView; thread: string; sort: ThreadSort; here: string; feed: FeedMessages; language?: string; cursor?: string; client?: RealmReadClient }) {
  const read = await realmDiscussionReads(await readerMain(props.view, props.client), props.view.realm.realm,
    props.view.reader.actingSubject ?? undefined).thread(props.thread, props.sort, props.language, props.cursor);
  if (!read.ok && read.failure === 'missing') notFound();
  return <RealmThreadContent sort={props.sort} here={props.here} feed={props.feed} language={props.language}
    locale={props.view.context.locale} messages={props.view.messages}
    realm={{ id: props.view.realm.header.id, name: props.view.zone.name.value, path: realmPathOf(props.view) }}
    read={read} replyMode={replyModeOf(props.view)} />;
}

export async function RealmThreadRoute({ params, searchParams }: ThreadRouteProps, host?: RealmReadClient | RealmReplay) {
  const [{ locale, realm, thread }, search] = await Promise.all([params, searchParams]);
  const parsed = parseAddressSegment(thread);
  if (!parsed || parsed.kind === 'alias') notFound();
  const resolved = await discussionView(locale, realm, search, `/${thread}`, host);
  if ('page' in resolved) return resolved.page;
  const { view, feed } = resolved;
  const client = discussionClient(view, host);
  const sort = parseThreadSort(search);
  const language = Array.isArray(search.language) ? search.language[0] : search.language;
  const here = threadPath(realmPathOf(view), parsed.id);
  const content = <ThreadContent view={view} thread={parsed.id} sort={sort} here={here} feed={feed}
    language={language} cursor={parseCursor(search)} client={client} />;
  return DiscussionFrame({ view, locale: resolved.locale, feed, search, client,
    thread: true,
    here: sort === 'best' ? here : `${here}?sort=${sort}`, children:
      <Suspense fallback={<ThreadSkeleton />}>{client ? await ThreadContent(content.props) : content}</Suspense>,
  });
}
