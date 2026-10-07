import { buttonVariants } from '@rezics/ui/button';
import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { materializeData } from 'native-i18n';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { isUiLocale } from '../../i18n/define.ts';
import { threadPath } from '../feed/discussion.ts';
import type { FeedMessages } from '../feed/messages.ts';
import { parseThreadSort, type ThreadRead, type ThreadSort } from '../feed/thread.ts';
import { type Loaded, settle } from '../feed/types.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { mainApiWithToken } from '../api/main.ts';
import {
  DiscussionFrame,
  discussionView,
  readerMain,
  realmPathOf,
  replyModeOf,
  type Search,
} from './discussion-page.tsx';
import type { RealmView } from './realm-page.tsx';
import { resolveRealm } from './read.ts';
import { ThreadView } from './thread-view.tsx';
import { parseAddressSegment } from '../address/path.ts';
import { realmMetadata } from './routes.tsx';

// `/r/{realm}/discussions/{reply}`: one discussion, or one reply with its
// place in the discussion, in the Realm's frame with its rail.

export interface ThreadRouteProps {
  params: Promise<{ locale: string; realm: string; thread: string }>;
  searchParams: Promise<Search>;
}

function readThread(
  main: ReturnType<typeof mainApiWithToken>,
  view: RealmView,
  thread: string,
  sort: ThreadSort,
  language?: string,
): Promise<Loaded<ThreadRead>> {
  return settle(() =>
    main.v1
      .realms({ realm: view.realm.realm })
      .threads({ reply: thread })
      .get({
        query: {
          sort,
          ...(language ? { language } : {}),
          ...(view.reader.actingSubject ? { actingSubject: view.reader.actingSubject } : {}),
        },
      }),
  );
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
      .v1.realms({ realm: resolved.realm })
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

/** A thread's shape while Main answers: the post, then a few replies, in the page's rhythm. */
export function ThreadSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-6">
      <Skeleton className="h-4 w-40 rounded-full" />
      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-3 w-44 rounded-full" />
        </div>
        <Skeleton className="h-7 w-4/5 rounded-full" />
        <SkeletonText lines={3} />
        <Skeleton className="h-9 w-56 rounded-full" />
      </div>
      <div className="grid gap-5 border-border/60 border-t pt-5">
        <Skeleton className="h-11 w-full rounded-2xl" />
        {[0, 1, 2].map((index) => (
          <div key={index} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 gap-y-2">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="h-3 w-36 self-center rounded-full" />
            <span />
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    </div>
  );
}

async function ThreadContent({
  view,
  thread,
  sort,
  here,
  feed,
  language,
}: {
  view: RealmView;
  thread: string;
  sort: ThreadSort;
  here: string;
  feed: FeedMessages;
  language?: string;
}) {
  const read = await readThread(await readerMain(view), view, thread, sort, language);
  if (!read.ok && read.failure === 'missing') notFound();
  const { locale } = view.context;
  const t = materializeData(feed, { locale });
  const sortHrefs = Object.fromEntries(
    (['best', 'top', 'new'] as const).map((option) => {
      const query = new URLSearchParams();
      if (option !== 'best') query.set('sort', option);
      if (language) query.set('language', language);
      return [option, `${here}${query.size ? `?${query}` : ''}`];
    }),
  ) as Record<ThreadSort, string>;
  if (!read.ok) {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        tone="destructive"
        role="alert"
        headingLevel={1}
        title={t.threadFailed}
        description={t.threadFailedBody}
      >
        <LocalizedLink href={sortHrefs[sort]} className={buttonVariants({ variant: 'outline' })}>
          <RotateCwIcon aria-hidden="true" />
          {t.retry}
        </LocalizedLink>
      </EmptyState>
    );
  }
  return (
    <ThreadView
      read={read.data}
      sort={sort}
      sortHrefs={sortHrefs}
      replyMode={replyModeOf(view)}
      realm={{ id: view.realm.header.id, name: view.zone.name.value, path: realmPathOf(view) }}
    />
  );
}

export async function RealmThreadRoute({ params, searchParams }: ThreadRouteProps) {
  const [{ locale, realm, thread }, search] = await Promise.all([params, searchParams]);
  const parsed = parseAddressSegment(thread);
  if (!parsed || parsed.kind === 'alias') notFound();
  const resolved = await discussionView(locale, realm, search, `/${thread}`);
  if ('page' in resolved) return resolved.page;
  const { view, feed } = resolved;
  const sort = parseThreadSort(search);
  const language = Array.isArray(search.language) ? search.language[0] : search.language;
  const here = threadPath(realmPathOf(view), parsed.id);
  return (
    <DiscussionFrame
      view={view}
      locale={resolved.locale}
      feed={feed}
      search={search}
      here={sort === 'best' ? here : `${here}?sort=${sort}`}
    >
      <Suspense fallback={<ThreadSkeleton />}>
        <ThreadContent view={view} thread={parsed.id} sort={sort} here={here} feed={feed} language={language} />
      </Suspense>
    </DiscussionFrame>
  );
}
