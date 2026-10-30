import { CoverGrid, CoverCard } from '@rezics/ui/cover-card';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { coverSrc } from '../media/cover-src';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import { rowRatio } from './subject-row';
import { displayLibraryTitle } from './title';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import type { DynamicMembersResult } from './collection-load';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';

export function DynamicCollectionPage({
  page,
  readMembers,
}: {
  page: DynamicCollectionPageData;
  readMembers?: (id: string, cursor?: string) => Promise<DynamicMembersResult>;
}) {
  const [current, setCurrent] = useState(page);
  const [retries, setRetries] = useState(0);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    setCurrent(page);
    setRetries(0);
    setRetrying(false);
  }, [page]);
  useEffect(() => {
    if (!current.preparing || retries >= 3 || retrying || !readMembers) return;
    const timer = setTimeout(
      () => {
        setRetrying(true);
        void readMembers(current.id, current.cursor)
          .then(
            (result) => {
              setCurrent((value) => ({ ...value, ...result }));
            },
            () => {
              setCurrent((value) => ({ ...value, preparing: false, unavailable: true }));
            },
          )
          .finally(() => {
            setRetries((count) => count + 1);
            setRetrying(false);
          });
      },
      Math.max(1000, Math.min(30_000, current.retryAfterMs)),
    );
    return () => clearTimeout(timer);
  }, [current, readMembers, retries, retrying]);
  const ratio = rowRatio(current.members.map((member) => member.subject));
  const empty =
    current.builtinKind === 'everything'
      ? m.library_dynamic_empty_everything()
      : current.builtinKind === 'liked'
        ? m.library_dynamic_empty_liked()
        : m.library_collection_empty();
  const locale = getLocale();
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header>
        <PageHeading>{current.title}</PageHeading>
        {current.description ? <p className="mt-3 whitespace-pre-wrap">{current.description}</p> : null}
      </header>
      {current.filterProperties && current.filterParams ? (
        <CollectionFilters
          id={current.id}
          type={current.filterType ?? 'schema:Book'}
          properties={current.filterProperties}
          params={current.filterParams}
        />
      ) : null}
      <CollectionFilterFeedback
        id={current.id}
        {...(current.filter === undefined ? {} : { filter: current.filter })}
        {...(current.filterIgnored === undefined ? {} : { ignored: current.filterIgnored })}
        {...(current.filterStatus === undefined ? {} : { status: current.filterStatus })}
        empty={current.members.length === 0}
        emptyLabel={empty}
        {...(current.unavailable !== undefined ? { unavailable: current.unavailable } : {})}
      />
      {current.preparing ? (
        current.filterStatus === 'preparing' ? null : (
          <p role="status">{m.library_dynamic_preparing()}</p>
        )
      ) : current.unavailable ? (
        <p role="alert">{m.library_dynamic_unavailable()}</p>
      ) : current.members.length ? (
        <CoverGrid ratio={ratio}>
          {current.members.map(({ subject }, index) => {
            const localizedTitle = subject ? displayLibraryTitle(subject.label, locale) : undefined;
            const title = localizedTitle?.text ?? m.library_subject_unavailable();
            const href = subject ? subjectHref({ id: subject.id, label: title }, locale) : null;
            return (
              <CoverCard
                key={subject?.id ?? index}
                {...(href ? { href: href.href } : {})}
                title={title}
                {...(localizedTitle?.lang ? { titleLang: localizedTitle.lang } : {})}
                cover={{
                  subject: { id: subject?.id ?? 'unavailable', title, types: subject?.types ?? [] },
                  cover: subject?.cover ?? null,
                  src: coverSrc,
                }}
              />
            );
          })}
        </CoverGrid>
      ) : null}
      {current.preparing && retries >= 3 ? (
        <div>
          <p>{m.library_dynamic_try_later()}</p>
          <button
            className="underline"
            type="button"
            onClick={() => {
              setRetries(0);
              setRetrying(false);
            }}
          >
            {m.library_collection_reload()}
          </button>
        </div>
      ) : null}
      {current.next ? (
        <nav aria-label={m.library_collection_members()}>
          <Link
            to="/collections/$id"
            params={{ id: current.id }}
            search={{ cursor: current.next }}
            className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
          >
            {m.library_collection_more()}
          </Link>
        </nav>
      ) : null}
    </article>
  );
}
