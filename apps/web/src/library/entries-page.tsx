import type { CoverRatio } from '@rezics/ui/cover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import { BookCopyIcon, ChevronDownIcon, EllipsisIcon, GaugeIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { rowRatio, SubjectIdentity } from './subject-row';
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
  const linkClass = buttonVariants({ variant: 'ghost', size: 'lg' });
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

function LibraryRow({ entry, locale, ratio }: { entry: PersonalLibraryEntry; locale: string; ratio: CoverRatio }) {
  const [row, setRow] = useState(entry);
  const [changeKey, setChangeKey] = useState(entry.changeKey);
  const [removeKey, setRemoveKey] = useState(entry.removeKey);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<'closed' | 'unavailable' | 'signed-out' | null>(null);
  const [removed, setRemoved] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (removed) return null;

  const onChange = async (value: string) => {
    const state = libraryEntryState(value);
    if (!state || state === row.state || pending) return;
    setPending(true);
    try {
      const result = await savePersonalLibraryEntry({
        data: { subjectId: row.subjectId, state, revision: row.revision, idempotencyKey: changeKey },
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

  const onRemove = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await deletePersonalLibraryEntry({
        data: { subjectId: row.subjectId, revision: row.revision, idempotencyKey: removeKey },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setRemoved(true);
      } else if (result.reason === 'conflict') {
        setRow((current) => ({ ...current, ...result.entry }));
        setRemoveKey(crypto.randomUUID());
        setConflict(true);
        setFailure(null);
        setRemoving(false);
      } else if (result.reason === 'missing') {
        setRemoved(true);
      } else {
        setFailure(result.reason === 'closed' || result.reason === 'signed-out' ? result.reason : 'unavailable');
        setRemoving(false);
      }
    } catch {
      setFailure('unavailable');
      setRemoving(false);
    } finally {
      setPending(false);
    }
  };

  const title = row.subject?.label ?? m.library_subject_unavailable();
  const current = stateLabel(row.state);
  const subjectQuery = row.subject ? `?subjectId=${encodeURIComponent(row.subject.id)}` : null;
  return (
    <li className="space-y-2 py-3">
      <div className="flex items-center gap-2 sm:gap-3">
        <SubjectIdentity subject={row.subject} ratio={ratio}>
          {m.library_updated()} <time {...{ datetime: row.updatedAt }}>{formatUpdated(row.updatedAt, locale)}</time>
        </SubjectIdentity>
        <form onSubmit={(event) => event.preventDefault()}>
          <input type="hidden" name="subjectId" value={row.subjectId} />
          <input type="hidden" name="revision" value={String(row.revision)} />
          <input type="hidden" name="idempotencyKey" value={changeKey} />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hydrated || pending}
                  aria-label={m.library_entry_state_label({ title, state: current })}
                  data-slot="library-status"
                  data-state={row.state}
                />
              }
            >
              {current}
              <ChevronDownIcon aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuRadioGroup value={row.state} onValueChange={(value) => void onChange(value)}>
                {libraryEntryStates.map((state) => (
                  <DropdownMenuRadioItem key={state} value={state} closeOnClick>
                    {stateLabel(state)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </form>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={m.library_entry_actions({ title })}
                data-slot="library-actions"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {subjectQuery ? (
              <>
                <DropdownMenuItem render={<a href={`/${locale}/library/copies${subjectQuery}`} />}>
                  <BookCopyIcon aria-hidden="true" />
                  {m.library_entry_copies()}
                </DropdownMenuItem>
                <DropdownMenuItem render={<a href={`/${locale}/library/progress${subjectQuery}`} />}>
                  <GaugeIcon aria-hidden="true" />
                  {m.library_entry_progress()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem variant="destructive" disabled={!hydrated || pending} onClick={() => setRemoving(true)}>
              <Trash2Icon aria-hidden="true" />
              {m.library_remove()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {conflict ? <p role="status">{m.library_conflict()}</p> : null}
      {failure ? <p role="alert">{failureText(failure)}</p> : null}
      <form onSubmit={(event) => event.preventDefault()}>
        <input type="hidden" name="subjectId" value={row.subjectId} />
        <input type="hidden" name="revision" value={String(row.revision)} />
        <input type="hidden" name="idempotencyKey" value={removeKey} />
      </form>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_remove_confirm()}</AlertDialogTitle>
            <AlertDialogDescription>{title}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{m.library_collection_cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={() => void onRemove()}>
              {m.library_remove_submit()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const ratio = rowRatio(page.entries.map((entry) => entry.subject));
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
              className={buttonVariants({ variant: current ? 'secondary' : 'outline', size: 'lg' })}
            >
              {tab.label}
            </a>
          );
        })}
      </nav>
      {page.entries.length ? (
        <ol className="divide-y divide-border/60 border-y border-border/60">
          {page.entries.map((entry) => (
            <LibraryRow key={entry.subjectId} entry={entry} locale={locale} ratio={ratio} />
          ))}
        </ol>
      ) : (
        <p>{m.library_empty()}</p>
      )}
      {page.next ? (
        <a
          href={libraryHref(locale, page.state, page.next)}
          className={buttonVariants({ variant: 'outline', size: 'lg' })}
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
