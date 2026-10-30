import { Toaster } from '@rezics/ui/shadcn/toast';
import { EntryUndoForm, EntryRemoveForm, EntryRestoreFeedback } from './entry-undo';
import { Exposure, useOperation } from '../kernel/exposure';
import { undoToast } from '@rezics/ui/undo-toast';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { useQueryClient } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@rezics/ui/shadcn/select';
import { Loader2Icon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { SubjectLabelNotice } from './subject-labels.tsx';
import { subjectHref } from '../subject/subject-href';
import { AccountRef } from './account-ref';
import { SubjectRef } from './subject-ref';
import type { SubjectReference } from './subject-ref';
import {
  mutateSubjectLabelAction,
  mutateSubjectLibrarySlot,
  readSubjectLibraryCollections,
  searchSubjectLabelsAction,
  restoreSubjectLibrarySlot,
} from './subject-slot-actions';
import type {
  LibraryEntryStateWrite,
  SubjectLibraryMutation,
  SubjectLibraryMutationResponse,
  SubjectLibrarySlotData,
} from './subject-slot';
import { subjectSlotStateLabel } from './subject-slot';
import { normalizeLibraryLabelName, type LibraryLabelSummary, type SubjectLabel } from './subject-labels.ts';

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
const otherStateValue = '__library_other__';

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
  selectedState: string;
  stateOptions: readonly (readonly [LibraryEntryStateWrite, string])[];
  onChoose: (value: string) => void;
}) {
  const knownState = stateOptions.some(([value]) => value === selectedState);
  const choices = [
    ...(hasEntry && selectedState && !knownState
      ? [{ value: otherStateValue, label: subjectSlotStateLabel(selectedState) }]
      : []),
    ...stateOptions.map(([value, label]) => ({ value, label })),
    ...(hasEntry ? [{ value: removeValue, label: m.library_subject_remove() }] : []),
  ];
  return (
    <Select
      disabled={disabled}
      items={choices}
      onValueChange={(value) => onChoose(value ?? '')}
      value={selectedState ? (knownState ? selectedState : otherStateValue) : null}
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
  const queryClient = useQueryClient();
  const action = subjectHref({ id: subject.id, label: subject.label }, locale).href;
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionResult, setActionResult] = useState(data.result);
  const initialEntry =
    data.restore?.ok || data.restore?.reason === 'occupied' ? (data.restore.entry ?? null) : data.entry;
  const [entry, setEntry] = useState(initialEntry);
  const [selectedState, setSelectedState] = useState(initialEntry?.state ?? '');
  const [removeKey] = useState(() => crypto.randomUUID());
  const [collections, setCollections] = useState(data.collections);
  const [collectionsLoaded, setCollectionsLoaded] = useState(data.collectionsLoaded);
  const [collectionsProblem, setCollectionsProblem] = useState<'closed' | 'unavailable' | null>(null);
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(data.collectionsLoaded);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const restoreAdmitted = useOperation('library_entry.restore');
  const [labels, setLabels] = useState(data.labels ?? []);
  const [labelQuery, setLabelQuery] = useState('');
  const [labelChoices, setLabelChoices] = useState<LibraryLabelSummary[]>([]);
  const [labelSearchState, setLabelSearchState] = useState<'idle' | 'loaded' | 'closed' | 'unavailable' | 'signed-out'>(
    'idle',
  );
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [labelPending, setLabelPending] = useState(false);
  const [labelNotice, setLabelNotice] = useState(data.labelResult);
  const [labelUndo, setLabelUndo] = useState(data.labelUndo);
  const latestLabelQuery = useRef('');
  const stateOptions = [
    ['planned', m.library_subject_state_planned()],
    ['in_progress', m.library_subject_state_in_progress()],
    ['completed', m.library_subject_state_completed()],
    ['paused', m.library_subject_state_paused()],
    ['dropped', m.library_subject_state_dropped()],
  ] as const;
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    const loadedEntry =
      data.restore?.ok || data.restore?.reason === 'occupied' ? (data.restore.entry ?? null) : data.entry;
    setEntry(loadedEntry);
    setSelectedState(loadedEntry?.state ?? '');
    setCollections(data.collections);
    setCollectionsLoaded(data.collectionsLoaded);
  }, [data.entry, data.restore, data.collections, data.collectionsLoaded]);
  useEffect(() => setLabels(data.labels ?? []), [data.labels]);
  useEffect(() => {
    setLabelNotice(data.labelResult);
    setLabelUndo(data.labelUndo);
  }, [data.labelResult, data.labelUndo]);
  useEffect(() => {
    if (!hydrated || !labelPickerOpen || data.session !== 'signed-in') return;
    let current = true;
    const query = labelQuery;
    const timeout = setTimeout(() => {
      void searchSubjectLabelsAction({ data: { query } })
        .then((response) => {
          if (!current || latestLabelQuery.current !== query) return;
          setLabelChoices(response.labels);
          setLabelSearchState(response.state);
        })
        .catch(() => {
          if (current && latestLabelQuery.current === query) setLabelSearchState('unavailable');
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [data.session, hydrated, labelPickerOpen, labelQuery]);
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

  function applyEntryResult(response: SubjectLibraryMutationResponse, previous: string) {
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
      if (response.undo && restoreAdmitted) {
        const receipt = response.undo;
        undoToast(
          m.library_removed(),
          () => {
            void restoreSubjectLibrarySlot({
              data: { subjectId: subject.id, ...receipt },
              headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
            })
              .then((restored) => {
                void queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] });
                if (restored.ok) {
                  setEntry(restored.entry);
                  setSelectedState(restored.entry.state);
                  setActionResult('saved');
                  setRestoreMessage(null);
                } else if (restored.reason === 'occupied') {
                  if (restored.entry) {
                    setEntry(restored.entry);
                    setSelectedState(restored.entry.state);
                  }
                  setActionResult(undefined);
                  setRestoreMessage(m.library_restore_occupied());
                } else if (restored.reason === 'stale') setRestoreMessage(m.library_restore_stale());
                else if (restored.reason === 'expired') setRestoreMessage(m.library_restore_expired());
                else setRestoreMessage(m.library_subject_unavailable());
              })
              .catch(() => setRestoreMessage(m.library_subject_unavailable()));
          },
          { undo: m.editor_undo() },
        );
      }
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

  async function writeEntry(input: SubjectLibraryMutation, previous: string) {
    try {
      const response = await mutateSubjectLibrarySlot({
        data: input,
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      applyEntryResult(response, previous);
      if (
        response.result === 'saved' ||
        response.result === 'cleared' ||
        (response.result === 'conflict' && 'entry' in response)
      ) {
        queryClient.setQueryData(
          ['subject-library', subject.id, locale],
          (current: SubjectLibrarySlotData | undefined) =>
            current ? { ...current, entryAvailable: true, entry: response.entry ?? null } : current,
        );
      }
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
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
          idempotencyKey: crypto.randomUUID(),
        },
        previous,
      );
      return;
    }
    if (value === selectedState || !stateOptions.some(([state]) => state === value)) return;
    const next = value as LibraryEntryStateWrite;
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
        ...(entry?.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
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
      await queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] });
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

  function labelFailure(reason: string) {
    if (reason === 'capacity') setLabelNotice('label-capacity');
    else if (reason === 'restore-stale') {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] }),
        router.invalidate(),
      ]).then(() => setLabelNotice('label-restore-stale'));
    } else if (reason === 'restore-expired') setLabelNotice('label-restore-expired');
    else if (reason === 'restore-occupied') setLabelNotice('label-restore-occupied');
    else if (reason === 'restore-capacity') setLabelNotice('label-restore-capacity');
    else if (reason === 'closed') setLabelNotice('closed');
    else setLabelNotice('unavailable');
  }

  async function writeLabel(input: {
    intent: 'assign' | 'create-and-assign' | 'restore';
    label?: LibraryLabelSummary | SubjectLabel;
    name?: string;
    assignment?: SubjectLabel;
    revision?: number;
  }) {
    if (!hydrated || labelPending) return;
    setLabelPending(true);
    setLabelNotice(undefined);
    try {
      const headers = { 'X-CSRF-Token': data.csrfToken ?? '' };
      const response =
        input.intent === 'create-and-assign'
          ? await mutateSubjectLabelAction({
              data: {
                intent: 'create-and-assign',
                subjectId: subject.id,
                name: input.name ?? '',
                createKey: crypto.randomUUID(),
                idempotencyKey: crypto.randomUUID(),
              },
              headers,
            })
          : input.intent === 'assign'
            ? await mutateSubjectLabelAction({
                data: {
                  intent: 'assign',
                  subjectId: subject.id,
                  labelId: input.label && 'labelId' in input.label ? input.label.labelId : (input.label?.id ?? ''),
                  idempotencyKey: crypto.randomUUID(),
                },
                headers,
              })
            : await mutateSubjectLabelAction({
                data: {
                  intent: 'restore',
                  subjectId: subject.id,
                  labelId: input.label && 'labelId' in input.label ? input.label.labelId : (input.label?.id ?? ''),
                  assignmentId: input.assignment?.id ?? '',
                  revision: input.revision ?? 0,
                  idempotencyKey: crypto.randomUUID(),
                },
                headers,
              });
      if (!response.ok) {
        labelFailure(response.reason);
        return;
      }
      setLabelUndo(undefined);
      setLabelPickerOpen(false);
      setLabelQuery('');
      latestLabelQuery.current = '';
      setLabelChoices([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] }),
        router.invalidate(),
      ]);
    } catch {
      setLabelNotice('unavailable');
    } finally {
      setLabelPending(false);
    }
  }

  async function submitLabelName(event: FormEvent<HTMLFormElement>) {
    if (!hydrated) return;
    event.preventDefault();
    const name = normalizeLibraryLabelName(labelQuery);
    if (!name) return;
    const existing = labelChoices.find((candidate) => normalizeLibraryLabelName(candidate.name) === name);
    if (existing) await writeLabel({ intent: 'assign', label: existing });
    else await writeLabel({ intent: 'create-and-assign', name: labelQuery });
  }

  async function removeLabel(label: SubjectLabel) {
    if (labelPending) return;
    setLabelPending(true);
    try {
      const response = await mutateSubjectLabelAction({
        data: {
          intent: 'unassign',
          subjectId: subject.id,
          labelId: label.labelId,
          assignmentId: label.id,
          revision: label.revision,
          idempotencyKey: crypto.randomUUID(),
        },
        headers: { 'X-CSRF-Token': data.csrfToken ?? '' },
      });
      if (!response.ok) {
        labelFailure(response.reason);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['subject-library', subject.id, locale] }),
        router.invalidate(),
      ]);
      const restoreRevision = response.restoreRevision;
      if (restoreRevision === undefined) {
        setLabelNotice('unavailable');
        return;
      }
      undoToast(
        m.library_subject_label_removed({ name: label.name }),
        () =>
          void writeLabel({
            intent: 'restore',
            label: { id: label.labelId, name: label.name, revision: 1 },
            assignment: label,
            revision: restoreRevision,
          }),
        { undo: m.library_subject_label_undo() },
      );
    } catch {
      setLabelNotice('unavailable');
    } finally {
      setLabelPending(false);
    }
  }

  function onRemoveForm(event: FormEvent<HTMLFormElement>, label: SubjectLabel) {
    if (!hydrated) return;
    event.preventDefault();
    void removeLabel(label);
  }

  return (
    <Toaster>
      <section aria-label={m.library_subject_heading()} className="flex flex-wrap items-center gap-2">
        {data.undo ? (
          <EntryUndoForm undo={data.undo} locale={locale} csrfToken={data.csrfToken} returnTo={action} />
        ) : null}
        {data.restore ? <EntryRestoreFeedback restore={data.restore} locale={locale} /> : null}
        {entry && data.session === 'signed-in' ? (
          <noscript>
            <EntryRemoveForm
              subjectId={subject.id}
              revision={entry.revision}
              {...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId })}
              idempotencyKey={removeKey}
              locale={locale}
              csrfToken={data.csrfToken}
              returnTo={action}
            />
          </noscript>
        ) : null}
        {data.session === 'signed-in' && data.entryAvailable ? (
          <Exposure operation="library_entry.put">
            <form
              data-library-entry
              method="get"
              action={action}
              onSubmit={(event) => event.preventDefault()}
              className="flex flex-wrap items-center gap-2"
            >
              <input type="hidden" name="subjectId" value={subject.id} />
              {entry ? <input type="hidden" name="revision" value={entry.revision} /> : null}
              {typeof entry?.incarnationId === 'string' ? (
                <input type="hidden" name="incarnationId" value={entry.incarnationId} />
              ) : null}
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
        {data.session === 'signed-in' && data.labels !== null ? (
          <Exposure operation="library_label.assignment_list">
            <div data-subject-labels className="basis-full space-y-2">
              {labels.length ? (
                <ul className="flex flex-wrap items-center gap-2">
                  {labels.map((label) => (
                    <li
                      key={label.id}
                      data-subject-label-chip
                      className="inline-flex min-w-0 items-center gap-1 rounded-full border bg-muted/60 px-3 py-1 text-sm"
                    >
                      <a
                        href={`/${encodeURIComponent(locale)}/library?label=${encodeURIComponent(label.labelId)}`}
                        className="max-w-48 truncate text-primary underline-offset-4 hover:underline"
                      >
                        {label.name}
                      </a>
                      <Exposure operation="library_label.unassign">
                        <form
                          data-subject-label-remove
                          method="post"
                          action={action}
                          onSubmit={(event) => onRemoveForm(event, label)}
                          className="m-0"
                        >
                          <input type="hidden" name="intent" value="unassign" />
                          <input type="hidden" name="subjectId" value={subject.id} />
                          <input type="hidden" name="labelId" value={label.labelId} />
                          <input type="hidden" name="assignmentId" value={label.id} />
                          <input type="hidden" name="revision" value={label.revision} />
                          <input type="hidden" name="csrf_token" value={data.csrfToken ?? ''} />
                          <button
                            type="submit"
                            disabled={hydrated && labelPending}
                            aria-label={m.library_subject_label_remove({ name: label.name })}
                            className="rounded-full px-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
                          >
                            ×
                          </button>
                        </form>
                      </Exposure>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Exposure operation="library_label.list">
                <details
                  data-subject-label-picker-details
                  open={labelPickerOpen}
                  onToggle={(event) => setLabelPickerOpen(event.currentTarget.open)}
                  className="max-w-md"
                >
                  <summary className={`${buttonClass} cursor-pointer list-none`}>
                    {m.library_subject_label_add()}
                  </summary>
                  <form
                    data-subject-label-picker
                    method="post"
                    action={action}
                    onSubmit={(event) => void submitLabelName(event)}
                    className="mt-2 space-y-2 rounded-lg border bg-background p-3"
                  >
                    <input type="hidden" name="intent" value="assign-by-name" />
                    <input type="hidden" name="subjectId" value={subject.id} />
                    <input type="hidden" name="csrf_token" value={data.csrfToken ?? ''} />
                    <label className="grid gap-1 text-sm font-medium">
                      {m.library_subject_label_input()}
                      <input
                        name="name"
                        aria-label={m.library_subject_label_name()}
                        autoComplete="off"
                        maxLength={200}
                        required
                        value={labelQuery}
                        onChange={(event) => {
                          latestLabelQuery.current = event.currentTarget.value;
                          setLabelQuery(event.currentTarget.value);
                        }}
                        className="h-9 rounded-md border bg-background px-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Exposure operation="library_label.create">
                        <button type="submit" disabled={hydrated && labelPending} className={buttonClass}>
                          {m.library_subject_label_add()}
                        </button>
                      </Exposure>
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => {
                          setLabelPickerOpen(false);
                          setLabelQuery('');
                          latestLabelQuery.current = '';
                        }}
                      >
                        {m.library_collection_cancel()}
                      </button>
                    </div>
                    {labelSearchState === 'loaded' ? (
                      <ul aria-label={m.library_subject_label_input()} className="space-y-1">
                        {labelChoices.map((choice) => (
                          <li key={choice.id}>
                            <Exposure operation="library_label.assign">
                              <button
                                type="button"
                                disabled={hydrated && labelPending}
                                onClick={() => void writeLabel({ intent: 'assign', label: choice })}
                                className="w-full rounded px-2 py-1 text-start text-sm hover:bg-muted disabled:opacity-50"
                              >
                                {choice.name}
                              </button>
                            </Exposure>
                          </li>
                        ))}
                        {normalizeLibraryLabelName(labelQuery) &&
                        !labelChoices.some(
                          (choice) => normalizeLibraryLabelName(choice.name) === normalizeLibraryLabelName(labelQuery),
                        ) ? (
                          <li>
                            <Exposure operation="library_label.create">
                              <button
                                type="button"
                                disabled={hydrated && labelPending}
                                onClick={() => void writeLabel({ intent: 'create-and-assign', name: labelQuery })}
                                className="w-full rounded px-2 py-1 text-start text-sm font-medium text-primary hover:bg-muted disabled:opacity-50"
                              >
                                {m.library_subject_label_create({ name: normalizeLibraryLabelName(labelQuery) })}
                              </button>
                            </Exposure>
                          </li>
                        ) : null}
                        {labelChoices.length === 0 ? (
                          <li className="px-2 py-1 text-sm text-muted-foreground">
                            {m.library_subject_label_no_results()}
                          </li>
                        ) : null}
                      </ul>
                    ) : labelSearchState === 'closed' ? (
                      <p role="status" className="text-sm text-muted-foreground">
                        {m.library_subject_label_closed()}
                      </p>
                    ) : labelSearchState === 'unavailable' ? (
                      <p role="alert" className="text-sm text-muted-foreground">
                        {m.library_subject_label_unavailable()}
                      </p>
                    ) : null}
                  </form>
                </details>
              </Exposure>
              <SubjectLabelNotice {...(labelNotice !== undefined ? { result: labelNotice } : {})} />
              {labelUndo ? (
                <form data-label-undo method="post" action={action} className="flex items-center gap-2 text-sm">
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="subjectId" value={subject.id} />
                  <input type="hidden" name="labelId" value={labelUndo.labelId} />
                  <input type="hidden" name="assignmentId" value={labelUndo.assignmentId} />
                  <input type="hidden" name="revision" value={labelUndo.revision} />
                  <input type="hidden" name="csrf_token" value={data.csrfToken ?? ''} />
                  <span>{m.library_subject_label_removed_status()}</span>
                  <button type="submit" className={linkClass}>
                    {m.library_subject_label_undo()}
                  </button>
                </form>
              ) : null}
            </div>
          </Exposure>
        ) : null}
        {resultText ? (
          <p role="alert" className="basis-full text-sm text-muted-foreground">
            {resultText}
          </p>
        ) : null}
        {restoreMessage ? (
          <p role="status" className="basis-full text-sm text-muted-foreground">
            {restoreMessage}
          </p>
        ) : null}
      </section>
    </Toaster>
  );
}
