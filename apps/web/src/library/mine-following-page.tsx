import { Exposure, useOperation } from '../kernel/exposure';
import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { displayLibraryTitle } from './title';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import type { MineFollowingPage } from './mine-following';
import { FollowTargetControl } from './follow-target-control';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { readMineFollowingForViewer, type MineFollowingRead } from './mine-following-actions';

const retiredPage: MineFollowingPage = { signedIn: false, follows: [], next: null };

export const mineFollowingQuery = (subject: string, cursor: string | null, locale: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['mine-following', subject, 'follow.list', true, cursor, locale],
    queryFn: async ({ signal }) => {
      const result = await readMineFollowingForViewer({ data: { cursor: cursor ?? undefined } });
      signal.throwIfAborted();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

function matches(read: MineFollowingRead, subject: string, cursor: string | null, locale: string): boolean {
  return read.page.signedIn && read.subject === subject && read.cursor === cursor && read.locale === locale;
}

/** Retained router data is a candidate, never authority for the browser's current viewer. */
export function CurrentViewerMineFollowingPage({
  initial,
  cursor,
}: {
  initial: MineFollowingRead;
  cursor?: string | undefined;
}) {
  const session = useSession();
  const canList = useOperation('follow.list');
  const subject = session.state === 'signed-in' && session.subject ? session.subject : null;
  const address = cursor || null;
  const locale = getLocale();
  return subject && canList ? (
    <CurrentFollowingRead
      key={JSON.stringify([subject, address, locale])}
      subject={subject}
      cursor={address}
      locale={locale}
      initial={initial}
    />
  ) : (
    <MineFollowingPageView page={retiredPage} />
  );
}

function CurrentFollowingRead({
  subject,
  cursor,
  locale,
  initial,
}: {
  subject: string;
  cursor: string | null;
  locale: string;
  initial: MineFollowingRead;
}) {
  const read = useQuery({
    ...mineFollowingQuery(subject, cursor, locale),
    ...(matches(initial, subject, cursor, locale) ? { initialData: initial } : {}),
  });
  const page = read.data && matches(read.data, subject, cursor, locale) ? read.data.page : retiredPage;
  return <MineFollowingPageView page={page} />;
}

export function MineFollowingPageView({ page }: { page: MineFollowingPage }) {
  // A meaningful row/page replacement retires local removal callbacks during render. Equivalent
  // refetches (including freshly issued keys) preserve the native control's uncertain intent.
  const lifetime = JSON.stringify({
    ...page,
    follows: page.follows.map(({ idempotencyKey: _key, ...follow }) => follow),
  });
  return <MineFollowingPageState key={lifetime} page={page} />;
}

function MineFollowingPageState({ page }: { page: MineFollowingPage }) {
  const canUnfollow = useOperation('follow.delete');
  const canReadCollection = useOperation('collection.get');
  const [follows, setFollows] = useState(page.follows);
  const [removed, setRemoved] = useState(false);

  const active = page.signedIn ? follows.filter((follow) => follow.state === 'following') : [];
  const groups = [
    { type: 'subject' as const, label: m.library_following_subjects() },
    { type: 'collection' as const, label: m.library_following_collections() },
    { type: 'space' as const, label: m.library_following_spaces() },
  ];

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.library_following_heading()}</PageHeading>
      </header>
      {page.signedIn && removed ? <p role="status">{m.library_follow_removed()}</p> : null}
      {active.length ? (
        <div className="space-y-8">
          {groups.map(({ type, label }) => {
            const items = active.filter((follow) => follow.targetType === type);
            if (!items.length) return null;
            return (
              <section key={type} className="space-y-3" aria-labelledby={`following-${type}`}>
                <h2 id={`following-${type}`} className="text-xl font-semibold">
                  {label}
                </h2>
                <ul className="list-none space-y-1">
                  {items.map((follow) => {
                    const title = follow.target
                      ? displayLibraryTitle(follow.target.label, getLocale())
                      : { text: m.library_subject_unavailable(), lang: undefined };
                    const href =
                      follow.target && type === 'subject'
                        ? subjectHref({ id: follow.target.id, label: title.text }, getLocale()).href
                        : follow.target && type === 'collection' && canReadCollection
                          ? `/${getLocale()}/collections/${encodeURIComponent(follow.target.id)}`
                          : undefined;
                    const reason =
                      follow.reason === 'library'
                        ? m.library_follow_reason_library()
                        : follow.reason === 'membership'
                          ? m.library_follow_reason_membership()
                          : undefined;
                    return (
                      <ContentItem
                        key={`${type}:${follow.targetId}`}
                        className="px-4"
                        title={title.text}
                        {...(title.lang ? { titleLang: title.lang } : {})}
                        headingLevel={3}
                        {...(href ? { href } : {})}
                        metadata={
                          <div className="min-w-0 space-y-1">
                            <p>
                              {type === 'subject'
                                ? (follow.target?.typeLabel ?? label)
                                : type === 'collection'
                                  ? m.library_following_kind_collection()
                                  : m.library_following_kind_space()}
                            </p>
                            {reason ? <p>{reason}</p> : null}
                          </div>
                        }
                        actions={
                          canUnfollow ? (
                            <FollowTargetControl
                              targetId={follow.targetId}
                              following
                              idempotencyKey={follow.idempotencyKey}
                              menuTitle={m.library_follow_more_actions({ title: title.text })}
                              onRemoved={() => {
                                setFollows((items) => items.filter((item) => item.targetId !== follow.targetId));
                                setRemoved(true);
                              }}
                            />
                          ) : null
                        }
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      ) : page.signedIn ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {page.next ? m.library_following_page_empty() : m.library_following_empty()}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <a href={`/${getLocale()}/search`} className={buttonVariants({ variant: 'outline' })}>
              {m.search_heading()}
            </a>
          </EmptyContent>
        </Empty>
      ) : null}
      {page.signedIn && page.next ? (
        <Exposure operation="follow.list">
          <nav aria-label={m.library_following_heading()}>
            <Link
              to="/library/following"
              search={{ cursor: page.next }}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
            >
              {m.library_collection_more()}
            </Link>
          </nav>
        </Exposure>
      ) : null}
    </article>
  );
}
