import { AccountRef } from './account-ref';
import { SubjectRef } from './subject-ref';
import type { SubjectReference } from './subject-ref';
import { mutateSubjectLibrarySlot, readSubjectLibraryCollections } from './subject-slot-actions';
import type { SubjectLibraryMutation, SubjectLibrarySlotData } from './subject-slot';
import { m } from '../paraglide/messages.js';
import { useEffect, useState, type FormEvent } from 'react';

type SubjectSlotProps = {
  subject: SubjectReference;
  locale: string;
  data: SubjectLibrarySlotData;
};

const buttonClass =
  'inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-sm text-primary hover:bg-muted';
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';

/** Compact subject-level Library controls rendered in the page's template action slot. */
export function SubjectLibrarySlot({ subject, locale, data }: SubjectSlotProps) {
  const action = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(subject.id)}`;
  const [hydrated, setHydrated] = useState(false);
  const [actionResult, setActionResult] = useState(data.result);
  const [entry, setEntry] = useState(data.entry);
  const [selectedState, setSelectedState] = useState(data.entry?.state ?? 'planned');
  const [collections, setCollections] = useState(data.collections);
  const [collectionsLoaded, setCollectionsLoaded] = useState(data.collectionsLoaded);
  const [collectionsProblem, setCollectionsProblem] = useState<'closed' | 'unavailable' | null>(null);
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(data.collectionsLoaded);
  const stateOptions = [
    ['planned', m.library_subject_state_planned()],
    ['in_progress', m.library_subject_state_in_progress()],
    ['completed', m.library_subject_state_completed()],
    ['paused', m.library_subject_state_paused()],
    ['dropped', m.library_subject_state_dropped()],
  ] as const;
  useEffect(() => setHydrated(true), []);
  const result = actionResult ?? data.result;
  const resultText =
    result === 'saved'
      ? m.library_subject_saved()
      : result === 'cleared'
        ? m.library_subject_cleared()
        : result === 'added'
          ? m.library_subject_collection_added()
          : result === 'collection-full'
            ? m.library_subject_collection_full()
            : result === 'closed'
              ? m.library_subject_closed()
              : result === 'conflict'
                ? m.library_subject_unavailable()
                : result === 'unavailable'
                  ? m.library_subject_unavailable()
                  : null;

  async function mutate(input: SubjectLibraryMutation) {
    if (!hydrated) return;
    try {
      const response = await mutateSubjectLibrarySlot({
        data: input,
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      setActionResult(response.result);
      if ('entry' in response) {
        setEntry(response.entry ?? null);
        setSelectedState(response.entry?.state ?? 'planned');
      }
    } catch {
      setActionResult('unavailable');
    }
  }

  function saveEntry(action: 'save' | 'clear') {
    return mutate({
      subjectId: subject.id,
      intent: 'entry',
      action,
      ...(action === 'save' ? { state: selectedState } : {}),
      ...(entry ? { revision: entry.revision } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  }

  function addToCollection(collectionId: string) {
    return mutate({
      subjectId: subject.id,
      intent: 'member',
      collectionId,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  async function loadCollections(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    try {
      const response = await readSubjectLibraryCollections({ data: { subjectId: subject.id } });
      setCollections(response.collections);
      setCollectionsLoaded(response.state === 'loaded');
      setCollectionsProblem(response.state === 'loaded' ? null : response.state);
      setCollectionMenuOpen(true);
    } catch {
      setCollectionsProblem('unavailable');
    }
  }

  return (
    <section aria-label={m.library_subject_heading()} className="flex flex-wrap items-center gap-2">
      {data.session === 'signed-in' && data.entryAvailable ? (
        <form
          data-library-entry
          method="get"
          action={action}
          onSubmit={(event) => event.preventDefault()}
          className="flex flex-wrap items-center gap-2"
        >
          <label className="sr-only" htmlFor={`library-state-${subject.id}`}>
            {m.library_subject_entry()}
          </label>
          <select
            id={`library-state-${subject.id}`}
            value={selectedState}
            disabled={!hydrated}
            onChange={(event) =>
              setSelectedState(event.currentTarget.value as NonNullable<SubjectLibraryMutation['state']>)
            }
            className="min-h-9 max-w-44 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
          >
            {stateOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className={buttonClass} type="button" disabled={!hydrated} onClick={() => void saveEntry('save')}>
            {m.library_subject_save()}
          </button>
          {entry ? (
            <button className={buttonClass} type="button" disabled={!hydrated} onClick={() => void saveEntry('clear')}>
              {m.library_subject_clear()}
            </button>
          ) : null}
        </form>
      ) : null}

      {data.session === 'signed-in' ? (
        <details
          data-add-to-collection
          open={collectionMenuOpen}
          onToggle={(event) => setCollectionMenuOpen(event.currentTarget.open)}
          className="relative"
        >
          <summary className={`${buttonClass} cursor-pointer list-none`}>{m.library_subject_add_collection()}</summary>
          <div className="absolute end-0 z-20 mt-2 w-72 max-w-[90vw] rounded-xl border border-border bg-background p-4 shadow-xl">
            <p className="mb-3 text-sm text-muted-foreground">
              {m.library_subject_add_subject()} <SubjectRef subject={subject} />
            </p>
            {collectionsLoaded && collections ? (
              collections.length ? (
                <ul className="space-y-2">
                  {collections.map((collection) => (
                    <li key={collection.id}>
                      <button
                        className={`${linkClass} inline-flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-start hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60`}
                        type="button"
                        disabled={!hydrated}
                        onClick={() => void addToCollection(collection.id)}
                      >
                        <span className="truncate">{collection.title}</span>
                        <span className="shrink-0 text-muted-foreground">{collection.memberCount}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{m.library_subject_no_collections()}</p>
              )
            ) : (
              <form method="get" action={action} onSubmit={(event) => void loadCollections(event)}>
                <input type="hidden" name="slot" value="collections" />
                <button className={buttonClass} type="submit">
                  {m.library_subject_load_collections()}
                </button>
              </form>
            )}
            {collectionsProblem ? (
              <p role="alert" className="mt-3 text-sm text-muted-foreground">
                {collectionsProblem === 'closed' ? m.library_subject_closed() : m.library_subject_unavailable()}
              </p>
            ) : null}
            <nav
              data-library-subject-links
              aria-label={m.library_subject_more_options()}
              className="mt-4 flex flex-col gap-2 border-t border-border pt-3"
            >
              <a className={linkClass} href={`/library/progress?subjectId=${encodeURIComponent(subject.id)}`}>
                {m.library_subject_start_progress()}
              </a>
              <a className={linkClass} href={`/library/copies?subjectId=${encodeURIComponent(subject.id)}`}>
                {m.library_subject_your_copies()}
              </a>
            </nav>
          </div>
        </details>
      ) : data.session === 'signed-out' ? (
        <a data-library-sign-in className={buttonClass} href={`/auth/sign-in?return_to=${encodeURIComponent(action)}`}>
          {m.account_sign_in()}
        </a>
      ) : null}

      {data.publicCollections ? (
        <details data-public-collections className="relative">
          <summary className={`${buttonClass} cursor-pointer list-none`}>
            {m.library_subject_public_collections({ count: data.publicCollections.length })}
          </summary>
          <div className="absolute end-0 z-20 mt-2 w-80 max-w-[90vw] rounded-xl border border-border bg-background p-4 shadow-xl">
            {data.publicCollections.length ? (
              <ul className="space-y-3">
                {data.publicCollections.map((collection) => (
                  <li key={collection.id} className="flex flex-col gap-1">
                    <a
                      className={linkClass}
                      href={`/${encodeURIComponent(locale)}/collections/${encodeURIComponent(collection.id)}`}
                    >
                      {collection.title}
                    </a>
                    <span className="text-sm text-muted-foreground">
                      <AccountRef account={collection.curator} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {m.library_subject_multiplicity({ count: collection.multiplicity })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{m.library_subject_no_public_collections()}</p>
            )}
          </div>
        </details>
      ) : null}
      {resultText ? (
        <p role="alert" className="basis-full text-sm text-muted-foreground">
          {resultText}
        </p>
      ) : null}
    </section>
  );
}
