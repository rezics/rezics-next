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
import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { LibraryStateChoice } from '../profiles';
import type { SubjectSlotEntry, SubjectLibraryMutationResponse, LibraryEntryStateWrite } from '../subject-slot';
import type { SlotLifetime } from '../subject-library-current-origin';
import type { SubjectReference } from '../subject-ref';

const primaryClass = buttonVariants({ variant: 'default' });
const secondaryClass = buttonVariants({ variant: 'outline' });
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const unknownStateValue = '__library_unknown_received_state__';
const removeStateValue = 'remove';

export type EntryStateBasis = {
  subjectId: string;
  state: string;
  revision: number;
  incarnationId: string | null | undefined;
} | null;

export type ReviewedEntryState = {
  subjectId: string;
  subjectLabel: string;
  state: LibraryEntryStateWrite;
  stateLabel: string;
  stateLabelLanguage: string;
  basis: EntryStateBasis;
  originKey: string;
  lifetime: SlotLifetime;
};

export type EntryStateConflictIntent = {
  state: string;
  stateLabel: string;
  stateLabelLanguage: string;
  originKey: string;
  hasAcceptedBasis: boolean;
  acceptedEntry?: SubjectSlotEntry | null;
};

type Draft =
  | {
      kind: 'state';
      state: LibraryEntryStateWrite;
      label: string;
      language: string;
      basis: EntryStateBasis;
      originKey: string;
      lifetime: SlotLifetime;
      subject: SubjectReference;
    }
  | {
      kind: 'keep-current';
      state: string;
      label: string;
      language: string;
      basis: Exclude<EntryStateBasis, null>;
      originKey: string;
      lifetime: SlotLifetime;
      subject: SubjectReference;
    };

export function captureEntryStateBasis(entry: SubjectSlotEntry | null): EntryStateBasis {
  if (!entry) return null;
  return {
    subjectId: entry.subjectId,
    state: entry.state,
    revision: entry.revision,
    incarnationId: entry.incarnationId,
  };
}

export function entryStateBasisMatches(basis: EntryStateBasis, entry: SubjectSlotEntry | null): boolean {
  if (basis === null) return entry === null;
  return (
    entry !== null &&
    basis.subjectId === entry.subjectId &&
    basis.state === entry.state &&
    basis.revision === entry.revision &&
    basis.incarnationId === entry.incarnationId
  );
}

type Props = {
  subject: SubjectReference;
  entry: SubjectSlotEntry | null;
  receivedLabel: string;
  stateOptions: readonly LibraryStateChoice[];
  canRemove: boolean;
  originKey: string;
  lifetime: SlotLifetime;
  disabled: boolean;
  busy: boolean;
  uncertain: boolean;
  conflict: EntryStateConflictIntent | null;
  onSave: (review: ReviewedEntryState) => Promise<SubjectLibraryMutationResponse | undefined>;
  onRemove: () => void;
  onDismissConflict: () => void;
};

type SelectChoice = { value: string; label: string; disabled?: boolean };

function LibraryStateSelect({
  disabled,
  busy,
  entry,
  receivedLabel,
  draft,
  stateOptions,
  canRemove,
  onChoose,
  onRemove,
  control,
}: {
  disabled: boolean;
  busy: boolean;
  entry: SubjectSlotEntry | null;
  receivedLabel: string;
  draft: Draft | null;
  stateOptions: readonly LibraryStateChoice[];
  canRemove: boolean;
  onChoose: (value: string) => void;
  onRemove: () => void;
  control: (node: HTMLDivElement | null) => void;
}) {
  const selectedState = draft?.state ?? entry?.state ?? '';
  const knownState = stateOptions.some(({ id }) => id === selectedState);
  const unknownLabel = draft?.label ?? receivedLabel;
  const choices: SelectChoice[] = [
    ...(!knownState && entry && selectedState
      ? [{ value: unknownStateValue, label: unknownLabel, disabled: true }]
      : []),
    ...stateOptions.map(({ id, label }) => ({ value: id, label: label.text })),
    ...(entry && canRemove ? [{ value: removeStateValue, label: m.library_subject_remove() }] : []),
  ];
  const value = selectedState ? (knownState ? selectedState : unknownStateValue) : null;

  return (
    <div ref={control} data-entry-state-control className="min-w-0 max-w-full">
      <Select
        disabled={disabled}
        items={choices.map(({ value: choice, label }) => ({ value: choice, label }))}
        onValueChange={(next) => {
          if (next === removeStateValue) onRemove();
          else onChoose(next ?? '');
        }}
        value={value}
      >
        <SelectTrigger
          aria-busy={busy ? true : undefined}
          aria-label={m.library_subject_entry()}
          data-entry-state-trigger
          className={`${primaryClass} h-auto min-h-[44px] max-w-full whitespace-normal [overflow-wrap:anywhere]`}
        >
          {busy ? <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          <SelectValue placeholder={m.library_subject_add()} />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {choices.map((choice) => (
            <Fragment key={choice.value}>
              {choice.value === removeStateValue ? <SelectSeparator /> : null}
              <SelectItem disabled={choice.disabled} value={choice.value}>
                {choice.label}
              </SelectItem>
            </Fragment>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ReceivedValue({ entry, label }: { entry: SubjectSlotEntry | null; label: string }) {
  return <span data-entry-state-received-value>{entry ? label : m.library_entry_review_absent()}</span>;
}

function ReviewValues({ draft, receivedLabel }: { draft: Draft; receivedLabel: string }) {
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
      <dt className="font-medium text-muted-foreground">{m.library_entry_review_subject()}</dt>
      <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">{draft.subject.label}</dd>
      <dt className="font-medium text-muted-foreground">{m.library_entry_review_reference()}</dt>
      <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
        <code>{draft.subject.id}</code>
      </dd>
      <dt className="font-medium text-muted-foreground">{m.library_entry_review_received()}</dt>
      <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
        <ReceivedValue entry={draft.basis ? { ...draft.basis } : null} label={receivedLabel} />
      </dd>
      <dt className="font-medium text-muted-foreground">{m.library_entry_review_proposed()}</dt>
      <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">{draft.label}</dd>
    </dl>
  );
}

function ConflictReview({
  conflict,
  entry,
  receivedLabel,
  canReview,
  onReview,
}: {
  conflict: EntryStateConflictIntent;
  entry: SubjectSlotEntry | null;
  receivedLabel: string;
  canReview: boolean;
  onReview: () => void;
}) {
  return (
    <div
      data-entry-state-conflict
      role="status"
      className="min-w-0 max-w-2xl basis-full rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]"
    >
      <p className="m-0 font-medium">{m.library_conflict()}</p>
      {conflict.hasAcceptedBasis ? (
        <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="font-medium text-muted-foreground">{m.library_entry_review_received()}</dt>
          <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">
            <ReceivedValue entry={entry} label={receivedLabel} />
          </dd>
          <dt className="font-medium text-muted-foreground">{m.library_entry_review_proposed()}</dt>
          <dd className="m-0 min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">{conflict.stateLabel}</dd>
        </dl>
      ) : (
        <p className="mt-2 mb-0">{m.library_entry_review_conflict_unavailable()}</p>
      )}
      {canReview ? (
        <button type="button" className={`${secondaryClass} mt-3 max-w-full whitespace-normal ${focusClass}`} onClick={onReview}>
          {m.library_entry_review_conflict_review()}
        </button>
      ) : null}
    </div>
  );
}

/** A private, unsent state choice and its final confirmation inside the existing Subject Library slot. */
export function SubjectEntryStateReview({
  subject,
  entry,
  receivedLabel,
  stateOptions,
  canRemove,
  originKey,
  lifetime,
  disabled,
  busy,
  uncertain,
  conflict,
  onSave,
  onRemove,
  onDismissConflict,
}: Props) {
  const headingId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stage, setStage] = useState<'edit' | 'review' | null>(null);
  const [notice, setNotice] = useState<'no-change' | null>(null);
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState(originKey);
  const savingFlight = useRef(false);
  const restoreControlFocus = useRef(false);
  const focusReviewHeading = useRef(false);
  const control = useRef<HTMLDivElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const currentSource = useRef(originKey);
  const currentLifetime = useRef(lifetime);
  const currentBasis = captureEntryStateBasis(entry);
  currentSource.current = originKey;
  currentLifetime.current = lifetime;

  if (source !== originKey) {
    setSource(originKey);
    setDraft(null);
    setStage(null);
    setNotice(null);
    setSaving(false);
    savingFlight.current = false;
    restoreControlFocus.current = false;
    focusReviewHeading.current = false;
  }
  if (draft && (draft.originKey !== originKey || draft.lifetime !== lifetime || !entryStateBasisMatches(draft.basis, entry))) {
    setDraft(null);
    setStage(null);
    setNotice(null);
    setSaving(false);
    savingFlight.current = false;
    restoreControlFocus.current = false;
    focusReviewHeading.current = false;
  }

  useLayoutEffect(() => {
    if (focusReviewHeading.current && draft && stage === 'review') {
      focusReviewHeading.current = false;
      heading.current?.focus();
      return;
    }
    if (!restoreControlFocus.current || draft || stage) return;
    restoreControlFocus.current = false;
    if (lifetime.current('library_entry.get', 'library_entry.put'))
      control.current?.querySelector<HTMLButtonElement>('[data-entry-state-trigger]')?.focus();
  }, [draft, stage, lifetime]);

  const current = () =>
    !disabled &&
    !busy &&
    !uncertain &&
    lifetime.current('library_entry.get', 'library_entry.put') &&
    entryStateBasisMatches(currentBasis, entry);

  function captureChoice(choice: Extract<Draft, { kind: 'state' }>['state'], label: string, language: string) {
    if (!current() || !stateOptions.some((option) => option.id === choice && option.label.text === label && option.label.lang === language))
      return;
    setNotice(null);
    setDraft({
      kind: 'state',
      state: choice,
      label,
      language,
      basis: currentBasis,
      originKey,
      lifetime,
      subject,
    });
    setStage('review');
    focusReviewHeading.current = true;
    onDismissConflict();
  }

  function choose(value: string) {
    if (value === removeStateValue) {
      onRemove();
      return;
    }
    const option = stateOptions.find(({ id }) => id === value);
    if (!option) return;
    captureChoice(value as LibraryEntryStateWrite, option.label.text, option.label.lang);
  }

  function keepCurrent() {
    if (!entry || !current()) return;
    setNotice(null);
    setDraft({
      kind: 'keep-current',
      state: entry.state,
      label: receivedLabel,
      language: '',
      basis: currentBasis as Exclude<EntryStateBasis, null>,
      originKey,
      lifetime,
      subject,
    });
    setStage('review');
    focusReviewHeading.current = true;
    onDismissConflict();
  }

  function editChoice() {
    if (!draft || !current()) return;
    setStage('edit');
    restoreControlFocus.current = true;
  }

  function discardChoice() {
    setDraft(null);
    setStage(null);
    setNotice(null);
    restoreControlFocus.current = true;
    onDismissConflict();
  }

  async function saveChoice() {
    if (!draft || stage !== 'review' || savingFlight.current || !current()) return;
    if (draft.kind === 'keep-current' || (entry && draft.state === entry.state)) {
      setDraft(null);
      setStage(null);
      setNotice('no-change');
      restoreControlFocus.current = true;
      onDismissConflict();
      return;
    }
    const choice = stateOptions.find(
      ({ id, label }) => id === draft.state && label.text === draft.label && label.lang === draft.language,
    );
    if (!choice) {
      discardChoice();
      return;
    }
    savingFlight.current = true;
    setSaving(true);
    restoreControlFocus.current = true;
    try {
      await onSave({
        subjectId: subject.id,
        subjectLabel: subject.label,
        state: draft.state,
        stateLabel: draft.label,
        stateLabelLanguage: draft.language,
        basis: draft.basis,
        originKey: draft.originKey,
        lifetime: draft.lifetime,
      });
      if (draft.originKey === currentSource.current && draft.lifetime === currentLifetime.current) {
        setDraft(null);
        setStage(null);
      }
    } finally {
      if (draft.originKey === currentSource.current && draft.lifetime === currentLifetime.current) {
        savingFlight.current = false;
        setSaving(false);
      }
    }
  }

  function reviewConflictAgain() {
    if (
      !conflict ||
      !conflict.hasAcceptedBasis ||
      conflict.originKey !== originKey ||
      !entryStateBasisMatches(captureEntryStateBasis(conflict.acceptedEntry ?? null), entry)
    )
      return;
    const choice = stateOptions.find(({ id }) => id === conflict.state);
    if (!choice || choice.label.text !== conflict.stateLabel || choice.label.lang !== conflict.stateLabelLanguage) return;
    captureChoice(choice.id as LibraryEntryStateWrite, choice.label.text, choice.label.lang);
  }

  const conflictCurrent =
    conflict?.originKey === originKey &&
    conflict.hasAcceptedBasis &&
    entryStateBasisMatches(captureEntryStateBasis(conflict.acceptedEntry ?? null), entry);
  const conflictChoice = conflict && stateOptions.find(({ id, label }) =>
    id === conflict.state && label.text === conflict.stateLabel && label.lang === conflict.stateLabelLanguage,
  );
  const canReviewConflict =
    !!conflict && !!conflictCurrent && !!conflictChoice && !disabled && !busy && !uncertain &&
    lifetime.current('library_entry.get', 'library_entry.put');

  return (
    <div
      data-library-entry
      data-entry-state-review
      className="flex min-w-0 max-w-full flex-wrap items-start gap-2"
    >
      {draft && stage === 'review' ? (
        <section
          aria-labelledby={headingId}
          data-entry-state-review-card
          className="min-w-0 max-w-2xl basis-full rounded-md border border-border p-3 [overflow-wrap:anywhere]"
        >
          <h3 ref={heading} id={headingId} tabIndex={-1} className="m-0 text-sm font-semibold">
            {m.library_entry_review_heading()}
          </h3>
          <ReviewValues draft={draft} receivedLabel={receivedLabel} />
          {draft.kind === 'keep-current' || (entry && draft.state === entry.state) ? (
            <p data-entry-state-no-change className="mt-3 mb-0 text-sm" role="status" aria-live="polite">
              {m.library_entry_review_no_change_prompt()}
            </p>
          ) : null}
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${primaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
              disabled={disabled || busy || uncertain || saving || !lifetime.current('library_entry.get', 'library_entry.put')}
              onClick={() => void saveChoice()}
            >
              {saving || busy ? <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              {draft.kind === 'keep-current' || (entry && draft.state === entry.state)
                ? m.library_entry_review_no_change_confirm()
                : m.library_entry_review_save()}
            </button>
            <button
              type="button"
              className={`${secondaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
              disabled={disabled || busy || uncertain || saving}
              onClick={editChoice}
            >
              {m.library_entry_review_edit()}
            </button>
            <button
              type="button"
              className={`${secondaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
              disabled={saving}
              onClick={discardChoice}
            >
              {m.library_entry_review_discard()}
            </button>
          </div>
        </section>
      ) : null}

      {!draft || stage === 'edit' ? (
        <>
          <LibraryStateSelect
            disabled={disabled || busy || uncertain || saving}
            busy={busy || saving}
            entry={entry}
            receivedLabel={receivedLabel}
            draft={draft}
            stateOptions={stateOptions}
            canRemove={canRemove}
            onChoose={choose}
            onRemove={onRemove}
            control={(node) => (control.current = node)}
          />
          {draft && stage === 'edit' ? (
            <div className="flex min-w-0 max-w-2xl basis-full flex-wrap items-center gap-2" data-entry-state-editing>
              <p className="m-0 min-w-0 break-words text-sm [overflow-wrap:anywhere]">
                <span className="font-medium">{m.library_entry_review_proposed()}: </span>
                {draft.label}
              </p>
              <button
                type="button"
                className={`${primaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
                disabled={disabled || busy || uncertain || saving}
                onClick={() => {
                  if (draft.originKey !== originKey || draft.lifetime !== lifetime || !entryStateBasisMatches(draft.basis, entry))
                    return discardChoice();
                  setStage('review');
                  focusReviewHeading.current = true;
                }}
              >
                {m.library_entry_review_review_choice()}
              </button>
              <button
                type="button"
                className={`${secondaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
                disabled={saving}
                onClick={discardChoice}
              >
                {m.library_entry_review_discard()}
              </button>
            </div>
          ) : null}
          {!draft && entry && !uncertain ? (
            <button
              type="button"
              className={`${secondaryClass} min-h-[44px] max-w-full whitespace-normal ${focusClass}`}
              disabled={disabled || busy || saving}
              onClick={keepCurrent}
            >
              {m.library_entry_review_keep_current()}
            </button>
          ) : null}
        </>
      ) : null}

      {notice === 'no-change' ? (
        <p data-entry-state-no-change-result className="m-0 basis-full text-sm" role="status" aria-live="polite">
          {m.library_entry_review_no_change_result()}
        </p>
      ) : null}

      {!draft && conflict && conflict.originKey === originKey ? (
        <ConflictReview
          conflict={conflict}
          entry={conflict.hasAcceptedBasis && conflictCurrent ? entry : null}
          receivedLabel={receivedLabel}
          canReview={canReviewConflict}
          onReview={reviewConflictAgain}
        />
      ) : null}
    </div>
  );
}
