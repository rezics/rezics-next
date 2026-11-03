import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { SubjectRef, type SubjectReference } from '../subject-ref';
import {
  collectionReadFailure,
  emptyCollectionPage,
  firstCollectionVisit,
  isCuratedWriteDestination,
  nextCollectionVisit,
  previousCollectionVisit,
  replaceCollectionPage,
  type BoundCollectionPage,
  type CapturedChooserTarget,
  type ChooserCollectionRow,
  type SubjectCollectionVisit,
} from './model';

const buttonClass = buttonVariants({ variant: 'outline' });
const controlClass =
  'h-auto min-h-[44px] min-w-0 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';
const rowClass = `${linkClass} inline-flex min-h-[44px] w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-2 text-start whitespace-normal hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

export type ChooserCollectionsRead = {
  collections: ChooserCollectionRow[] | null;
  next: string | null;
  state: 'loaded' | 'expired' | 'closed' | 'unavailable';
};

export function CollectionChooserPanel({
  subject,
  locale,
  action,
  readerHref,
  csrfToken,
  admitted,
  hydrated,
  loaded,
  collections,
  next,
  problem,
  pending,
  addedId,
  current,
  readPage,
  onSelect,
  onConfirm,
}: {
  subject: SubjectReference;
  locale: string;
  action: string;
  readerHref: string;
  csrfToken: string | null;
  admitted: boolean;
  hydrated: boolean;
  loaded: boolean;
  collections: ChooserCollectionRow[] | null;
  next: string | null;
  problem: 'closed' | 'unavailable' | 'expired' | null;
  pending: boolean;
  addedId: string | null;
  current: () => boolean;
  readPage: (cursor?: string) => Promise<ChooserCollectionsRead>;
  onSelect: (target: CapturedChooserTarget | null) => void;
  onConfirm: (collectionId: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef(true);
  const version = useRef(0);
  const callbacks = useRef({ current, readPage, onSelect });
  callbacks.current = { current, readPage, onSelect };
  const [page, setPage] = useState<BoundCollectionPage<ChooserCollectionRow>>(() =>
    loaded ? replaceCollectionPage(undefined, collections ?? [], next, firstCollectionVisit()) : emptyCollectionPage(),
  );
  const [issue, setIssue] = useState<'expired' | 'closed' | 'unavailable' | null>(problem);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<CapturedChooserTarget | null>(null);
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
    setPage((currentPage) => replaceCollectionPage(currentPage, [], null, visit));
    try {
      const response = await callbacks.current.readPage(visit.cursor);
      if (!retained(episode)) return;
      if (response.state !== 'loaded' || response.collections === null) {
        setIssue(response.state === 'loaded' ? 'unavailable' : response.state);
        return;
      }
      setPage((currentPage) => replaceCollectionPage(currentPage, response.collections ?? [], response.next, visit));
      if (focus) heading.current?.focus();
    } catch (error) {
      if (retained(episode)) setIssue(collectionReadFailure(error));
    } finally {
      if (retained(episode)) setBusy(false);
    }
  }

  function choose(row: ChooserCollectionRow) {
    if (!isCuratedWriteDestination(row) || !csrfToken || !admitted) return;
    const target = { id: row.id, title: row.title };
    setSelected(target);
    callbacks.current.onSelect(target);
  }

  const destinations = issue ? [] : page.rows.filter(isCuratedWriteDestination);
  const selectedStill = selected;
  return (
    <div className="max-h-[70vh] w-full min-w-0 overflow-y-auto p-4 sm:w-72">
      <h3 ref={heading} tabIndex={-1} className="mb-2 text-sm font-medium">
        {m.library_subject_chooser_heading()}
      </h3>
      <p className="mb-3 text-sm text-muted-foreground">
        {m.library_subject_add_subject()} <SubjectRef subject={subject} />
      </p>
      {busy ? <p role="status">{m.library_subject_chooser_preparing()}</p> : null}
      {!loaded && page.generation === 0 && !busy ? (
        <form
          method="get"
          action={action}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void load(firstCollectionVisit(), true);
          }}
        >
          <input type="hidden" name="slot" value="collections" />
          <button className={`${buttonClass} ${controlClass}`} type="submit">
            {m.library_subject_load_collections()}
          </button>
        </form>
      ) : null}
      {loaded || page.generation > 0 || busy ? (
        <>
          {issue ? (
            <div role="alert" className="space-y-2 text-sm text-muted-foreground">
              <p>
                {issue === 'expired'
                  ? m.library_subject_continuation_expired()
                  : issue === 'closed'
                    ? m.library_subject_closed()
                    : m.library_subject_unavailable()}
              </p>
              <button
                type="button"
                className={`${buttonClass} ${controlClass}`}
                disabled={busy || !hydrated}
                onClick={() => void load(firstCollectionVisit(), true)}
              >
                {m.library_subject_continuation_restart()}
              </button>
            </div>
          ) : null}
          {!issue && !busy && destinations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {page.next
                ? m.library_subject_chooser_empty_page()
                : page.visit.page > 1
                  ? m.library_subject_continuation_exhausted()
                  : m.library_subject_no_curated_collections()}
            </p>
          ) : null}
          {!issue && destinations.length ? (
            <ul className="space-y-2">
              {destinations.map((collection) => (
                <li key={collection.id}>
                  <button
                    className={rowClass}
                    type="button"
                    aria-pressed={selectedStill?.id === collection.id}
                    disabled={!hydrated || !csrfToken || !admitted}
                    onClick={() => choose(collection)}
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">{collection.title}</span>
                    <span className="shrink-0 text-muted-foreground">{collection.memberCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!issue ? (
            <div className="mt-3 flex min-w-0 flex-wrap gap-2">
              {previousCollectionVisit(page.visit) ? (
                <button
                  type="button"
                  className={`${buttonClass} ${controlClass}`}
                  disabled={busy || !hydrated}
                  onClick={() => {
                    const previous = previousCollectionVisit(page.visit);
                    if (previous) void load(previous, true);
                  }}
                >
                  {m.library_subject_continuation_previous()}
                </button>
              ) : null}
              {page.visit.page > 1 ? (
                <button
                  type="button"
                  className={`${buttonClass} ${controlClass}`}
                  disabled={busy || !hydrated}
                  onClick={() => void load(firstCollectionVisit(), true)}
                >
                  {m.library_subject_continuation_restart()}
                </button>
              ) : null}
              {page.next && !issue ? (
                <button
                  type="button"
                  className={`${buttonClass} ${controlClass}`}
                  disabled={busy || !hydrated}
                  onClick={() => void load(nextCollectionVisit(page.visit, page.next), true)}
                >
                  {m.library_subject_continuation_next()}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {selectedStill ? (
        <div data-add-collection-review className="mt-4 space-y-2 border-t border-border pt-3">
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_subject_chooser_selected({ title: selectedStill.title })}
          </p>
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_subject_add_review({ title: selectedStill.title })}
          </p>
          <button
            type="button"
            className={`${buttonClass} ${controlClass}`}
            disabled={!hydrated || !csrfToken || !admitted || pending}
            onClick={() => onConfirm(selectedStill.id)}
          >
            {m.library_subject_add_confirm()}
          </button>
        </div>
      ) : null}
      {addedId ? (
        <nav className="mt-3 flex flex-col gap-2" aria-label={m.library_subject_heading()}>
          <a
            className={`${linkClass} min-h-[44px] [overflow-wrap:anywhere]`}
            href={`/${encodeURIComponent(locale)}/collections/${encodeURIComponent(addedId)}`}
          >
            {m.library_subject_collection_open({
              title: selectedStill?.id === addedId ? selectedStill.title : addedId,
            })}
          </a>
          <a className={`${linkClass} min-h-[44px]`} href={readerHref}>
            {m.library_subject_return_reader()}
          </a>
        </nav>
      ) : null}
    </div>
  );
}
