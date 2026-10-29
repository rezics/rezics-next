import type { CoverRatio } from '@rezics/ui/cover';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Calendar } from '@rezics/ui/shadcn/calendar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@rezics/ui/shadcn/drawer';
import { Popover, PopoverContent, PopoverTrigger } from '@rezics/ui/shadcn/popover';
import { useIsMobile } from '@rezics/ui/hooks/use-is-mobile';
import { de, enUS, es, fr, ja, ko, zhCN, zhTW } from 'date-fns/locale';
import { CalendarDays } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState, useRef, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { Exposure } from '../kernel/exposure';
import { coverSubject, rowRatio, SubjectCover } from './subject-row';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { createCopy, deleteCopy, updateCopy, readCopySubject } from './copies-actions';
import { type CopiesPageData, type CopyItem, type SavedCopy } from './copies-read';
import { subjectHref } from '../subject/subject-href';

import type { CopyProfile } from './copies-profiles';
import { CopiesFallback } from './copies-fallback';
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
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
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
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={inputClass}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
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
  choices: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name={name}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
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
  subjectId,
  addKey,
  onClose,
  onCreated,
  onSaved,
  onRemoved,
  onKey,
}: {
  copy?: CopyItem;
  profile?: CopyProfile;
  sendKind?: boolean;
  inline?: boolean;
  initialKind?: string;
  subjectId: string | null;
  addKey: string;
  onClose: () => void;
  onCreated: (copy: CopyItem) => void;
  onSaved: (copy: CopyItem) => void;
  onRemoved: (id: string) => void;
  onKey: (key: string) => void;
}) {
  const mobile = useIsMobile();
  const lookup = useRef(0);
  const [choices, setChoices] = useState(profile);
  const [kind, setKind] = useState(copy?.kind ?? initialKind ?? profile?.kinds[0]?.id ?? '');
  const selected = choices?.kinds.find((choice) => choice.id === kind);
  const editable = !copy ? Boolean(selected) : Boolean(copy.kind && copy.kind !== 'legacy-unspecified' && selected);
  const [edition, setEdition] = useState(subjectId ?? '');
  const [draft, setDraft] = useState(() => ({
    ...draftOf(copy),
    status: copy?.status ?? selected?.statuses[0]?.id ?? '',
  }));
  const [more, setMore] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const title = copy ? m.library_copy_edit() : m.library_copy_add();
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !editable) return;
    setPending(true);
    setFailure(null);
    try {
      const fields = {
        status: draft.status,
        location: blank(draft.location),
        source: blank(draft.source),
        acquiredOn: blank(draft.acquiredOn),
        disposedOn: blank(draft.disposedOn),
        note: blank(draft.note),
      };
      if (copy) {
        const result = await updateCopy({
          data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey, ...fields },
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
          statusLabel:
            selected?.statuses.find((status) => status.id === result.copy.status)?.label ?? m.library_other(),
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
          data: { subjectId: subjectId ?? edition, idempotencyKey: addKey, ...(sendKind ? { kind } : {}), ...fields },
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
        onCreated({
          ...result.copy,
          kind: result.copy.kind ?? null,
          subject: null,
          profile: choices,
          kindLabel: selected?.label ?? m.library_other(),
          statusLabel:
            selected?.statuses.find((status) => status.id === result.copy.status)?.label ?? m.library_other(),
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
    if (!copy || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await deleteCopy({
        data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setFailure(result.reason === 'conflict' ? m.library_copy_conflict() : m.library_copy_failure());
        setConfirming(false);
        return;
      }
      onRemoved(copy.id);
      onClose();
    } catch {
      setFailure(m.library_copy_failure());
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  const content: ReactNode = (
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
      <input type="hidden" name="subjectId" value={subjectId ?? edition} />
      <input type="hidden" name="sendKind" value={String(sendKind)} />
      {!copy && !subjectId ? (
        <TextField
          label={m.library_copy_edition()}
          value={subjectId ?? edition}
          onChange={(value) => {
            setEdition(value);
            setChoices(undefined);
            const current = ++lookup.current;
            if (/^[0-9a-f-]{36}$/i.test(value))
              void readCopySubject({ data: value })
                .then((next) => {
                  if (current !== lookup.current) return;
                  setChoices(next);
                  setKind(next.kinds[0]?.id ?? '');
                  change('status', next.kinds[0]?.statuses[0]?.id ?? '');
                })
                .catch(() => {
                  if (current === lookup.current) setFailure(m.library_copy_failure());
                });
          }}
        />
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
      {editable ? (
        <ChoiceField
          name="status"
          label={m.library_copy_status()}
          value={draft.status}
          choices={selected!.statuses}
          onChange={(value) => change('status', value)}
        />
      ) : copy ? (
        <>
          <p>{copy.statusLabel ?? m.library_other()}</p>
          <p>{m.library_copy_no_longer_offered()}</p>
        </>
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
          <button type="button" className={quiet} disabled={pending} onClick={() => setConfirming(true)}>
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
        <Drawer open onOpenChange={(open) => !open && onClose()}>
          <DrawerContent className="max-h-[90dvh] overflow-y-auto">
            <DrawerHeader>
              <DrawerTitle>{title}</DrawerTitle>
            </DrawerHeader>
            <div className="overflow-y-auto p-4">{content}</div>
          </DrawerContent>
        </Drawer>
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

function CopyRow({ copy, onEdit, ratio }: { copy: CopyItem; onEdit: () => void; ratio: CoverRatio }) {
  const href = copy.subject ? subjectHref({ id: copy.subject.id, label: copy.subject.label }, locale()) : null;
  const title = copy.subject?.label ?? m.library_subject_unavailable();
  const kind =
    copy.subject?.typeLabel ??
    copy.subject?.types?.[0]
      ?.split(/[:/#]/)
      .at(-1)
      ?.replace(/^./u, (letter) => letter.toLocaleUpperCase(locale())) ??
    '';
  return (
    <ListRow className="flex items-center gap-4 py-4">
      <ListRowLink href={href?.href ?? '#'} className="z-[2]">
        {title}
      </ListRowLink>
      <div className="w-[72px] shrink-0 sm:w-24">
        <SubjectCover subject={copy.subject} ratio={ratio} size="fill" />
      </div>
      <div className="min-w-0 flex-1">
        <p aria-hidden="true" className="font-medium break-words">
          {title}
        </p>
        <p className="text-sm text-muted-foreground">
          {kind}
          {kind ? ' · ' : ''}
          {copy.kindLabel ?? m.library_other()} · {copy.statusLabel ?? m.library_other()}
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
      </div>
      <ListRowControl>
        <button type="button" className={quiet} onClick={onEdit}>
          {copy.kind && copy.kind !== 'legacy-unspecified' && copy.profile?.kinds.some((kind) => kind.id === copy.kind)
            ? m.library_copy_edit()
            : m.library_copy_delete()}
        </button>
      </ListRowControl>
    </ListRow>
  );
}

export function CopiesPage({ page, failure }: { page: CopiesPageData; failure?: string }) {
  const [copies, setCopies] = useState(page.copies);
  const [addKey, setAddKey] = useState(page.addKey);
  const [editing, setEditing] = useState<CopyItem | null | undefined>(undefined);
  useEffect(() => {
    setCopies(page.copies);
    setAddKey(page.addKey);
  }, [page]);
  const filteredTitle = page.copies.find((copy) => copy.subject?.id === page.subjectId)?.subject?.label;
  return (
    <div className="max-w-4xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_copy_heading()}</PageHeading>
        {!page.subjectId || page.profile?.kinds.length ? (
          <button type="button" className={button} onClick={() => setEditing(null)}>
            {m.library_copy_add()}
          </button>
        ) : null}
      </header>
      {failure ? (
        <p role="alert">{failure === 'unsupported' ? m.library_copy_unsupported() : m.library_copy_failure()}</p>
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
        <ul className="m-0 list-none p-0">
          {copies.map((copy) => (
            <CopyRow
              key={`${copy.id}:${copy.revision}`}
              copy={copy}
              ratio={rowRatio([copy.subject])}
              onEdit={() => setEditing(copy)}
            />
          ))}
        </ul>
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
      {editing !== undefined ? (
        <CopyForm
          key={editing?.id ?? 'add'}
          {...(editing ? { copy: editing } : {})}
          profile={editing?.profile ?? page.profile}
          sendKind={page.sendKind}
          subjectId={page.subjectId}
          addKey={addKey}
          onClose={() => setEditing(undefined)}
          onKey={setAddKey}
          onCreated={(copy) =>
            setCopies((current) => [
              ...current,
              {
                ...copy,
                subject: current.find((item) => item.subject?.id === page.subjectId)?.subject ?? null,
                idempotencyKey: crypto.randomUUID(),
              },
            ])
          }
          onSaved={(next) => setCopies((current) => current.map((item) => (item.id === next.id ? next : item)))}
          onRemoved={(id) => setCopies((current) => current.filter((item) => item.id !== id))}
        />
      ) : null}
    </div>
  );
}
