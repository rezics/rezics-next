import type { CoverRatio } from '@rezics/ui/cover';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { MetaLine } from '@rezics/ui/meta-line';
import { ContentItem } from '@rezics/ui/content-item';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { useIsMobile } from '@rezics/ui/hooks/use-is-mobile';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Link } from '@tanstack/react-router';
import { useLayoutEffect, useId, useState, useRef, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Exposure, type GatedOperation } from '../kernel/exposure';
import { coverSubject, rowRatio, SubjectCover } from './subject-row';
import { displayLibraryTitle } from './title';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { createCopy, deleteCopy, updateCopy, readCopySubject, readCopyDetail } from './copies-actions';
import { copyStatusChange, type CopiesPageData, type CopyItem } from './copies-read';
import { subjectHref } from '../subject/subject-href';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';

import type { CopyProfile, CopySubjectResult } from './copies-profiles';
import { CopyConflictReview, type ConflictReview } from './copy-conflict-review';
import { CopyEditionPicker } from './copy-edition-picker';
import { CopyDraftNavigation, type CopyDraftNavigationHandle } from './copy-draft-navigation';
import { CopiesFallback } from './copies-fallback';
import { UndoNotice } from './copies-undo';
import type { CopyRemoved } from './copies-read';
import { undoCopy } from './copies-actions';
import { copyFieldInputIsTooLong } from './copy-field-input';
export { CopiesFallback } from './copies-fallback';
const inputClass =
  'min-h-11 min-w-0 max-w-full w-full rounded-lg border border-border bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const target =
  'min-h-11 min-w-11 max-w-full cursor-pointer whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const button = `${target} inline-flex items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60`;
const quiet = `${target} inline-flex items-center justify-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60`;
const locale = () => getLocale();
const dateText = (value: string) =>
  value
    ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
    : '';
const blank = (value: string): string | null => (value === '' ? null : value);

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type="date"
        lang={locale()}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function TextField({
  field,
  label,
  value,
  onChange,
  showError,
}: {
  field: 'location' | 'source';
  label: string;
  value: string;
  onChange: (value: string) => void;
  showError: boolean;
}) {
  const id = useId();
  const descriptionId = useId();
  const tooLong = showError && copyFieldInputIsTooLong(field, value);
  const description = tooLong
    ? field === 'location'
      ? m.library_copy_field_input_location_too_long()
      : m.library_copy_field_input_source_too_long()
    : field === 'location'
      ? m.library_copy_field_input_location_limit()
      : m.library_copy_field_input_source_limit();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        className={inputClass}
        value={value}
        aria-invalid={tooLong || undefined}
        aria-describedby={descriptionId}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <p id={descriptionId} role={tooLong ? 'alert' : undefined} className="text-sm text-muted-foreground">
        {description}
      </p>
    </Field>
  );
}

function NoteField({ value, onChange, showError }: {
  value: string;
  onChange: (value: string) => void;
  showError: boolean;
}) {
  const id = useId();
  const descriptionId = useId();
  const tooLong = showError && copyFieldInputIsTooLong('note', value);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{m.library_copy_note()}</FieldLabel>
      <Textarea
        id={id}
        className="min-h-28 min-w-0 max-w-full"
        rows={4}
        value={value}
        aria-invalid={tooLong || undefined}
        aria-describedby={descriptionId}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <p id={descriptionId} role={tooLong ? 'alert' : undefined} className="text-sm text-muted-foreground">
        {tooLong ? m.library_copy_field_input_note_too_long() : m.library_copy_field_input_note_limit()}
      </p>
    </Field>
  );
}

function ChoiceField({
  name,
  label,
  value,
  choices,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  choices: { id: string; label: string; labelLanguage?: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        name={name}
        className={`${inputClass} [&_select]:min-h-11`}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {choices.map((choice) => (
          <NativeSelectOption key={choice.id} value={choice.id} lang={choice.labelLanguage}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

type Draft = {
  status: string;
  location: string;
  source: string;
  acquiredOn: string;
  disposedOn: string;
  note: string;
};
const draftOf = (copy?: CopyItem): Draft => ({
  status: copy?.status ?? '',
  location: copy?.location ?? '',
  source: copy?.source ?? '',
  acquiredOn: copy?.acquiredOn ?? '',
  disposedOn: copy?.disposedOn ?? '',
  note: copy?.note ?? '',
});

/** Optional for pure stories; the actual route always supplies the originating private lifetime. */
export type CopiesOrigin = {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers: (operation?: GatedOperation) => HeadersInit | null;
  readDetail: (id: string) => ReturnType<typeof readCopyDetail>;
  readSubject: (id: string) => ReturnType<typeof readCopySubject>;
};

export function CopyForm({
  copy: initialCopy,
  profile,
  sendKind = false,
  inline = false,
  initialKind,
  detailState = 'ready',
  onRetryDetail,
  subjectId,
  addKey,
  onClose,
  onCreated,
  onSaved,
  onReviewed,
  onRemoved,
  onKey,
  originating,
}: {
  originating?: CopiesOrigin | undefined;
  copy?: CopyItem;
  profile?: CopyProfile | undefined;
  sendKind?: boolean | undefined;
  inline?: boolean;
  initialKind?: string;
  detailState?: 'loading' | 'ready' | 'unavailable' | 'forbidden';
  onRetryDetail?: (() => void) | undefined;
  subjectId: string | null;
  addKey: string;
  onClose: () => void;
  onCreated: (copy: CopyItem) => void;
  onSaved: (copy: CopyItem) => void;
  onReviewed?: ((copy: CopyItem) => void) | undefined;
  onRemoved: (id: string, result: CopyRemoved, deadline: number) => void;
  onKey: (key: string) => void;
}) {
  const [copy, setCopy] = useState(initialCopy);
  const [conflicted, setConflicted] = useState(false);
  const [review, setReview] = useState<ConflictReview>({ state: 'idle' });
  const reviewing = useRef(false);
  const mobile = useIsMobile();
  const lookup = useRef(0);
  const [edition, setEdition] = useState<EntityPickerSubject | null>(null);
  const [editionProfile, setEditionProfile] = useState<CopySubjectResult | { state: 'idle' | 'loading' }>({
    state: 'idle',
  });
  const binding = useRef<Extract<CopySubjectResult, { state: 'ready' }> | null>(null);
  const choices = subjectId
    ? profile
    : editionProfile.state === 'ready' && editionProfile.subject.id === edition?.id
      ? editionProfile.profile
      : undefined;
  const [kind, setKind] = useState(copy?.kind ?? initialKind ?? profile?.kinds[0]?.id ?? '');
  const selected = choices?.kinds.find((choice) => choice.id === kind);
  const readable = detailState !== 'forbidden';
  const editable = copy ? readable && detailState !== 'loading' : Boolean(selected?.statuses.length);
  const statusChoices = copy?.statusEditing?.state === 'supported' ? (copy.statusEditing.statuses ?? []) : [];
  const statusEditable = Boolean(copy && editable && statusChoices.length);
  const [draft, setDraft] = useState(() => ({
    ...draftOf(copy),
    status: copy?.status ?? selected?.statuses[0]?.id ?? '',
  }));
  const originalDraft = useRef({ draft, kind, editionId: edition?.id ?? null });
  const meaningfulChanges =
    (Object.keys(originalDraft.current.draft) as (keyof Draft)[]).some(
      (key) => draft[key] !== originalDraft.current.draft[key],
    ) ||
    (!copy && (kind !== originalDraft.current.kind || (edition?.id ?? null) !== originalDraft.current.editionId));
  const [more, setMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const moreId = useId();
  const confirmationId = useId();
  const deleteControl = useRef<HTMLButtonElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const departure = useRef<CopyDraftNavigationHandle>(null);
  const wasConfirming = useRef(false);
  useLayoutEffect(() => {
    if (confirming) cancelDelete.current?.focus();
    else if (wasConfirming.current) deleteControl.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const deleteStarted = useRef<number | null>(null);
  const active = useRef(true);
  const busy = useRef(false);
  const flight = useRef<{ current: () => boolean } | null>(null);
  // Uncertain retries reuse the exact captured payload, CAS and key even if fields or the page refresh.
  const intent = useRef<
    | ({
        data: Record<string, unknown>;
        headers: HeadersInit;
      } & (
        | { operation: 'create' | 'update'; send: typeof createCopy }
        | { operation: 'delete'; send: typeof deleteCopy }
      ))
    | null
  >(null);
  const current = (operation: GatedOperation = copy ? 'copy.get' : 'copy.create') =>
    active.current && (!originating || originating.isCurrent(operation));
  const headers = (operation: GatedOperation) => (originating ? originating.headers(operation) : csrfHeaders());
  if (flight.current && !flight.current.current()) {
    flight.current = null;
    busy.current = false;
    setPending(false);
  }
  const title = copy ? m.library_copy_edit() : m.library_copy_add();
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    current() && setDraft((draft) => ({ ...draft, [key]: value }));

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      lookup.current += 1;
    };
  }, []);
  function close() {
    if (!current()) return;
    active.current = false;
    lookup.current += 1;
    onClose();
  }
  function requestClose() {
    if (!current()) return;
    if (departure.current) departure.current.requestClose();
    else close();
  }

  async function chooseEdition(subject: EntityPickerSubject | null) {
    if (!current('copy.create') || busy.current || intent.current) return;
    const request = ++lookup.current;
    binding.current = null;
    setEdition(subject);
    setEditionProfile({ state: subject ? 'loading' : 'idle' });
    setKind('');
    change('status', '');
    setFailure(null);
    if (!subject) return;
    try {
      const result = await (originating ? originating.readSubject(subject.id) : readCopySubject({ data: subject.id }));
      if (!current('copy.create') || request !== lookup.current) return;
      // A point read for a different subject cannot certify this selected edition.
      if (result.state === 'ready' && result.subject.id !== subject.id) {
        setEditionProfile({ state: 'unavailable' });
        return;
      }
      setEditionProfile(result);
      if (result.state === 'ready') {
        binding.current = result;
        const first = result.profile.kinds.find((kind) => kind.statuses.length);
        setKind(first?.id ?? '');
        change('status', first?.statuses[0]?.id ?? '');
      }
    } catch {
      if (current('copy.create') && request === lookup.current) setEditionProfile({ state: 'unavailable' });
    }
  }

  async function reviewCurrent() {
    if (!copy || !conflicted || !current('copy.get') || busy.current || reviewing.current || intent.current) return;
    const request = ++lookup.current;
    reviewing.current = true;
    setReview({ state: 'loading' });
    try {
      const result = await (originating ? originating.readDetail(copy.id) : readCopyDetail({ data: { id: copy.id } }));
      if (!current('copy.get') || request !== lookup.current) return;
      setReview(
        result.ok
          ? result.copy.id === copy.id
            ? { state: 'ready', copy: result.copy }
            : { state: 'unavailable' }
          : { state: result.reason },
      );
    } catch {
      if (current('copy.get') && request === lookup.current) setReview({ state: 'unavailable' });
    } finally {
      if (current('copy.get') && request === lookup.current) reviewing.current = false;
    }
  }

  function acceptCurrent() {
    if (!current('copy.get') || !conflicted || review.state !== 'ready' || busy.current || intent.current) return;
    const accepted = review.copy;
    const request = lookup.current;
    const accept = () => {
      if (!current('copy.get') || request !== lookup.current || busy.current || intent.current) return;
      const next = { ...accepted, idempotencyKey: crypto.randomUUID() };
      const draft = draftOf(next);
      setCopy(next);
      setDraft(draft);
      setKind(next.kind ?? '');
      originalDraft.current = { draft, kind: next.kind ?? '', editionId: null };
      deleteStarted.current = null;
      setConfirming(false);
      setConflicted(false);
      setFailure(null);
      setReview({ state: 'idle' });
      onReviewed?.(next);
    };
    // Reuse the single existing departure choice when accepting would discard a draft.
    if (departure.current) departure.current.requestClose(accept, m.library_copy_conflict_review_discard());
    else if (!meaningfulChanges) accept();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const operation = copy ? 'copy.update' : 'copy.create';
    if (
      !current(operation) ||
      busy.current ||
      conflicted ||
      confirming ||
      !editable ||
      intent.current?.operation === 'delete'
    )
      return;
    if (!intent.current) {
      const invalid = (['location', 'source', 'note'] as const).some((field) =>
        copyFieldInputIsTooLong(field, draft[field]),
      );
      if (invalid) {
        setShowFieldErrors(true);
        return;
      }
    }
    const editionBinding = binding.current;
    const credentialHeaders = headers(operation);
    if (!credentialHeaders) return;
    if (!intent.current) {
      if (!copy && !subjectId && (!edition || editionBinding?.subject.id !== edition.id)) return;
      if (!copy && !selected?.statuses.some((status) => status.id === draft.status)) return;
      const fields = {
        location: blank(draft.location),
        source: blank(draft.source),
        acquiredOn: blank(draft.acquiredOn),
        disposedOn: blank(draft.disposedOn),
        note: blank(draft.note),
      };
      const status = copy ? copyStatusChange(copy, draft.status) : undefined;
      if (copy && !status) {
        setFailure(m.library_copy_failure());
        return;
      }
      intent.current = copy
        ? {
            operation: 'update',
            headers: new Headers(credentialHeaders),
            send: updateCopy,
            data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey, ...status, ...fields },
          }
        : {
            operation: 'create',
            headers: new Headers(credentialHeaders),
            send: createCopy,
            data: {
              subjectId: subjectId ?? editionBinding!.subject.id,
              idempotencyKey: addKey,
              ...(sendKind ? { kind } : {}),
              status: draft.status,
              ...fields,
            },
          };
    }
    const captured = intent.current;
    if (!current(operation)) return;
    const lease = { current: () => current(operation) };
    flight.current = lease;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      const result = await captured.send({ data: captured.data, headers: captured.headers });
      if (!current(operation)) return;
      if (!result.ok) {
        if (result.reason !== 'unavailable') intent.current = null;
        if (copy && result.reason === 'conflict') setConflicted(true);
        setFailure(
          result.reason === 'conflict'
            ? m.library_copy_conflict()
            : result.reason === 'unsupported'
              ? m.library_copy_unsupported()
              : result.reason === 'closed'
                ? m.library_copy_lookup_closed()
                : result.reason === 'forbidden'
                  ? m.library_copy_lookup_forbidden()
                  : m.library_copy_failure(),
        );
        return;
      }
      if (copy) {
        if (result.copy.id !== copy.id) {
          setFailure(m.library_copy_failure());
          return;
        }
        if (!current(operation)) return;
        onSaved({
          ...copy,
          status: result.copy.status,
          ...(result.copy.status === copy.status
            ? {}
            : {
                statusLabel: undefined,
                statusLabelLanguage: undefined,
                meaning: 'unavailable' as const,
                statusEditing: { state: 'unavailable' as const },
              }),
          revision: result.copy.revision,
          location: result.copy.location,
          source: result.copy.source,
          acquiredOn: result.copy.acquiredOn,
          disposedOn: result.copy.disposedOn,
          note: result.copy.note,
          idempotencyKey: crypto.randomUUID(),
        });
      } else {
        if (!current(operation)) return;
        onCreated({
          ...result.copy,
          kind: result.copy.kind ?? null,
          subject:
            editionBinding && edition
              ? {
                  ...editionBinding.subject,
                  cover: edition.cover ?? editionBinding.subject.cover,
                  typeLabel: edition.typeLabel,
                }
              : null,
          meaning: 'unavailable',
          statusEditing: { state: 'unavailable' },
          idempotencyKey: crypto.randomUUID(),
        });
        if (!current(operation)) return;
        onKey(crypto.randomUUID());
      }
      if (!current(operation)) return;
      intent.current = null;
      close();
    } catch {
      if (current(operation)) setFailure(m.library_copy_failure());
    } finally {
      if (current(operation) && flight.current === lease) {
        flight.current = null;
        busy.current = false;
        setPending(false);
      }
    }
  }

  async function remove() {
    if (
      !current('copy.delete') ||
      !copy ||
      !editable ||
      conflicted ||
      busy.current ||
      (intent.current && intent.current.operation !== 'delete')
    )
      return;
    const credentialHeaders = headers('copy.delete');
    if (!current('copy.delete') || !credentialHeaders) return;
    intent.current ??= {
      operation: 'delete',
      headers: new Headers(credentialHeaders),
      send: deleteCopy,
      data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey },
    };
    const lease = { current: () => current('copy.delete') };
    flight.current = lease;
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      deleteStarted.current ??= Date.now();
      const captured = intent.current;
      if (captured.operation !== 'delete') return;
      const result = await captured.send({ data: captured.data, headers: captured.headers });
      if (!current('copy.delete')) return;
      if (!result.ok) {
        if (result.reason !== 'unavailable') intent.current = null;
        if (result.reason === 'conflict') setConflicted(true);
        setFailure(result.reason === 'conflict' ? m.library_copy_conflict() : m.library_copy_failure());
        setConfirming(false);
        return;
      }
      onRemoved(copy.id, result, deleteStarted.current + 30_000);
      if (!current('copy.delete')) return;
      intent.current = null;
      close();
    } catch {
      if (current('copy.delete')) {
        setFailure(m.library_copy_failure());
        setConfirming(false);
      }
    } finally {
      if (current('copy.delete') && flight.current === lease) {
        flight.current = null;
        busy.current = false;
        setPending(false);
      }
    }
  }

  const content: ReactNode = !readable ? (
    <div className="space-y-4">
      <p role="alert">{m.library_copy_detail_forbidden()}</p>
      <button type="button" className={quiet} onClick={requestClose}>
        {m.library_copy_cancel()}
      </button>
    </div>
  ) : (
    <form
      method="post"
      action={`/${locale()}/library/copies`}
      aria-label={title}
      data-idempotency-key={copy?.idempotencyKey ?? addKey}
      onSubmit={submit}
      className="min-w-0 max-w-full space-y-4 [overflow-wrap:anywhere] [&_input]:min-h-11 [&_input]:min-w-0 [&_input]:text-base [&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:min-h-11"
      aria-busy={pending}
      onKeyDown={(event) => {
        if (confirming && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (current()) setConfirming(false);
        }
      }}
    >
      <input type="hidden" name="intent" value={copy ? 'update' : 'create'} />
      <input type="hidden" name="idempotencyKey" value={copy?.idempotencyKey ?? addKey} />
      <input
        type="hidden"
        name="subjectId"
        value={subjectId ?? (editionProfile.state === 'ready' ? (edition?.id ?? '') : '')}
      />
      <input type="hidden" name="sendKind" value={String(sendKind)} />
      {!copy && !subjectId ? (
        <CopyEditionPicker value={edition} disabled={pending} onChange={(subject) => void chooseEdition(subject)} />
      ) : null}
      {!copy && !subjectId && editionProfile.state !== 'idle' && editionProfile.state !== 'ready' ? (
        <div className="space-y-2">
          <p role="status">
            {editionProfile.state === 'loading'
              ? m.library_copy_profile_loading()
              : editionProfile.state === 'unsupported'
                ? m.library_copy_unsupported()
                : editionProfile.state === 'forbidden'
                  ? m.library_copy_profile_forbidden()
                  : editionProfile.state === 'closed'
                    ? m.library_copy_lookup_closed()
                    : m.library_copy_profile_unavailable()}
          </p>
          {edition && editionProfile.state === 'unavailable' ? (
            <button type="button" className={quiet} disabled={pending} onClick={() => void chooseEdition(edition)}>
              {m.subject_view_retry()}
            </button>
          ) : null}
        </div>
      ) : null}
      {!copy && selected ? (
        choices!.kinds.length > 1 ? (
          <ChoiceField
            name="kind"
            label={m.library_copy_kind()}
            value={kind}
            choices={choices!.kinds}
            onChange={(value) => {
              if (!current() || intent.current) return;
              setKind(value);
              change('status', choices!.kinds.find((item) => item.id === value)?.statuses[0]?.id ?? '');
            }}
          />
        ) : (
          <input type="hidden" name="kind" value={kind} />
        )
      ) : null}
      {copy ? (
        <div className="space-y-3">
          <dl className="space-y-2">
            <div>
              <dt className="text-sm text-muted-foreground">{m.library_copy_kind()}</dt>
              <dd>
                <span lang={copy.kindLabelLanguage}>{copy.kindLabel ?? copy.kind ?? m.library_other()}</span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{m.library_copy_status()}</dt>
              <dd>
                <span lang={copy.statusLabelLanguage}>{copy.statusLabel ?? copy.status}</span>
              </dd>
            </div>
          </dl>
          {copy.meaning !== 'known' ? (
            <p className="text-sm text-muted-foreground">
              {copy.meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable()}
            </p>
          ) : null}
          {detailState === 'loading' ? <p role="status">{m.library_copy_detail_loading()}</p> : null}
          {detailState === 'unavailable' ? (
            <div className="space-y-2">
              <p role="status">{m.library_copy_detail_unavailable()}</p>
              {onRetryDetail && !conflicted ? (
                <button
                  type="button"
                  className={quiet}
                  disabled={pending || !!intent.current}
                  onClick={() => current('copy.get') && !intent.current && onRetryDetail()}
                >
                  {m.subject_view_retry()}
                </button>
              ) : null}
            </div>
          ) : null}
          {statusEditable ? (
            <>
              <p className="text-sm text-muted-foreground">{m.library_current_choices()}</p>
              <ChoiceField
                name="status"
                label={m.library_copy_new_status()}
                value={draft.status}
                choices={[
                  { id: copy.status, label: copy.statusLabel ?? copy.status },
                  ...statusChoices.filter((status) => status.id !== copy.status),
                ]}
                onChange={(value) => change('status', value)}
              />
            </>
          ) : detailState !== 'loading' ? (
            <p className="text-sm text-muted-foreground">
              {copy.statusEditing?.state === 'unsupported'
                ? m.library_copy_status_unsupported()
                : m.library_copy_status_unavailable()}
            </p>
          ) : null}
        </div>
      ) : selected ? (
        <ChoiceField
          name="status"
          label={m.library_copy_status()}
          value={draft.status}
          choices={selected.statuses}
          onChange={(value) => change('status', value)}
        />
      ) : null}
      {editable ? (
        <>
          <button
            type="button"
            className={`${target} text-left text-sm text-primary underline underline-offset-4`}
            aria-controls={moreId}
            aria-expanded={more}
            onClick={() => current() && setMore(!more)}
          >
            {more ? m.library_copy_less() : m.library_copy_more()}
          </button>
          <div id={moreId} hidden={!more} className="min-w-0 space-y-4">
            <TextField
              field="location"
              label={m.library_copy_location()}
              value={draft.location}
              onChange={(value) => change('location', value)}
              showError={showFieldErrors}
            />
            <TextField
              field="source"
              label={m.library_copy_source()}
              value={draft.source}
              onChange={(value) => change('source', value)}
              showError={showFieldErrors}
            />
            <DateField
              label={m.library_copy_acquired()}
              value={draft.acquiredOn}
              onChange={(value) => change('acquiredOn', value)}
            />
            <DateField
              label={m.library_copy_disposed()}
              value={draft.disposedOn}
              onChange={(value) => change('disposedOn', value)}
            />
            <NoteField value={draft.note} onChange={(value) => change('note', value)} showError={showFieldErrors} />
          </div>
        </>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {conflicted ? (
        <CopyConflictReview
          review={review}
          disabled={!current('copy.get') || pending || confirming || !!intent.current}
          onReview={() => void reviewCurrent()}
          onAccept={acceptCurrent}
        />
      ) : null}
      {confirming ? (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby={confirmationId}
          className="min-w-0 space-y-3 rounded-lg border border-border p-4"
        >
          <p id={confirmationId}>{m.library_copy_delete_question()}</p>
          <div className="flex flex-wrap gap-3">
            <button
              ref={cancelDelete}
              type="button"
              className={quiet}
              onClick={() => current() && setConfirming(false)}
            >
              {m.library_copy_cancel()}
            </button>
            <button type="button" className={button} disabled={pending} onClick={() => void remove()}>
              {m.library_copy_delete_confirm()}
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {editable ? (
          <button
            type="submit"
            className={button}
            disabled={pending || conflicted || !headers(copy ? 'copy.update' : 'copy.create')}
          >
            {copy ? m.library_copy_save() : m.library_copy_add_submit()}
          </button>
        ) : null}
        {copy ? (
          <button
            type="button"
            ref={deleteControl}
            className={quiet}
            disabled={pending || conflicted || !editable || !headers('copy.delete')}
            onClick={() =>
              current() && (!intent.current || intent.current.operation === 'delete') && setConfirming(true)
            }
          >
            {m.library_copy_delete()}
          </button>
        ) : null}
        <button type="button" className={quiet} onClick={requestClose}>
          {m.library_copy_cancel()}
        </button>
      </div>
    </form>
  );

  const navigation = (
    <CopyDraftNavigation
      ref={departure}
      authorized={current()}
      dirty={meaningfulChanges}
      locked={pending || intent.current !== null}
      routeProtection={Boolean(originating)}
      onDiscard={close}
    />
  );
  if (inline)
    return (
      <>
        {navigation}
        {content}
      </>
    );
  return (
    <Exposure operation={copy ? 'copy.get' : 'copy.create'}>
      {navigation}
      {mobile ? (
        <BottomSheet open onOpenChange={(open) => !open && requestClose()} title={title}>
          {content}
        </BottomSheet>
      ) : (
        <Dialog open onOpenChange={(open) => !open && requestClose()}>
          <DialogContent className="[&_[data-slot=dialog-close]]:min-h-11 [&_[data-slot=dialog-close]]:min-w-11">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            {content}
          </DialogContent>
        </Dialog>
      )}
    </Exposure>
  );
}

const hasUnresolvedHistory = (copy: CopyItem) => copy.meaning !== 'known' || !copy.kindLabel || !copy.statusLabel;

function CopyTextReader({
  label,
  value,
  expandLabel,
  collapseLabel,
}: {
  label: string;
  value: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="min-w-0 max-w-full text-sm text-muted-foreground">
      <p id={`${id}-label`} className="font-medium">
        {label}
      </p>
      <p
        id={id}
        className={`min-w-0 max-w-full whitespace-break-spaces [overflow-wrap:anywhere] ${expanded ? '' : 'line-clamp-2'}`}
      >
        {value}
      </p>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        className="min-h-11 max-w-full cursor-pointer rounded-md py-2 text-left whitespace-normal text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? collapseLabel : expandLabel}
      </button>
    </div>
  );
}

function CopyRow({ copy, onEdit, ratio }: { copy: CopyItem; onEdit: () => void; ratio: CoverRatio }) {
  const pageLocale = locale();
  const localizedTitle = copy.subject ? displayLibraryTitle(copy.subject.label, pageLocale) : null;
  const href = copy.subject ? subjectHref({ id: copy.subject.id, label: localizedTitle!.text }, pageLocale) : null;
  const title = localizedTitle?.text ?? m.library_subject_unavailable();
  const kind =
    copy.subject?.typeLabel ??
    copy.subject?.types?.[0]
      ?.split(/[:/#]/)
      .at(-1)
      ?.replace(/^./u, (letter) => letter.toLocaleUpperCase(locale())) ??
    '';
  return (
    <ContentItem
      title={title}
      {...(localizedTitle?.lang === undefined ? {} : { titleLang: localizedTitle.lang })}
      {...(href ? { href: href.href } : {})}
      headingLevel={2}
      className="py-4"
      visual={
        <div className="w-[72px] shrink-0 sm:w-24">
          <SubjectCover subject={copy.subject} ratio={ratio} size="fill" />
        </div>
      }
      metadata={
        <div className="w-full min-w-0">
          <p className="text-sm text-muted-foreground">
            <MetaLine
              items={[
                kind,
                copy.kindLabel ? <span lang={copy.kindLabelLanguage}>{copy.kindLabel}</span> : null,
                copy.statusLabel ? <span lang={copy.statusLabelLanguage}>{copy.statusLabel}</span> : null,
              ]}
            />
          </p>
          {copy.acquiredOn ? (
            <p className="text-sm text-muted-foreground">
              <span>{m.library_copy_acquired()}: </span>
              <span className="whitespace-nowrap">{dateText(copy.acquiredOn)}</span>
            </p>
          ) : null}
          {copy.location ? (
            <CopyTextReader
              label={m.library_copy_location()}
              value={copy.location}
              expandLabel={m.library_copy_note_reader_expand_location()}
              collapseLabel={m.library_copy_note_reader_collapse_location()}
            />
          ) : null}
          {copy.source ? (
            <CopyTextReader
              label={m.library_copy_source()}
              value={copy.source}
              expandLabel={m.library_copy_note_reader_expand_source()}
              collapseLabel={m.library_copy_note_reader_collapse_source()}
            />
          ) : null}
          {copy.disposedOn ? (
            <p className="text-sm text-muted-foreground">
              <span>{m.library_copy_disposed()}: </span>
              <span className="whitespace-nowrap">{dateText(copy.disposedOn)}</span>
            </p>
          ) : null}
          {copy.note ? (
            <CopyTextReader
              label={m.library_copy_note()}
              value={copy.note}
              expandLabel={m.library_copy_note_reader_expand_note()}
              collapseLabel={m.library_copy_note_reader_collapse_note()}
            />
          ) : null}
          {hasUnresolvedHistory(copy) ? (
            <div className="mt-2">
              <details className="text-sm">
                <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {m.library_copy_history_details()}
                </summary>
                <div className="space-y-2 pt-2 text-muted-foreground">
                  <p>
                    {copy.meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable()}
                  </p>
                  <dl className="space-y-2">
                    <div>
                      <dt>{m.library_copy_kind()}</dt>
                      <dd className="break-all text-foreground">
                        <code>{copy.kind ?? 'null'}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{m.library_copy_status()}</dt>
                      <dd className="break-all text-foreground">
                        <code>{copy.status}</code>
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </div>
          ) : null}
        </div>
      }
      trailing={
        <Menu
          title={m.library_copy_more_actions()}
          trigger={
            <button
              type="button"
              className="inline-flex size-11 items-center justify-center rounded-full hover:bg-muted"
              aria-label={m.library_copy_more_actions()}
            >
              <EllipsisIcon aria-hidden="true" className="size-5" />
            </button>
          }
          entries={[
            {
              type: 'item',
              label: m.library_copy_edit(),
              onSelect: onEdit,
            },
          ]}
        />
      }
    />
  );
}

export function CopiesPage({
  page,
  failure,
  originating,
}: {
  page: CopiesPageData;
  failure?: string | undefined;
  originating?: CopiesOrigin | undefined;
}) {
  const [loaded, setLoaded] = useState({ page, generation: 0 });
  // Reset the whole page lifetime before rendering replacement loader data, including editors and Undo.
  if (!originating && loaded.page !== page) setLoaded({ page, generation: loaded.generation + 1 });
  return <LoadedCopiesPage key={loaded.generation} page={page} failure={failure} originating={originating} />;
}

function LoadedCopiesPage({
  page,
  failure,
  originating,
}: {
  page: CopiesPageData;
  failure?: string | undefined;
  originating?: CopiesOrigin | undefined;
}) {
  const [copies, setCopies] = useState(page.copies);
  const [changed, setChanged] = useState(false);
  const previousPage = useRef(page);
  if (originating && previousPage.current !== page) {
    previousPage.current = page;
    setCopies(page.copies);
    setChanged(false);
  }
  const [addKey, setAddKey] = useState(page.addKey);
  const [removed, setRemoved] = useState<{ copy: CopyItem; result: CopyRemoved; deadline: number } | null>(null);
  const [editing, setEditing] = useState<CopyItem | null | undefined>(undefined);
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'unavailable' | 'forbidden'>('ready');
  const inspection = useRef(0);
  const active = useRef(true);
  const latestRemoval = useRef(removed);
  const restoreIntent = useRef<{
    removal: typeof removed;
    data: { id: string; deletionId: string; revision: number; idempotencyKey: string };
    headers: HeadersInit;
    send: typeof undoCopy;
  } | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      inspection.current += 1;
    };
  }, []);
  const currentPage = (operation?: GatedOperation) =>
    active.current && (!originating || originating.isCurrent(operation));
  const currentEditor = (operation: GatedOperation = editing ? 'copy.get' : 'copy.create') =>
    currentPage(operation) && editorKey === inspection.current;
  const closeEditor = () => {
    if (!currentEditor()) return;
    inspection.current += 1;
    setEditing(undefined);
  };
  async function inspect(copy: CopyItem) {
    if (!currentPage('copy.get')) return;
    const current = ++inspection.current;
    setEditorKey(current);
    setEditing({
      ...copy,
      kindLabel: undefined,
      statusLabel: undefined,
      kindLabelLanguage: undefined,
      statusLabelLanguage: undefined,
      meaning: 'unavailable',
      statusEditing: { state: 'unavailable' },
    });
    setDetailState('loading');
    try {
      const result = await (originating ? originating.readDetail(copy.id) : readCopyDetail({ data: { id: copy.id } }));
      if (!currentPage('copy.get') || current !== inspection.current) return;
      if (result.ok && result.copy.id !== copy.id) {
        setDetailState('unavailable');
        return;
      }
      if (result.ok) {
        setEditing(result.copy);
        setDetailState('ready');
      } else {
        setDetailState(result.reason);
        if (result.reason === 'forbidden') {
          // Keep only the previously readable raw row; never retain point-detail presentation after denial.
          setCopies((copies) =>
            copies.map((item) =>
              item.id !== copy.id
                ? item
                : {
                    ...item,
                    kindLabel: undefined,
                    statusLabel: undefined,
                    kindLabelLanguage: undefined,
                    statusLabelLanguage: undefined,
                    meaning: undefined,
                    statusEditing: undefined,
                  },
            ),
          );
        }
      }
    } catch {
      if (currentPage('copy.get') && current === inspection.current) setDetailState('unavailable');
    }
  }
  const filteredLabel = page.copies.find((copy) => copy.subject?.id === page.subjectId)?.subject?.label;
  const filteredTitle = filteredLabel ? displayLibraryTitle(filteredLabel, locale()).text : undefined;
  const firstPageEmpty = !page.requestedCursor && !page.next && !page.copies.length && !changed;
  const recoverable = Boolean(page.requestedCursor) || (!copies.length && !firstPageEmpty);
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_copy_heading()}</PageHeading>
        {!page.subjectId || page.profile?.kinds.length ? (
          <button
            type="button"
            className={button}
            onClick={() => {
              if (!currentPage('copy.create')) return;
              setEditorKey(++inspection.current);
              setDetailState('ready');
              setEditing(null);
            }}
          >
            {m.library_copy_add()}
          </button>
        ) : null}
      </header>
      {page.cursorRestarted ? <p role="status">{m.library_copies_address_cursor_restarted()}</p> : null}
      {failure ? (
        <p role="alert">{failure === 'unsupported' ? m.library_copy_unsupported() : m.library_copy_failure()}</p>
      ) : null}
      {page.subjectId && !page.profile?.kinds.length ? (
        <p role="status" className="text-muted-foreground">
          {m.library_copy_unsupported()}
        </p>
      ) : null}
      <noscript>
        <CopiesFallback page={page} csrfToken={page.csrfToken} />
      </noscript>
      {page.subjectId ? (
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span>{m.library_copy_filtered_heading({ title: filteredTitle ?? m.library_copy_this_edition() })}</span>
          <Exposure operation="copy.list">
            <Link
              to="/library/copies"
              onClick={(event) => {
                if (!currentPage()) event.preventDefault();
              }}
              search={{}}
              className="text-primary underline underline-offset-4"
            >
              {m.library_copy_all()}
            </Link>
          </Exposure>
        </p>
      ) : null}
      {copies.length ? (
        <>
          {copies.some(hasUnresolvedHistory) ? (
            <p className="text-sm text-muted-foreground">{m.library_copy_history_notice()}</p>
          ) : null}
          <ul className="m-0 list-none p-0">
            {copies.map((copy) => (
              <CopyRow
                key={`${copy.id}:${copy.revision}`}
                copy={copy}
                ratio={rowRatio([copy.subject])}
                onEdit={() => void inspect(copy)}
              />
            ))}
          </ul>
        </>
      ) : (
        <p role="status" className="text-muted-foreground">
          {firstPageEmpty
            ? page.subjectId
              ? m.library_copy_filtered_empty()
              : m.library_copy_empty()
            : m.library_copy_page_empty()}
        </p>
      )}
      {page.next || recoverable ? (
        <Exposure operation="copy.list">
          <nav aria-label={m.library_copy_heading()} className="flex flex-wrap gap-3">
            {recoverable ? (
              <Link
                to="/library/copies"
                search={{ ...(page.subjectId ? { subjectId: page.subjectId } : {}) }}
                onClick={(event) => {
                  if (!currentPage('copy.list')) event.preventDefault();
                }}
                className={`${quiet} text-primary`}
              >
                {m.library_collections_first_page()}
              </Link>
            ) : null}
            {page.next ? (
              <Link
                to="/library/copies"
                onClick={(event) => {
                  if (!currentPage()) event.preventDefault();
                }}
                search={{ ...(page.subjectId ? { subjectId: page.subjectId } : {}), cursor: page.next }}
                className={`${quiet} text-primary`}
              >
                {m.library_copy_more()}
              </Link>
            ) : null}
          </nav>
        </Exposure>
      ) : null}
      {removed ? (
        <UndoNotice
          key={`${removed.copy.id}:${removed.deadline}`}
          message={m.library_removed()}
          deadline={removed.deadline}
          available={Boolean(removed.result.undo)}
          operation="copy.update"
          failure={m.library_copy_failure()}
          restore={async (idempotencyKey) => {
            if (
              !currentPage('copy.update') ||
              latestRemoval.current !== removed ||
              !removed.result.undo ||
              Date.now() >= removed.deadline
            )
              return false;
            const headers = originating ? originating.headers('copy.update') : csrfHeaders();
            if (!currentPage('copy.update') || !headers) return false;
            try {
              if (restoreIntent.current?.removal !== removed)
                restoreIntent.current = {
                  removal: removed,
                  data: { id: removed.copy.id, ...removed.result.undo, idempotencyKey },
                  headers: new Headers(headers),
                  send: undoCopy,
                };
              const captured = restoreIntent.current;
              const result = await captured.send({ data: captured.data, headers: captured.headers });
              if (!result.ok && result.reason !== 'unavailable' && restoreIntent.current === captured)
                restoreIntent.current = null;
              if (!currentPage('copy.update') || !result.ok || result.copy.id !== removed.copy.id) return false;
              setChanged(true);
              setCopies((current) => [
                { ...removed.copy, ...result.copy, idempotencyKey: crypto.randomUUID() },
                ...current,
              ]);
              // A newer same-page deletion keeps its own Undo when this restore finishes later.
              if (currentPage('copy.update') && latestRemoval.current === removed) {
                latestRemoval.current = null;
                setRemoved(null);
              }
              return true;
            } catch {
              if (!currentPage('copy.update')) return false;
              return false;
            }
          }}
        />
      ) : null}
      {editing !== undefined ? (
        <CopyForm
          key={`${editorKey}:${detailState}`}
          originating={{
            isCurrent: currentEditor,
            headers: (operation) =>
              currentEditor(operation) ? (originating ? originating.headers(operation) : csrfHeaders()) : null,
            readDetail: (id) => (originating ? originating.readDetail(id) : readCopyDetail({ data: { id } })),
            readSubject: (id) => (originating ? originating.readSubject(id) : readCopySubject({ data: id })),
          }}
          detailState={detailState}
          onRetryDetail={editing ? () => void inspect(editing) : undefined}
          {...(editing ? { copy: editing } : {})}
          profile={editing ? undefined : page.profile}
          sendKind={page.sendKind}
          subjectId={page.subjectId}
          addKey={addKey}
          onClose={closeEditor}
          onKey={(key) => {
            if (currentEditor()) setAddKey(key);
          }}
          onCreated={(copy) => {
            if (!currentEditor()) return;
            setChanged(true);
            setCopies((current) => [
              ...current,
              {
                ...copy,
                subject: copy.subject ?? current.find((item) => item.subject?.id === page.subjectId)?.subject ?? null,
                idempotencyKey: crypto.randomUUID(),
              },
            ]);
          }}
          onSaved={(next) => {
            if (currentEditor('copy.update'))
              setCopies((current) => current.map((item) => (item.id === next.id ? next : item)));
          }}
          onReviewed={(next) => {
            if (currentEditor('copy.get'))
              setCopies((current) => current.map((item) => (item.id === next.id ? next : item)));
          }}
          onRemoved={(id, result, deadline) => {
            if (!currentEditor('copy.delete')) return;
            setChanged(true);
            const copy = copies.find((item) => item.id === id);
            if (copy) {
              latestRemoval.current = { copy, result, deadline };
              setRemoved(latestRemoval.current);
            }
            setCopies((current) => current.filter((item) => item.id !== id));
          }}
        />
      ) : null}
    </div>
  );
}
