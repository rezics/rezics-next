import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { undoToast as UndoToast } from '@rezics/ui/undo-toast';
import { manageLabel } from './labels-actions';
import { readLabelsPage } from './labels-read-route';
import type { LabelInput, LabelsPage, LabelFeedback } from './labels-read';
import { shelfHref } from './shelf-params';
import type { LibraryLabelSummary } from './subject-labels';

/** A catalogue label opens its complete personal shelf. */
export function LabelShelfLink({ label, locale }: { label: LibraryLabelSummary; locale: string }) {
  return (
    <>
      <ListRowLink data-library-label-link href={shelfHref(locale, { label: label.id })}>
        {label.name}
      </ListRowLink>
      <span
        aria-hidden="true"
        className="text-primary underline-offset-4 group-hover:underline group-focus-within:underline"
      >
        {label.name}
      </span>
    </>
  );
}

// The private loader's Exposure snapshot also gates the server-rendered, no-script forms.
function LabelExposure({ page, operation, children }: { page: LabelsPage; operation: string; children: ReactNode }) {
  return page.operations.includes(`library_label.${operation}`) ? children : null;
}
const fieldClass = 'h-11 w-full min-w-0 rounded-md border bg-background px-3 text-foreground';

export function LabelsPageView({ page: initial }: { page: LabelsPage }) {
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  useEffect(() => setPage(initial), [initial]);
  const path = `/${getLocale()}/library/labels`;
  async function submit(input: LabelInput) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const result = await manageLabel({ data: input, headers: { 'X-CSRF-Token': page.csrfToken } });
      // All outcomes show the kernel's current page, including stale revisions and refused restores.
      const current = await readLabelsPage({ data: {} });
      const feedback: LabelFeedback = {
        ...result,
        operation: input.operation,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(result.ok && input.operation === 'delete' && result.revision !== undefined
          ? {
              undo: { id: input.id!, name: input.name ?? '', revision: result.revision },
            }
          : {}),
      };
      setPage({ ...current, feedback });
      if (feedback.undo) {
        const undo = feedback.undo;
        UndoToast(
          m.library_label_deleted({ name: undo.name }),
          () => {
            void submit({
              operation: 'restore',
              id: undo.id,
              revision: undo.revision,
              idempotencyKey: crypto.randomUUID(),
            });
          },
          { undo: m.library_label_undo() },
        );
      }
    } catch {
      setPage((current) => ({ ...current, feedback: { ok: false, reason: 'unavailable' } }));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void submit({
      operation: String(form.get('operation')) as LabelInput['operation'],
      idempotencyKey: String(form.get('idempotencyKey')),
      ...(form.has('id') ? { id: String(form.get('id')) } : {}),
      ...(form.has('name') ? { name: String(form.get('name')) } : {}),
      ...(form.has('library_label_revision') ? { revision: Number(form.get('library_label_revision')) } : {}),
    });
  }
  const hidden = (operation: LabelInput['operation'], key: string, id?: string, revision?: number) => (
    <>
      <input type="hidden" name="operation" value={operation} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="csrf_token" value={page.csrfToken} />
      {id ? <input type="hidden" name="id" value={id} /> : null}
      {revision !== undefined ? <input type="hidden" name="library_label_revision" value={revision} /> : null}
    </>
  );
  const feedback = page.feedback;
  const fieldError = (operation: string, id?: string) =>
    feedback && !feedback.ok && feedback.operation === operation && feedback.id === id;
  const error = (id: string) => (
    <p id={id} role="alert" className="text-sm text-destructive">
      {labelError(feedback!)}
    </p>
  );
  if (!page.signedIn)
    return (
      <article className="space-y-6">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p>{m.library_sign_in()}</p>
        <a href={`/auth/sign-in?return_to=${encodeURIComponent(path)}`}>{m.library_sign_in()}</a>
      </article>
    );
  if (!page.operations.includes('library_label.list'))
    return (
      <article className="space-y-6">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p>{m.library_labels_unavailable()}</p>
      </article>
    );
  return (
    <article className="max-w-3xl space-y-8 text-foreground" aria-busy={busy}>
      <header className="space-y-2">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p className="text-muted-foreground">{m.library_labels_private()}</p>
      </header>
      {feedback && !feedback.ok && !fieldError('create') && !fieldError('rename', feedback.id)
        ? error('label-error')
        : null}
      <LabelExposure page={page} operation="create">
        <form key={page.createKey} method="post" action={path} onSubmit={onSubmit} className="space-y-2">
          {hidden('create', page.createKey)}
          <label htmlFor="new-label" className="block text-sm font-medium">
            {m.library_label_name()}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="new-label"
              name="name"
              required
              maxLength={1000}
              className={`${fieldClass} flex-1 basis-48`}
              defaultValue={fieldError('create') ? feedback?.name : ''}
              aria-invalid={fieldError('create') || undefined}
              aria-describedby={fieldError('create') ? 'create-error' : undefined}
            />
            <button disabled={busy} className={buttonVariants({ variant: 'default', size: 'lg' })}>
              {m.library_label_create()}
            </button>
          </div>
          {fieldError('create') ? error('create-error') : null}
        </form>
      </LabelExposure>
      {feedback?.undo ? (
        <LabelExposure page={page} operation="delete">
          <form
            method="post"
            action={path}
            onSubmit={onSubmit}
            className="flex flex-wrap items-center gap-3 rounded-md border p-3"
            role="status"
          >
            {hidden('restore', page.undoKey, feedback.undo.id, feedback.undo.revision)}
            <span className="min-w-0 break-words">{m.library_label_deleted({ name: feedback.undo.name })}</span>
            <button disabled={busy} className={buttonVariants({ variant: 'outline' })}>
              {m.library_label_undo()}
            </button>
          </form>
        </LabelExposure>
      ) : null}
      {page.labels.length ? (
        <ul className="space-y-3">
          {page.labels.map((label) => (
            <ListRow key={`${label.id}:${label.renameKey}`} className="space-y-3 py-3">
              <LabelShelfLink label={label} locale={getLocale()} />
              <LabelExposure page={page} operation="rename">
                <ListRowControl>
                  <form method="post" action={path} onSubmit={onSubmit} className="space-y-2">
                    {hidden('rename', label.renameKey, label.id, label.revision)}
                    <label htmlFor={`label-${label.id}`} className="sr-only">
                      {m.library_label_name()}
                    </label>
                    <input
                      id={`label-${label.id}`}
                      name="name"
                      required
                      maxLength={1000}
                      className={fieldClass}
                      defaultValue={
                        fieldError('rename', label.id) && feedback?.reason !== 'conflict' ? feedback?.name : label.name
                      }
                      aria-invalid={fieldError('rename', label.id) || undefined}
                      aria-describedby={fieldError('rename', label.id) ? `rename-error-${label.id}` : undefined}
                    />
                    {fieldError('rename', label.id) ? error(`rename-error-${label.id}`) : null}
                    <button disabled={busy} className={buttonVariants({ variant: 'outline' })}>
                      {m.library_label_rename()}
                    </button>
                  </form>
                </ListRowControl>
              </LabelExposure>
              <LabelExposure page={page} operation="delete">
                <ListRowControl>
                  <form method="post" action={path} onSubmit={onSubmit}>
                    {hidden('delete', label.deleteKey, label.id, label.revision)}
                    <input type="hidden" name="name" value={label.name} />
                    <button disabled={busy} className={buttonVariants({ variant: 'destructive' })}>
                      {m.library_label_delete()}
                    </button>
                  </form>
                </ListRowControl>
              </LabelExposure>
            </ListRow>
          ))}
        </ul>
      ) : !feedback || feedback.ok || feedback.operation ? (
        <p className="text-muted-foreground">{m.library_labels_empty()}</p>
      ) : null}
      {page.next ? (
        <nav>
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={`${path}?cursor=${encodeURIComponent(page.next)}`}
          >
            {m.library_label_more()}
          </a>
        </nav>
      ) : null}
      {feedback?.reason === 'stale_cursor' ? <a href={path}>{m.library_labels_heading()}</a> : null}
    </article>
  );
}
function labelError(feedback: LabelFeedback): string {
  const reason = feedback.reason;
  if (reason === 'library_label_restore_stale') return m.library_label_restore_stale();
  if (reason === 'library_label_restore_expired') return m.library_label_restore_expired();
  if (reason === 'library_label_restore_occupied') return m.library_label_restore_occupied();
  if (feedback.detail) return feedback.detail;
  if (reason === 'conflict') return m.library_label_stale();
  if (reason === 'unavailable' || reason === 'stale_cursor' || reason === 'unauthorized')
    return m.library_labels_unavailable();
  return m.library_label_invalid();
}
