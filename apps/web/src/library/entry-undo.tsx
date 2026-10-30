import { useContext } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Exposure } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { libraryEntryStateLabel, type LibraryRestoreInput, type LibraryRestoreResult } from './entries-read';
import { LibraryTitle } from './title';

export type EntryFormContext = { locale: string; csrfToken?: string | null; returnTo?: string };

function ContextFields({ locale, csrfToken, returnTo }: EntryFormContext) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
      <input type="hidden" name="returnTo" value={returnTo ?? `/${locale}/library`} />
    </>
  );
}

/** The receipt is carried verbatim by a native form, including on a script-free response page. */
export function EntryUndoForm({ undo, ...context }: EntryFormContext & { undo: LibraryRestoreInput }) {
  return (
    <Exposure operation="library_entry.restore">
      <form method="post" action="/library/entry" className="flex flex-wrap items-center gap-3 text-sm">
        <ContextFields {...context} />
        <input type="hidden" name="intent" value="restore" />
        <input type="hidden" name="subjectId" value={undo.subjectId} />
        <input type="hidden" name="deletionId" value={undo.deletionId} />
        <input type="hidden" name="revision" value={undo.revision} />
        <p role="status">{m.library_removed()}</p>
        <button className={buttonVariants({ variant: 'outline', size: 'sm' })} type="submit">
          {m.editor_undo()}
        </button>
      </form>
    </Exposure>
  );
}

export function EntryRemoveForm({
  subjectId,
  revision,
  incarnationId,
  idempotencyKey,
  ...context
}: EntryFormContext & {
  subjectId: string;
  revision: number;
  incarnationId?: string | null;
  idempotencyKey: string;
}) {
  const client = useContext(QueryClientContext);
  const session = client?.getQueryData<{ csrfToken: string | null }>(['session']);
  return (
    <Exposure operation="library_entry.restore">
      <Exposure operation="library_entry.delete">
        <form method="post" action="/library/entry" className="my-2">
          <ContextFields {...context} csrfToken={context.csrfToken ?? session?.csrfToken ?? null} />
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="subjectId" value={subjectId} />
          <input type="hidden" name="revision" value={revision} />
          {typeof incarnationId === 'string' ? (
            <input type="hidden" name="incarnationId" value={incarnationId} />
          ) : null}
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <button className={buttonVariants({ variant: 'outline', size: 'sm' })} type="submit">
            {m.library_remove_from_library()}
          </button>
        </form>
      </Exposure>
    </Exposure>
  );
}

export function restoreFailureText(result: LibraryRestoreResult): string | null {
  if (result.ok) return null;
  if (result.reason === 'occupied') return m.library_restore_occupied();
  if (result.reason === 'stale') return m.library_restore_stale();
  if (result.reason === 'expired') return m.library_restore_expired();
  if (result.reason === 'closed') return m.platform_closed_message();
  return m.library_subject_unavailable();
}

/** This is also the document form's result: only a refusal that says occupied may display a current entry. */
export function EntryRestoreFeedback({ restore, locale }: { restore: LibraryRestoreResult; locale: string }) {
  const entry = restore.ok || restore.reason === 'occupied' ? restore.entry : undefined;
  const message = restoreFailureText(restore);
  return (
    <div className="space-y-3">
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      {entry ? (
        <article
          data-restored-entry
          data-entry-revision={entry.revision}
          className="rounded-lg border border-border p-4"
        >
          <p className="font-medium">
            {entry.subject ? (
              <LibraryTitle label={entry.subject.label} locale={locale} />
            ) : (
              m.library_subject_unavailable()
            )}
          </p>
          <p className="text-sm text-muted-foreground">{libraryEntryStateLabel(entry.state)}</p>
        </article>
      ) : null}
    </div>
  );
}

export function EntryFormPage({
  locale,
  undo,
  restore,
  csrfToken,
  returnTo,
  removed = false,
  conflict = false,
}: {
  locale: string;
  undo?: LibraryRestoreInput | undefined;
  restore?: LibraryRestoreResult | undefined;
  csrfToken: string | null;
  returnTo: string;
  removed?: boolean;
  conflict?: boolean;
}) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 text-foreground">
      <h1 className="text-2xl font-semibold">{m.library_heading()}</h1>
      {undo ? <EntryUndoForm undo={undo} locale={locale} csrfToken={csrfToken} returnTo={returnTo} /> : null}
      {removed && !undo ? <p role="status">{m.library_removed()}</p> : null}
      {conflict ? <p role="status">{m.library_conflict()}</p> : null}
      {restore ? <EntryRestoreFeedback restore={restore} locale={locale} /> : null}
      <a className="text-primary underline" href={returnTo}>
        {m.library_menu_back()}
      </a>
    </main>
  );
}
