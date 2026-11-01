import type { CoverRatio } from '@rezics/ui/cover';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { MetaLine } from '@rezics/ui/meta-line';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Calendar } from '@rezics/ui/shadcn/calendar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@rezics/ui/shadcn/popover';
import { useIsMobile } from '@rezics/ui/hooks/use-is-mobile';
import { de, enUS, es, fr, ja, ko, zhCN, zhTW } from 'date-fns/locale';
import { CalendarDays } from 'lucide-react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState, useRef, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Exposure } from '../kernel/exposure';
import { coverSubject, rowRatio, SubjectCover } from './subject-row';
import { displayLibraryTitle, LibraryTitle } from './title';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { createCopy, deleteCopy, updateCopy, readCopySubject, readCopyDetail } from './copies-actions';
import { copyStatusChange, type CopiesPageData, type CopyItem } from './copies-read';
import { subjectHref } from '../subject/subject-href';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';

import type { CopyProfile, CopySubjectResult } from './copies-profiles';
import { CopyEditionPicker } from './copy-edition-picker';
import { CopiesFallback } from './copies-fallback';
import { UndoNotice } from './copies-undo';
import type { CopyRemoved } from './copies-read';
import { undoCopy } from './copies-actions';
export { CopiesFallback } from './copies-fallback';
const inputClass =
  'min-h-11 w-full rounded-lg border border-border bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const button =
  'inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60';
const quiet =
  'inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60';
const locales = { de, en: enUS, es, fr, ja, ko, 'zh-Hans': zhCN, 'zh-Hant': zhTW } as const;
const locale = () => getLocale();
const calendarLocale = () => locales[locale() as keyof typeof locales] ?? enUS;
const dateValue = (value: string) => (value ? new Date(`${value}T12:00:00`) : undefined);
const dateText = (value: string) =>
  value
    ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
    : '';
const blank = (value: string): string | null => (value === '' ? null : value);

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const selected = dateValue(value);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          render={
            <button type="button" className={`${inputClass} flex items-center justify-between text-left font-normal`} />
          }
        >
          <span>{selected ? dateText(value) : m.library_copy_choose_date()}</span>
          <CalendarDays aria-hidden="true" className="size-4 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            locale={calendarLocale()}
            selected={selected}
            onSelect={(date) => {
              onChange(
                date
                  ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
                  : '',
              );
              setOpen(false);
            }}
            labels={{ labelDayButton: (date) => new Intl.DateTimeFormat(locale(), { dateStyle: 'full' }).format(date) }}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        className={inputClass}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
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
        className={inputClass}
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

export function CopyForm({
  copy,
  profile,
  sendKind = false,
  inline = false,
  initialKind,
  detailState = 'ready',
  subjectId,
  addKey,
  onClose,
  onCreated,
  onSaved,
  onRemoved,
  onKey,
}: {
  copy?: CopyItem;
  profile?: CopyProfile | undefined;
  sendKind?: boolean | undefined;
  inline?: boolean;
  initialKind?: string;
  detailState?: 'loading' | 'ready' | 'unavailable' | 'forbidden';
  subjectId: string | null;
  addKey: string;
  onClose: () => void;
  onCreated: (copy: CopyItem) => void;
  onSaved: (copy: CopyItem) => void;
  onRemoved: (id: string, result: CopyRemoved, deadline: number) => void;
  onKey: (key: string) => void;
}) {
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
  const [more, setMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const deleteStarted = useRef<number | null>(null);
  const deleting = useRef(false);
  const title = copy ? m.library_copy_edit() : m.library_copy_add();
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(
    () => () => {
      lookup.current += 1;
    },
    [],
  );

  async function chooseEdition(subject: EntityPickerSubject | null) {
    const current = ++lookup.current;
    binding.current = null;
    setEdition(subject);
    setEditionProfile({ state: subject ? 'loading' : 'idle' });
    setKind('');
    change('status', '');
    setFailure(null);
    if (!subject) return;
    try {
      const result = await readCopySubject({ data: subject.id });
      if (current !== lookup.current) return;
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
      if (current === lookup.current) setEditionProfile({ state: 'unavailable' });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editable) return;
    const editionBinding = binding.current;
    if (!copy && !subjectId && (!edition || editionBinding?.subject.id !== edition.id)) return;
    if (!copy && !selected?.statuses.some((status) => status.id === draft.status)) return;
    setPending(true);
    setFailure(null);
    try {
      const fields = {
        location: blank(draft.location),
        source: blank(draft.source),
        acquiredOn: blank(draft.acquiredOn),
        disposedOn: blank(draft.disposedOn),
        note: blank(draft.note),
      };
      if (copy) {
        const status = copyStatusChange(copy, draft.status);
        if (!status) {
          setFailure(m.library_copy_failure());
          return;
        }
        const result = await updateCopy({
          data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey, ...status, ...fields },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
          setFailure(
            result.reason === 'conflict'
              ? m.library_copy_conflict()
              : result.reason === 'unsupported'
                ? m.library_copy_unsupported()
                : m.library_copy_failure(),
          );
          return;
        }
        onSaved({
          ...copy,
          status: result.copy.status,
          ...(result.copy.status === copy.status
            ? {}
            : {
                // A write response without presentation cannot certify new accepted labels.
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
        const result = await createCopy({
          data: {
            subjectId: subjectId ?? editionBinding!.subject.id,
            idempotencyKey: addKey,
            ...(sendKind ? { kind } : {}),
            status: draft.status,
            ...fields,
          },
          headers: csrfHeaders(),
        });
        if (!result.ok) {
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
        onKey(crypto.randomUUID());
      }
      onClose();
    } catch {
      setFailure(m.library_copy_failure());
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!copy || !editable || pending || deleting.current) return;
    deleting.current = true;
    setPending(true);
    setFailure(null);
    try {
      deleteStarted.current ??= Date.now();
      const result = await deleteCopy({
        data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setFailure(result.reason === 'conflict' ? m.library_copy_conflict() : m.library_copy_failure());
        setConfirming(false);
        return;
      }
      onRemoved(copy.id, result, deleteStarted.current + 30_000);
      onClose();
    } catch {
      setFailure(m.library_copy_failure());
      setConfirming(false);
    } finally {
      deleting.current = false;
      setPending(false);
    }
  }

  const content: ReactNode = !readable ? (
    <div className="space-y-4">
      <p role="alert">{m.library_copy_detail_forbidden()}</p>
      <button type="button" className={quiet} onClick={onClose}>
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
      className="space-y-4"
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
          {detailState === 'unavailable' ? <p role="status">{m.library_copy_detail_unavailable()}</p> : null}
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
            className="text-sm text-primary underline underline-offset-4"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            {more ? m.library_copy_less() : m.library_copy_more()}
          </button>
          {more ? (
            <div className="space-y-4">
              <TextField
                label={m.library_copy_location()}
                value={draft.location}
                onChange={(value) => change('location', value)}
              />
              <TextField
                label={m.library_copy_source()}
                value={draft.source}
                onChange={(value) => change('source', value)}
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
              <TextField label={m.library_copy_note()} value={draft.note} onChange={(value) => change('note', value)} />
            </div>
          ) : null}
        </>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {confirming ? (
        <div role="alertdialog" className="space-y-3 rounded-lg border border-border p-4">
          <p>{m.library_copy_delete_question()}</p>
          <div className="flex gap-3">
            <button type="button" className={quiet} onClick={() => setConfirming(false)}>
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
          <button type="submit" className={button} disabled={pending}>
            {copy ? m.library_copy_save() : m.library_copy_add_submit()}
          </button>
        ) : null}
        {copy ? (
          <button type="button" className={quiet} disabled={pending || !editable} onClick={() => setConfirming(true)}>
            {m.library_copy_delete()}
          </button>
        ) : null}
        <button type="button" className={quiet} onClick={onClose}>
          {m.library_copy_cancel()}
        </button>
      </div>
    </form>
  );

  if (inline) return content;
  return (
    <Exposure operation={copy ? 'copy.update' : 'copy.create'}>
      {mobile ? (
        <BottomSheet open onOpenChange={(open) => !open && onClose()} title={title}>
          {content}
        </BottomSheet>
      ) : (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
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
    <ListRow className="flex items-center gap-3 py-4 sm:gap-4">
      <ListRowLink href={href?.href} aria-hidden={copy.subject ? undefined : true} className="z-[2]">
        {copy.subject ? <LibraryTitle label={copy.subject.label} locale={pageLocale} /> : title}
      </ListRowLink>
      <div className="w-[72px] shrink-0 sm:w-24">
        <SubjectCover subject={copy.subject} ratio={ratio} size="fill" />
      </div>
      <div className="min-w-0 flex-1">
        <p aria-hidden={copy.subject ? true : undefined} className="font-medium break-words">
          {copy.subject ? <LibraryTitle label={copy.subject.label} locale={pageLocale} /> : title}
        </p>
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
        {copy.location ? <p className="text-sm text-muted-foreground">{copy.location}</p> : null}
        {copy.source ? <p className="text-sm text-muted-foreground">{copy.source}</p> : null}
        {copy.disposedOn ? (
          <p className="text-sm text-muted-foreground">
            <span>{m.library_copy_disposed()}: </span>
            <span className="whitespace-nowrap">{dateText(copy.disposedOn)}</span>
          </p>
        ) : null}
        {copy.note ? <p className="line-clamp-2 text-sm text-muted-foreground">{copy.note}</p> : null}
        {hasUnresolvedHistory(copy) ? (
          <ListRowControl className="mt-2">
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer content-center rounded-md py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.library_copy_history_details()}
              </summary>
              <div className="space-y-2 pt-2 text-muted-foreground">
                <p>{copy.meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable()}</p>
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
          </ListRowControl>
        ) : null}
      </div>
      <ListRowControl className="shrink-0">
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
      </ListRowControl>
    </ListRow>
  );
}

export function CopiesPage({ page, failure }: { page: CopiesPageData; failure?: string | undefined }) {
  const [copies, setCopies] = useState(page.copies);
  const [addKey, setAddKey] = useState(page.addKey);
  const [removed, setRemoved] = useState<{ copy: CopyItem; result: CopyRemoved; deadline: number } | null>(null);
  const [editing, setEditing] = useState<CopyItem | null | undefined>(undefined);
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'unavailable' | 'forbidden'>('ready');
  const inspection = useRef(0);
  const closeEditor = () => {
    inspection.current += 1;
    setEditing(undefined);
  };
  async function inspect(copy: CopyItem) {
    const current = ++inspection.current;
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
      const result = await readCopyDetail({ data: { id: copy.id } });
      if (current !== inspection.current) return;
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
      if (current === inspection.current) setDetailState('unavailable');
    }
  }
  useEffect(() => {
    setCopies(page.copies);
    setAddKey(page.addKey);
    inspection.current += 1;
    setEditing(undefined);
  }, [page]);
  const filteredLabel = page.copies.find((copy) => copy.subject?.id === page.subjectId)?.subject?.label;
  const filteredTitle = filteredLabel ? displayLibraryTitle(filteredLabel, locale()).text : undefined;
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_copy_heading()}</PageHeading>
        {!page.subjectId || page.profile?.kinds.length ? (
          <button
            type="button"
            className={button}
            onClick={() => {
              inspection.current += 1;
              setDetailState('ready');
              setEditing(null);
            }}
          >
            {m.library_copy_add()}
          </button>
        ) : null}
      </header>
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
            <Link to="/library/copies" search={{}} className="text-primary underline underline-offset-4">
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
        <p className="text-muted-foreground">
          {page.subjectId ? m.library_copy_filtered_empty() : m.library_copy_empty()}
        </p>
      )}
      {page.next ? (
        <Exposure operation="copy.list">
          <nav aria-label={m.library_copy_heading()}>
            <Link
              to="/library/copies"
              search={{ ...(page.subjectId ? { subjectId: page.subjectId } : {}), cursor: page.next }}
              className={`${quiet} text-primary`}
            >
              {m.library_copy_more()}
            </Link>
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
            if (!removed.result.undo) return false;
            const result = await undoCopy({
              data: { id: removed.copy.id, ...removed.result.undo, idempotencyKey },
              headers: csrfHeaders(),
            });
            if (!result.ok) return false;
            setCopies((current) => [
              { ...removed.copy, ...result.copy, idempotencyKey: crypto.randomUUID() },
              ...current,
            ]);
            setRemoved(null);
            return true;
          }}
        />
      ) : null}
      {editing !== undefined ? (
        <CopyForm
          key={editing ? `${editing.id}:${editing.revision}:${detailState}` : 'add'}
          detailState={detailState}
          {...(editing ? { copy: editing } : {})}
          profile={editing ? undefined : page.profile}
          sendKind={page.sendKind}
          subjectId={page.subjectId}
          addKey={addKey}
          onClose={closeEditor}
          onKey={setAddKey}
          onCreated={(copy) =>
            setCopies((current) => [
              ...current,
              {
                ...copy,
                subject: copy.subject ?? current.find((item) => item.subject?.id === page.subjectId)?.subject ?? null,
                idempotencyKey: crypto.randomUUID(),
              },
            ])
          }
          onSaved={(next) => setCopies((current) => current.map((item) => (item.id === next.id ? next : item)))}
          onRemoved={(id, result, deadline) => {
            const copy = copies.find((item) => item.id === id);
            if (copy) setRemoved({ copy, result, deadline });
            setCopies((current) => current.filter((item) => item.id !== id));
          }}
        />
      ) : null}
    </div>
  );
}
