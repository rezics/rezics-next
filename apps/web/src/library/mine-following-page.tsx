import { Exposure, useOperation } from '../kernel/exposure';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { displayLibraryTitle } from './title';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import type { MineFollowingPage } from './mine-following';
import { FollowTargetControl } from './follow-target-control';

export function MineFollowingPageView({ page }: { page: MineFollowingPage }) {
  const canUnfollow = useOperation('follow.delete');
  const canReadCollection = useOperation('collection.get');
  const [follows, setFollows] = useState(page.follows);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    setFollows(page.follows);
    setRemoved(false);
  }, [page.follows]);

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
                      <ListRow
                        key={`${type}:${follow.targetId}`}
                        className="flex min-h-16 items-center gap-4 rounded-xl px-4 py-3"
                      >
                        {href ? (
                          <ListRowLink href={href} lang={title.lang}>
                            {title.text}
                          </ListRowLink>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p
                            aria-hidden={href ? 'true' : undefined}
                            lang={title.lang}
                            className="break-words font-medium"
                          >
                            {title.text}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {type === 'subject'
                              ? (follow.target?.typeLabel ?? label)
                              : type === 'collection'
                                ? m.library_following_kind_collection()
                                : m.library_following_kind_space()}
                          </p>
                          {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
                        </div>
                        {canUnfollow ? (
                          <ListRowControl className="shrink-0">
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
                          </ListRowControl>
                        ) : null}
                      </ListRow>
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
