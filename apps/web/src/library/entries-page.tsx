import { useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { deletePersonalLibraryEntry, savePersonalLibraryEntry } from './entries-actions';
import {
  libraryEntryState,
  libraryEntryStates,
  type LibraryEntryState,
  type PersonalLibraryEntry,
  type PersonalLibraryView,
} from './entries-read';
import { SubjectRef } from './subject-ref';
import { PageHeading } from '../shell/page-heading';

function formatUpdated(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function stateLabel(state: LibraryEntryState): string {
  if (state === 'planned') return m.library_state_planned();
  if (state === 'in_progress') return m.library_state_in_progress();
  if (state === 'completed') return m.library_state_completed();
  if (state === 'paused') return m.library_state_paused();
  return m.library_state_dropped();
}

function libraryHref(locale: string, state?: LibraryEntryState | null, cursor?: string) {
  const params = new URLSearchParams();
  if (state) params.set('state', state);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `/${locale}/library?${query}` : `/${locale}/library`;
}

function LibrarySections({ locale }: { locale: string }) {
  const linkClass = 'inline-flex min-h-10 items-center rounded-lg px-3 text-primary underline-offset-4 hover:underline';
  return (
    <nav aria-label={m.library_navigation()} className="flex flex-wrap gap-2">
      <a href={libraryHref(locale)} aria-current="page" className={linkClass}>
        {m.library_nav_library()}
      </a>
      <a href={`/${locale}/collections`} className={linkClass}>
        {m.library_nav_collections()}
      </a>
      <a href={`/${locale}/following`} className={linkClass}>
        {m.library_nav_following()}
      </a>
    </nav>
  );
}

function failureText(reason: 'closed' | 'unavailable' | 'signed-out'): string {
  if (reason === 'closed') return m.platform_closed_message();
  if (reason === 'signed-out') return m.library_sign_in();
  return m.error_message();
}

function LibraryRow({ entry, locale }: { entry: PersonalLibraryEntry; locale: string }) {
  const [row, setRow] = useState(entry);
  const [changeKey, setChangeKey] = useState(entry.changeKey);
  const [removeKey, setRemoveKey] = useState(entry.removeKey);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<'closed' | 'unavailable' | 'signed-out' | null>(null);
  const [removed, setRemoved] = useState(false);
  const [pending, setPending] = useState(false);
  if (removed) return null;

  const onChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const state = libraryEntryState(String(form.get('state') ?? ''));
    const subjectId = String(form.get('subjectId') ?? '');
    const revision = Number(form.get('revision'));
    const idempotencyKey = String(form.get('idempotencyKey') ?? '');
    if (!state || !subjectId || !idempotencyKey || !Number.isInteger(revision)) return;
    setPending(true);
    try {
      const result = await savePersonalLibraryEntry({
        data: { subjectId, state, revision, idempotencyKey },
        headers: csrfHeaders(),
      });
      if (result.ok && result.entry) {
        setRow((current) => ({
          ...current,
          state: result.entry!.state,
          revision: result.entry!.revision,
          updatedAt: result.entry!.updatedAt,
        }));
        setChangeKey(crypto.randomUUID());
        setConflict(false);
        setFailure(null);
      } else if (!result.ok && result.reason === 'conflict') {
        setRow((current) => ({ ...current, ...result.entry }));
        setChangeKey(crypto.randomUUID());
        setConflict(true);
        setFailure(null);
      } else if (!result.ok && result.reason === 'missing') {
        setRemoved(true);
      } else if (!result.ok) {
        setFailure(result.reason === 'closed' || result.reason === 'signed-out' ? result.reason : 'unavailable');
      }
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  };

  const onRemove = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const subjectId = String(form.get('subjectId') ?? '');
    const revision = Number(form.get('revision'));
    const idempotencyKey = String(form.get('idempotencyKey') ?? '');
    if (!subjectId || !idempotencyKey || !Number.isInteger(revision)) return;
    setPending(true);
    try {
      const result = await deletePersonalLibraryEntry({
        data: { subjectId, revision, idempotencyKey },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setRemoved(true);
      } else if (result.reason === 'conflict') {
        setRow((current) => ({ ...current, ...result.entry }));
        setRemoveKey(crypto.randomUUID());
        setConflict(true);
        setFailure(null);
      } else if (result.reason === 'missing') {
        setRemoved(true);
      } else {
        setFailure(result.reason === 'closed' || result.reason === 'signed-out' ? result.reason : 'unavailable');
      }
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="space-y-3 py-4">
      <p className="flex flex-wrap items-baseline gap-2">
        <SubjectRef subject={row.subject} />
      </p>
      <p data-state={row.state}>{stateLabel(row.state)}</p>
      <p>
        {m.library_updated()} <time {...{ datetime: row.updatedAt }}>{formatUpdated(row.updatedAt, locale)}</time>
      </p>
      {conflict ? <p role="status">{m.library_conflict()}</p> : null}
      {failure ? <p role="alert">{failureText(failure)}</p> : null}
      <form onSubmit={onChange} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="subjectId" value={row.subjectId} />
        <input type="hidden" name="revision" value={String(row.revision)} />
        <input type="hidden" name="idempotencyKey" value={changeKey} />
        <label className="grid gap-1 text-sm">
          {m.library_change_state()}
          <select
            name="state"
            defaultValue={row.state}
            className="min-h-10 rounded-lg border border-border bg-background px-3"
          >
            {libraryEntryStates.map((state) => (
              <option key={state} value={state}>
                {stateLabel(state)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 hover:bg-muted"
        >
          {m.library_save_state()}
        </button>
      </form>
      <details>
        <summary className="cursor-pointer">{m.library_remove()}</summary>
        <form onSubmit={onRemove} className="mt-3 space-y-3">
          <input type="hidden" name="subjectId" value={row.subjectId} />
          <input type="hidden" name="revision" value={String(row.revision)} />
          <input type="hidden" name="idempotencyKey" value={removeKey} />
          <p>{m.library_remove_confirm()}</p>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 hover:bg-muted"
          >
            {m.library_remove_submit()}
          </button>
        </form>
      </details>
    </li>
  );
}

function SignedInLibrary({ page, locale }: { page: Extract<PersonalLibraryView, { signedIn: true }>; locale: string }) {
  const tabs: { state: LibraryEntryState | null; label: string }[] = [
    { state: null, label: m.library_state_all() },
    { state: 'planned', label: m.library_state_planned() },
    { state: 'in_progress', label: m.library_state_in_progress() },
    { state: 'completed', label: m.library_state_completed() },
    { state: 'paused', label: m.library_state_paused() },
    { state: 'dropped', label: m.library_state_dropped() },
  ];
  return (
    <>
      <nav aria-label={m.library_states()} className="flex flex-wrap gap-2">
        {tabs.map((tab) => {
          const current = page.state === tab.state;
          return (
            <a
              key={tab.state ?? 'all'}
              href={libraryHref(locale, tab.state)}
              {...(current ? { 'aria-current': 'page' as const } : {})}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 underline-offset-4 hover:bg-muted hover:underline"
            >
              {tab.label}
            </a>
          );
        })}
      </nav>
      {page.entries.length ? (
        <ol className="divide-y divide-border/60 border-y border-border/60">
          {page.entries.map((entry) => (
            <LibraryRow key={entry.subjectId} entry={entry} locale={locale} />
          ))}
        </ol>
      ) : (
        <p>{m.library_empty()}</p>
      )}
      {page.next ? (
        <a
          href={libraryHref(locale, page.state, page.next)}
          className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
        >
          {m.library_more()}
        </a>
      ) : null}
    </>
  );
}

export function PersonalLibraryPage({ page, locale }: { page: PersonalLibraryView; locale: string }) {
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <PageHeading>{m.library_heading()}</PageHeading>
        <LibrarySections locale={locale} />
      </header>
      {page.signedIn ? (
        <SignedInLibrary page={page} locale={locale} />
      ) : (
        <p>
          <a
            href={`/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/library`)}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {m.library_sign_in()}
          </a>
        </p>
      )}
    </article>
  );
}
