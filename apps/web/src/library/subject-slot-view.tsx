import { Exposure } from '../kernel/exposure';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@rezics/ui/shadcn/select';
import { Loader2Icon } from 'lucide-react';
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { AccountRef } from './account-ref';
import { SubjectRef } from './subject-ref';
import type { SubjectReference } from './subject-ref';
import { mutateSubjectLibrarySlot, readSubjectLibraryCollections } from './subject-slot-actions';
import type {
  LibraryEntryState,
  SubjectLibraryMutation,
  SubjectLibraryMutationResponse,
  SubjectLibrarySlotData,
} from './subject-slot';

type SubjectSlotProps = {
  subject: SubjectReference;
  locale: string;
  data: SubjectLibrarySlotData;
};

// The state action is the page's one filled primary button; every other control here is a secondary (outline) button.
const buttonClass = buttonVariants({ variant: 'outline' });
const primaryClass = buttonVariants({ variant: 'default' });
const linkClass = 'text-sm text-primary underline-offset-4 hover:underline';
const removeValue = 'remove';

function LibraryStateSelect({
  busy,
  disabled,
  hasEntry,
  selectedState,
  stateOptions,
  onChoose,
}: {
  busy: boolean;
  disabled: boolean;
  hasEntry: boolean;
  selectedState: LibraryEntryState | '';
  stateOptions: readonly (readonly [LibraryEntryState, string])[];
  onChoose: (value: string) => void;
}) {
  const choices = [
    ...stateOptions.map(([value, label]) => ({ value, label })),
    ...(hasEntry ? [{ value: removeValue, label: m.library_subject_remove() }] : []),
  ];
  return (
    <Select
      disabled={disabled}
      items={choices}
      onValueChange={(value) => onChoose(value ?? '')}
      value={selectedState || null}
    >
      <SelectTrigger
        aria-busy={busy ? true : undefined}
        aria-label={m.library_subject_entry()}
        className="w-fit bg-primary text-primary-foreground hover:bg-primary/80 data-placeholder:text-primary-foreground [&_svg]:text-primary-foreground"
      >
        {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
        <SelectValue placeholder={m.library_subject_add()} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {choices.map((option) => (
          <Fragment key={option.value}>
            {option.value === removeValue ? <SelectSeparator /> : null}
            <SelectItem value={option.value}>{option.label}</SelectItem>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Compact subject-level Library controls rendered in the page's template action slot. */
export function SubjectLibrarySlot({ subject, locale, data }: SubjectSlotProps) {
  const action = subjectHref({ id: subject.id, label: subject.label }, locale).href;
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionResult, setActionResult] = useState(data.result);
  const [entry, setEntry] = useState(data.entry);
  const [selectedState, setSelectedState] = useState<LibraryEntryState | ''>(data.entry?.state ?? '');
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
                ? m.library_conflict()
                : result === 'unavailable'
                  ? m.library_subject_unavailable()
                  : null;

  function applyEntryResult(response: SubjectLibraryMutationResponse, previous: LibraryEntryState | '') {
    if (response.result === 'saved' && response.entry) {
      setEntry(response.entry);
      setSelectedState(response.entry.state);
      setActionResult('saved');
      return;
    }
    if (response.result === 'cleared') {
      setEntry(null);
      setSelectedState('');
      setActionResult('cleared');
      return;
    }
    if (response.result === 'conflict' && 'entry' in response) {
      setEntry(response.entry ?? null);
      setSelectedState(response.entry?.state ?? '');
      setActionResult('conflict');
      return;
    }
    setSelectedState(previous);
    setActionResult(response.result);
  }

  async function writeEntry(input: SubjectLibraryMutation, previous: LibraryEntryState | '') {
    try {
      const response = await mutateSubjectLibrarySlot({
        data: input,
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      applyEntryResult(response, previous);
    } catch {
      setSelectedState(previous);
      setActionResult('unavailable');
    } finally {
      setPending(false);
    }
  }

  function choose(value: string) {
    if (!hydrated || pending || !value) return;
    if (value === 'remove') {
      if (!entry) return;
      const previous = selectedState;
      setPending(true);
      void writeEntry(
        {
          subjectId: subject.id,
          intent: 'entry',
          action: 'clear',
          revision: entry.revision,
          idempotencyKey: crypto.randomUUID(),
        },
        previous,
      );
      return;
    }
    if (value === selectedState || !stateOptions.some(([state]) => state === value)) return;
    const next = value as LibraryEntryState;
    const previous = selectedState;
    setSelectedState(next);
    setPending(true);
    void writeEntry(
      {
        subjectId: subject.id,
        intent: 'entry',
        action: 'save',
        state: next,
        ...(entry ? { revision: entry.revision } : {}),
        idempotencyKey: crypto.randomUUID(),
      },
      previous,
    );
  }

  async function mutate(input: SubjectLibraryMutation) {
    if (!hydrated || pending) return;
    try {
      const response = await mutateSubjectLibrarySlot({
        data: input,
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      setActionResult(response.result);
    } catch {
      setActionResult('unavailable');
    }
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
        <Exposure operation="library_entry.put">
          <form
            data-library-entry
            method="get"
            action={action}
            onSubmit={(event) => event.preventDefault()}
            className="flex flex-wrap items-center gap-2"
          >
            <LibraryStateSelect
              busy={pending}
              disabled={!hydrated || pending}
              hasEntry={entry !== null}
              onChoose={choose}
              selectedState={selectedState}
              stateOptions={stateOptions}
            />
          </form>
        </Exposure>
      ) : null}

      {data.session === 'signed-in' ? (
        <Exposure operation="collection_member.create">
          <details
            data-add-to-collection
            open={collectionMenuOpen}
            onToggle={(event) => setCollectionMenuOpen(event.currentTarget.open)}
            className="relative"
          >
            <summary className={`${buttonClass} cursor-pointer list-none`}>
              {m.library_subject_add_collection()}
            </summary>
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
            </div>
          </details>
        </Exposure>
      ) : data.session === 'signed-out' ? (
        <Exposure operation="library_entry.put">
          <a
            data-library-sign-in
            className={primaryClass}
            href={`/auth/sign-in?return_to=${encodeURIComponent(action)}`}
          >
            {m.account_sign_in()}
          </a>
        </Exposure>
      ) : null}

      {data.session === 'signed-in' ? (
        <nav
          data-library-subject-links
          aria-label={m.library_subject_more_options()}
          className="mt-4 flex flex-col gap-2 border-t border-border pt-3 empty:hidden"
        >
          <Exposure operation="progress_session.create">
            <a className={linkClass} href={`/library/progress?subjectId=${encodeURIComponent(subject.id)}`}>
              {m.library_subject_start_progress()}
            </a>
          </Exposure>
          <Exposure operation="copy.list">
            <a className={linkClass} href={`/library/copies?subjectId=${encodeURIComponent(subject.id)}`}>
              {m.library_subject_your_copies()}
            </a>
          </Exposure>
        </nav>
      ) : null}
      {data.publicCollections ? (
        <Exposure operation="subject_collection.list">
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
        </Exposure>
      ) : null}
      {resultText ? (
        <p role="alert" className="basis-full text-sm text-muted-foreground">
          {resultText}
        </p>
      ) : null}
    </section>
  );
}
