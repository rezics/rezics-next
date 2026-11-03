import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useEffect, useRef, useState } from 'react';
import { AccountRef } from '../account-ref';
import { m } from '../../paraglide/messages.js';
import {
  collectionReadFailure,
  firstCollectionVisit,
  nextCollectionVisit,
  publicCountOf,
  replaceCollectionPage,
  type BoundCollectionPage,
  type ExactPublicCount,
  type PublicCollectionRow,
  type SubjectCollectionVisit,
} from './model';

const buttonClass = buttonVariants({ variant: 'outline' });
const controlClass =
  'h-auto min-h-[44px] min-w-0 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';

export type PublicCollectionsRead = {
  collections: PublicCollectionRow[] | null;
  next: string | null;
  count: ExactPublicCount;
  state: 'loaded' | 'expired' | 'closed' | 'unavailable';
};

export function PublicCollectionsPanel({
  locale,
  collections,
  next,
  count,
  current,
  readPage,
}: {
  locale: string;
  collections: PublicCollectionRow[] | null;
  next: string | null;
  count: ExactPublicCount | undefined;
  current: () => boolean;
  readPage: (cursor?: string) => Promise<PublicCollectionsRead>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef(true);
  const version = useRef(0);
  const callbacks = useRef({ current, readPage });
  callbacks.current = { current, readPage };
  const [page, setPage] = useState<BoundCollectionPage<PublicCollectionRow>>(() =>
    replaceCollectionPage(
      undefined,
      collections ?? [],
      next,
      firstCollectionVisit(),
      count ?? publicCountOf(undefined),
    ),
  );
  const [issue, setIssue] = useState<'expired' | 'closed' | 'unavailable' | null>(
    collections === null ? 'unavailable' : null,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      version.current++;
    };
  }, []);
  const retained = (episode: number) => live.current && episode === version.current && callbacks.current.current();

  async function load(visit: SubjectCollectionVisit, focus: boolean) {
    const episode = ++version.current;
    setBusy(true);
    setIssue(null);
    setPage((currentPage) => replaceCollectionPage(currentPage, [], null, visit, currentPage.count));
    try {
      const response = await callbacks.current.readPage(visit.cursor);
      if (!retained(episode)) return;
      if (response.state !== 'loaded' || response.collections === null) {
        setIssue(response.state === 'loaded' ? 'unavailable' : response.state);
        return;
      }
      setPage((currentPage) =>
        replaceCollectionPage(currentPage, response.collections ?? [], response.next, visit, response.count),
      );
      if (focus) heading.current?.focus();
    } catch (error) {
      if (retained(episode)) setIssue(collectionReadFailure(error));
    } finally {
      if (retained(episode)) setBusy(false);
    }
  }

  const total = page.count ?? count ?? publicCountOf(undefined);
  const rows = issue ? [] : page.rows;
  return (
    <details data-public-collections className="relative">
      <summary className={`${buttonClass} cursor-pointer list-none`}>
        {total.kind === 'exact'
          ? m.library_subject_public_collections({ count: total.value })
          : m.library_subject_public_collections_unknown()}
      </summary>
      <div className="absolute end-0 z-20 mt-2 w-80 max-w-[90vw] space-y-3 rounded-xl border border-border bg-background p-4 shadow-xl">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-medium">
          {total.kind === 'exact'
            ? m.library_subject_public_collections({ count: total.value })
            : m.library_subject_public_collections_unknown()}
        </h3>
        {busy ? <p role="status">{m.library_subject_public_preparing()}</p> : null}
        {issue ? (
          <div role="alert" className="space-y-2 text-sm text-muted-foreground">
            <p>
              {issue === 'expired'
                ? m.library_subject_continuation_expired()
                : issue === 'closed'
                  ? m.library_subject_closed()
                  : m.library_subject_public_unavailable()}
            </p>
            <button
              type="button"
              className={`${buttonClass} ${controlClass}`}
              disabled={busy}
              onClick={() => void load(firstCollectionVisit(), true)}
            >
              {m.library_subject_continuation_restart()}
            </button>
          </div>
        ) : null}
        {!issue && !busy && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {page.next
              ? m.library_subject_public_empty_page()
              : page.visit.page > 1
                ? m.library_subject_continuation_exhausted()
                : m.library_subject_no_public_collections()}
          </p>
        ) : null}
        {!issue && rows.length ? (
          <>
            <p className="text-sm text-muted-foreground">{m.library_subject_page_rows({ count: rows.length })}</p>
            <ul className="space-y-3">
              {rows.map((collection) => (
                <ContentItem
                  key={collection.id}
                  title={collection.title}
                  headingLevel={3}
                  href={`/${encodeURIComponent(locale)}/collections/${encodeURIComponent(collection.id)}`}
                  metadata={
                    <>
                      {collection.curator?.handle ? (
                        <a href={`/${encodeURIComponent(locale)}/@${encodeURIComponent(collection.curator.handle)}`}>
                          <AccountRef account={collection.curator} />
                        </a>
                      ) : (
                        <AccountRef account={collection.curator} />
                      )}
                      <span>{m.library_subject_multiplicity({ count: collection.multiplicity })}</span>
                    </>
                  }
                />
              ))}
            </ul>
          </>
        ) : null}
        {!issue ? (
          <div className="flex min-w-0 flex-wrap gap-2">
            {page.visit.page > 1 ? (
              <button
                type="button"
                className={`${buttonClass} ${controlClass}`}
                disabled={busy}
                onClick={() => void load(firstCollectionVisit(), true)}
              >
                {m.library_subject_continuation_restart()}
              </button>
            ) : null}
            {page.next ? (
              <button
                type="button"
                className={`${buttonClass} ${controlClass}`}
                disabled={busy}
                onClick={() => void load(nextCollectionVisit(page.visit, page.next), true)}
              >
                {m.library_subject_continuation_next()}
              </button>
            ) : null}
          </div>
        ) : null}
        {!issue && !busy && page.visit.page > 1 && !page.next && rows.length > 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.library_subject_continuation_exhausted()}
          </p>
        ) : null}
        {rows.length
          ? rows.map((collection) => (
              <a
                key={`return-${collection.id}`}
                className={`${linkClass} sr-only`}
                href={`/${encodeURIComponent(locale)}/collections/${encodeURIComponent(collection.id)}`}
              >
                {collection.title}
              </a>
            ))
          : null}
      </div>
    </details>
  );
}
