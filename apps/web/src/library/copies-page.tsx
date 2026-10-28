import { Exposure } from '../kernel/exposure';
import type { CoverRatio } from '@rezics/ui/cover';
import { Link, useLocation } from '@tanstack/react-router';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders, SignInPrompt } from '../threads/composer';
import { createCopy, deleteCopy, updateCopy } from './copies-actions';
import type { CopiesPageData, CopyItem, CopyStatus, SavedCopy } from './copies-read';
import { rowRatio, SubjectIdentity } from './subject-row';

const statuses = ['ordered', 'owned', 'lent', 'disposed'] as const;
const control =
  'min-h-11 w-full rounded-lg border border-border bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';
const button =
  'inline-flex min-h-10 items-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60';
const quiet =
  'inline-flex min-h-10 items-center rounded-lg border border-border px-4 hover:bg-muted disabled:opacity-60';

function statusLabel(status: CopyStatus): string {
  if (status === 'ordered') return m.library_copy_status_ordered();
  if (status === 'owned') return m.library_copy_status_owned();
  if (status === 'lent') return m.library_copy_status_lent();
  return m.library_copy_status_disposed();
}

function blank(value: string): string | null {
  return value === '' ? null : value;
}

function StatusHints() {
  return (
    <ul id="copy-status-hints" className="space-y-1 text-sm text-muted-foreground">
      <li>
        {m.library_copy_status_ordered()}: {m.library_copy_status_ordered_hint()}
      </li>
      <li>
        {m.library_copy_status_owned()}: {m.library_copy_status_owned_hint()}
      </li>
      <li>
        {m.library_copy_status_lent()}: {m.library_copy_status_lent_hint()}
      </li>
      <li>
        {m.library_copy_status_disposed()}: {m.library_copy_status_disposed_hint()}
      </li>
    </ul>
  );
}

function DateHints() {
  return (
    <>
      <p id="copy-acquired-hint" className="text-sm text-muted-foreground">
        {m.library_copy_acquired_hint()}
      </p>
      <p id="copy-disposed-hint" className="text-sm text-muted-foreground">
        {m.library_copy_disposed_hint()}
      </p>
    </>
  );
}

function StatusField({ value, onChange }: { value: CopyStatus; onChange: (status: CopyStatus) => void }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {m.library_copy_status()}
      </label>
      <select
        id={id}
        className={control}
        aria-describedby="copy-status-hints"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as CopyStatus)}
      >
        {statuses.map((status) => (
          <option key={status} value={status}>
            {statusLabel(status)}
          </option>
        ))}
      </select>
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
        className={control}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function DateField({
  label,
  hintId,
  value,
  onChange,
}: {
  label: string;
  hintId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="date"
        className={control}
        aria-describedby={hintId}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function CopySummary({ copy }: { copy: CopyItem }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground">{m.library_copy_status()}</dt>
      <dd>{statusLabel(copy.status)}</dd>
      <dt className="text-muted-foreground">{m.library_copy_location()}</dt>
      <dd>{copy.location ?? ''}</dd>
      <dt className="text-muted-foreground">{m.library_copy_source()}</dt>
      <dd>{copy.source ?? ''}</dd>
      <dt className="text-muted-foreground">{m.library_copy_acquired()}</dt>
      <dd>{copy.acquiredOn ?? ''}</dd>
      <dt className="text-muted-foreground">{m.library_copy_disposed()}</dt>
      <dd>{copy.disposedOn ?? ''}</dd>
      <dt className="text-muted-foreground">{m.library_copy_note()}</dt>
      <dd className="whitespace-pre-wrap">{copy.note ?? ''}</dd>
    </dl>
  );
}

function failureText(reason: string): string {
  if (reason === 'conflict') return m.library_copy_conflict();
  return m.library_copy_failure();
}

function CopyArticle({
  copy,
  ratio,
  onSaved,
  onRemoved,
}: {
  copy: CopyItem;
  ratio: CoverRatio;
  onSaved: (copy: CopyItem) => void;
  onRemoved: (id: string) => void;
}) {
  const questionId = useId();
  const [status, setStatus] = useState(copy.status);
  const [location, setLocation] = useState(copy.location ?? '');
  const [source, setSource] = useState(copy.source ?? '');
  const [acquiredOn, setAcquiredOn] = useState(copy.acquiredOn ?? '');
  const [disposedOn, setDisposedOn] = useState(copy.disposedOn ?? '');
  const [note, setNote] = useState(copy.note ?? '');
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await updateCopy({
        data: {
          id: copy.id,
          revision: copy.revision,
          idempotencyKey: copy.idempotencyKey,
          status,
          location: blank(location),
          source: blank(source),
          acquiredOn: blank(acquiredOn),
          disposedOn: blank(disposedOn),
          note: blank(note),
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setFailure(failureText(result.reason));
        return;
      }
      onSaved({
        ...copy,
        status: result.copy.status,
        revision: result.copy.revision,
        location: result.copy.location,
        source: result.copy.source,
        acquiredOn: result.copy.acquiredOn,
        disposedOn: result.copy.disposedOn,
        note: result.copy.note,
        subject: copy.subject,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch {
      setFailure(m.library_copy_failure());
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await deleteCopy({
        data: { id: copy.id, revision: copy.revision, idempotencyKey: copy.idempotencyKey },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setFailure(failureText(result.reason));
        setConfirming(false);
        return;
      }
      onRemoved(copy.id);
    } catch {
      setFailure(m.library_copy_failure());
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <article data-idempotency-key={copy.idempotencyKey} className="space-y-4 py-6">
      <div className="flex items-center gap-3">
        <SubjectIdentity subject={copy.subject} ratio={ratio} />
      </div>
      <CopySummary copy={copy} />
      <Exposure operation="copy.update">
        <form className="space-y-4" onSubmit={save}>
          <StatusField value={status} onChange={setStatus} />
          <TextField label={m.library_copy_location()} value={location} onChange={setLocation} />
          <TextField label={m.library_copy_source()} value={source} onChange={setSource} />
          <DateField
            label={m.library_copy_acquired()}
            hintId="copy-acquired-hint"
            value={acquiredOn}
            onChange={setAcquiredOn}
          />
          <DateField
            label={m.library_copy_disposed()}
            hintId="copy-disposed-hint"
            value={disposedOn}
            onChange={setDisposedOn}
          />
          <TextField label={m.library_copy_note()} value={note} onChange={setNote} />
          {failure ? <p role="alert">{failure}</p> : null}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={button} disabled={pending}>
              {m.library_copy_save()}
            </button>
            <button type="button" className={quiet} disabled={pending} onClick={() => setConfirming(true)}>
              {m.library_copy_delete()}
            </button>
          </div>
        </form>
      </Exposure>
      {confirming ? (
        <Exposure operation="copy.delete">
          <div
            role="alertdialog"
            aria-labelledby={questionId}
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <p id={questionId}>{m.library_copy_delete_question()}</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={quiet} onClick={() => setConfirming(false)}>
                {m.library_copy_cancel()}
              </button>
              <button type="button" className={button} disabled={pending} onClick={() => void remove()}>
                {m.library_copy_delete_confirm()}
              </button>
            </div>
          </div>
        </Exposure>
      ) : null}
    </article>
  );
}

function AddCopyForm({
  subjectId,
  addKey,
  onCreated,
  onKey,
}: {
  subjectId: string | null;
  addKey: string;
  onCreated: (copy: SavedCopy) => void;
  onKey: (key: string) => void;
}) {
  const [edition, setEdition] = useState(subjectId ?? '');
  const [status, setStatus] = useState<CopyStatus>('owned');
  const [location, setLocation] = useState('');
  const [source, setSource] = useState('');
  const [acquiredOn, setAcquiredOn] = useState('');
  const [disposedOn, setDisposedOn] = useState('');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const editionId = useId();

  useEffect(() => {
    setEdition(subjectId ?? '');
  }, [subjectId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await createCopy({
        data: {
          subjectId: subjectId ?? edition,
          idempotencyKey: addKey,
          status,
          location: blank(location),
          source: blank(source),
          acquiredOn: blank(acquiredOn),
          disposedOn: blank(disposedOn),
          note: blank(note),
        },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        setFailure(failureText(result.reason));
        return;
      }
      onCreated(result.copy);
      onKey(crypto.randomUUID());
      if (!subjectId) setEdition('');
      setStatus('owned');
      setLocation('');
      setSource('');
      setAcquiredOn('');
      setDisposedOn('');
      setNote('');
    } catch {
      setFailure(m.library_copy_failure());
    } finally {
      setPending(false);
    }
  }

  return (
    <Exposure operation="copy.create">
      <form
        aria-label={m.library_copy_add()}
        data-idempotency-key={addKey}
        className="space-y-4 rounded-xl border border-border/70 bg-card p-5"
        onSubmit={submit}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={editionId}>
            {m.library_copy_edition()}
          </label>
          <input
            id={editionId}
            className={control}
            value={subjectId ?? edition}
            readOnly={subjectId !== null}
            autoComplete="off"
            onChange={(event) => {
              if (subjectId === null) setEdition(event.currentTarget.value);
            }}
          />
        </div>
        <StatusField value={status} onChange={setStatus} />
        <TextField label={m.library_copy_location()} value={location} onChange={setLocation} />
        <TextField label={m.library_copy_source()} value={source} onChange={setSource} />
        <DateField
          label={m.library_copy_acquired()}
          hintId="copy-acquired-hint"
          value={acquiredOn}
          onChange={setAcquiredOn}
        />
        <DateField
          label={m.library_copy_disposed()}
          hintId="copy-disposed-hint"
          value={disposedOn}
          onChange={setDisposedOn}
        />
        <TextField label={m.library_copy_note()} value={note} onChange={setNote} />
        {failure ? <p role="alert">{failure}</p> : null}
        <button type="submit" className={button} disabled={pending}>
          {m.library_copy_add_submit()}
        </button>
      </form>
    </Exposure>
  );
}

export function CopiesPage({ page }: { page: CopiesPageData }) {
  const location = useLocation();
  const [copies, setCopies] = useState(page.copies);
  const [addKey, setAddKey] = useState(page.addKey);
  useEffect(() => {
    setCopies(page.copies);
    setAddKey(page.addKey);
  }, [page]);
  const returnTo = location.publicHref.split('#')[0] ?? location.publicHref;
  const ratio = rowRatio(copies.map((copy) => copy.subject));
  const subjectTitle = page.copies.find((copy) => copy.subject?.id === page.subjectId)?.subject?.label;

  return (
    <div className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_copy_heading()}</PageHeading>
        <StatusHints />
        <DateHints />
      </header>
      {page.signedIn ? (
        <>
          {page.subjectId ? (
            <p className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <span>{m.library_copy_filtered_heading({ title: subjectTitle ?? m.library_copy_this_edition() })}</span>
              <Exposure operation="copy.list">
                <Link to="/library/copies" search={{}} className="text-primary underline underline-offset-4">
                  {m.library_copy_all()}
                </Link>
              </Exposure>
            </p>
          ) : null}
          {copies.length ? (
            <div className="divide-y divide-border/60 border-y border-border/60">
              {copies.map((copy) => (
                <CopyArticle
                  key={`${copy.id}:${copy.revision}`}
                  copy={copy}
                  ratio={ratio}
                  onSaved={(next) => setCopies((current) => current.map((item) => (item.id === next.id ? next : item)))}
                  onRemoved={(id) => setCopies((current) => current.filter((item) => item.id !== id))}
                />
              ))}
            </div>
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
                  search={{
                    ...(page.subjectId ? { subjectId: page.subjectId } : {}),
                    cursor: page.next,
                  }}
                  className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
                >
                  {m.library_copy_more()}
                </Link>
              </nav>
            </Exposure>
          ) : null}
          <AddCopyForm
            subjectId={page.subjectId}
            addKey={addKey}
            onCreated={(copy) => {
              setCopies((current) => [...current, { ...copy, subject: null, idempotencyKey: crypto.randomUUID() }]);
            }}
            onKey={setAddKey}
          />
        </>
      ) : (
        <SignInPrompt returnTo={returnTo} />
      )}
    </div>
  );
}
