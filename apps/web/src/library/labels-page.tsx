import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
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
        className="break-words font-medium text-foreground group-hover:underline group-focus-within:underline"
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
const fieldClass = 'h-11';

export function LabelsPageView({ page: initial }: { page: LabelsPage }) {
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const latestPage = useRef(page);
  latestPage.current = page;
  const latestInitial = useRef(initial);
  latestInitial.current = initial;
  useEffect(() => setPage(initial), [initial]);
  const path = `/${getLocale()}/library/labels`;
  async function submit(input: LabelInput) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    const page = latestPage.current;
    const initialAtSubmit = latestInitial.current;
    try {
      const result = await manageLabel({ data: input, headers: { 'X-CSRF-Token': page.csrfToken } });
      const feedback: LabelFeedback = {
        ...result,
        operation: input.operation,
        id: input.id,
        name: input.name,
        ...(result.ok && input.operation === 'delete' && result.revision !== undefined
          ? { undo: { id: input.id!, name: input.name ?? '', revision: result.revision }, undoKey: crypto.randomUUID() }
          : {}),
      };
      const retained =
        feedback.undo ||
        (result.ok &&
          input.operation === 'restore' &&
          page.feedback?.undo?.id === input.id &&
          page.feedback.undo.revision === input.revision)
          ? feedback
          : {
              ...feedback,
              ...(page.feedback?.undo
                ? {
                    undo: page.feedback.undo,
                    undoKey: page.feedback.undoKey ?? page.undoKey,
                  }
                : {}),
            };
      let current: LabelsPage;
      try {
        current = await readLabelsPage({ data: { query: page.query } });
      } catch {
        current = { ...page, state: 'unavailable' };
      }
      setPage((visible) => ({
        ...(initialAtSubmit === latestInitial.current ? current : visible),
        feedback: retained,
        undoKey: retained.undoKey ?? visible.undoKey,
      }));
      if (feedback.undo) {
        const undo = feedback.undo;
        UndoToast(
          m.library_label_deleted({ name: undo.name }),
          () => {
            void submit({
              operation: 'restore',
              id: undo.id,
              revision: undo.revision,
              idempotencyKey: feedback.undoKey!,
            });
          },
          { undo: m.library_label_undo() },
        );
      }
    } catch {
      setPage((current) => ({ ...current, feedback: { ...current.feedback, ok: false, reason: 'unavailable' } }));
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
      {page.feedback?.undo ? (
        <>
          <input type="hidden" name="undoId" value={page.feedback.undo.id} />
          <input type="hidden" name="undoName" value={page.feedback.undo.name} />
          <input type="hidden" name="undoRevision" value={page.feedback.undo.revision} />
          <input type="hidden" name="undoKey" value={page.feedback.undoKey ?? page.undoKey} />
        </>
      ) : null}
    </>
  );
  const feedback = page.feedback;
  const mutationPath = page.query ? `${path}?${new URLSearchParams({ q: page.query })}` : path;
  const fieldError = (operation: string, id?: string) =>
    feedback && !feedback.ok && feedback.operation === operation && feedback.id === id;
  const error = (id: string) => (
    <p id={id} role="alert" className="text-sm text-destructive">
      {labelError(feedback!)}
    </p>
  );
  const undoForm = feedback?.undo ? (
    <LabelExposure page={page} operation="delete">
      <form
        method="post"
        action={mutationPath}
        onSubmit={onSubmit}
        className="flex flex-wrap items-center gap-3 rounded-md border p-3"
        role="status"
      >
        {hidden('restore', feedback.undoKey ?? page.undoKey, feedback.undo.id, feedback.undo.revision)}
        <input type="hidden" name="name" value={feedback.undo.name} />
        <span className="min-w-0 break-words">{m.library_label_deleted({ name: feedback.undo.name })}</span>
        <Button type="submit" variant="outline" disabled={busy}>
          {m.library_label_undo()}
        </Button>
      </form>
    </LabelExposure>
  ) : null;
  if (page.state && page.state !== 'loaded')
    return (
      <article className="max-w-3xl space-y-6">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p role={page.state === 'unavailable' ? 'alert' : 'status'}>
          {page.state === 'preparing'
            ? m.library_labels_preparing()
            : page.state === 'denied'
              ? m.library_labels_denied()
              : page.state === 'closed'
                ? m.library_subject_label_closed()
                : m.library_labels_unavailable()}
        </p>
        {feedback && !feedback.ok ? error('label-error') : null}
        {undoForm}
        <a href={mutationPath} className={buttonVariants({ variant: 'outline' })}>
          {m.library_labels_heading()}
        </a>
      </article>
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
      <form method="get" action={path} className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1 basis-48">
          <FieldLabel htmlFor="label-prefix">{m.library_labels_prefix()}</FieldLabel>
          <Input id="label-prefix" name="q" defaultValue={page.query ?? ''} />
        </Field>
        <Button type="submit" variant="outline">
          {m.library_labels_filter()}
        </Button>
        {page.query ? (
          <a href={path} className={buttonVariants({ variant: 'ghost' })}>
            {m.library_clear_state()}
          </a>
        ) : null}
      </form>
      <LabelExposure page={page} operation="create">
        <form key={page.createKey} method="post" action={mutationPath} onSubmit={onSubmit} className="space-y-2">
          {hidden('create', page.createKey)}
          <Field>
            <FieldLabel htmlFor="new-label">{m.library_label_name()}</FieldLabel>
            <div className="flex flex-wrap gap-2">
              <Input
                id="new-label"
                name="name"
                required
                maxLength={1000}
                className={`${fieldClass} flex-1 basis-48`}
                defaultValue={fieldError('create') ? feedback?.name : ''}
                aria-invalid={fieldError('create') || undefined}
                aria-describedby={fieldError('create') ? 'create-error' : undefined}
              />
              <Button type="submit" disabled={busy} className={buttonVariants({ variant: 'default', size: 'lg' })}>
                {m.library_label_create()}
              </Button>
            </div>
            {fieldError('create') ? error('create-error') : null}
          </Field>
        </form>
      </LabelExposure>
      {undoForm}
      {page.labels.length ? (
        <ul className="space-y-3">
          {page.labels.map((label) => (
            <ListRow key={`${label.id}:${label.renameKey}`} className="space-y-3 py-3">
              <LabelShelfLink label={label} locale={getLocale()} />
              <LabelExposure page={page} operation="rename">
                <ListRowControl>
                  <form method="post" action={mutationPath} onSubmit={onSubmit} className="space-y-2">
                    {hidden('rename', label.renameKey, label.id, label.revision)}
                    <Field>
                      <FieldLabel htmlFor={`label-${label.id}`} className="sr-only">
                        {m.library_label_name()}
                      </FieldLabel>
                      <Input
                        id={`label-${label.id}`}
                        name="name"
                        required
                        maxLength={1000}
                        className={fieldClass}
                        defaultValue={
                          fieldError('rename', label.id) && feedback?.reason !== 'conflict'
                            ? feedback?.name
                            : label.name
                        }
                        aria-invalid={fieldError('rename', label.id) || undefined}
                        aria-describedby={fieldError('rename', label.id) ? `rename-error-${label.id}` : undefined}
                      />
                      {fieldError('rename', label.id) ? error(`rename-error-${label.id}`) : null}
                      <Button type="submit" disabled={busy} className={buttonVariants({ variant: 'outline' })}>
                        {m.library_label_rename()}
                      </Button>
                    </Field>
                  </form>
                </ListRowControl>
              </LabelExposure>
              <LabelExposure page={page} operation="delete">
                <ListRowControl>
                  <form method="post" action={mutationPath} onSubmit={onSubmit}>
                    {hidden('delete', label.deleteKey, label.id, label.revision)}
                    <input type="hidden" name="name" value={label.name} />
                    <Button type="submit" disabled={busy} className={buttonVariants({ variant: 'destructive' })}>
                      {m.library_label_delete()}
                    </Button>
                  </form>
                </ListRowControl>
              </LabelExposure>
            </ListRow>
          ))}
        </ul>
      ) : !feedback || feedback.ok || feedback.operation ? (
        <p className="text-muted-foreground">
          {page.query ? m.library_subject_label_no_results() : m.library_labels_empty()}
        </p>
      ) : null}
      {page.next ? (
        <nav>
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={`${path}?${new URLSearchParams({ ...(page.query ? { q: page.query } : {}), cursor: page.next })}`}
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
  if (reason === 'library_label_restore_capacity') return m.library_subject_label_restore_capacity();
  if (reason === 'library_label_capacity') return m.library_subject_label_capacity();
  if (feedback.detail) return feedback.detail;
  if (reason === 'conflict') return m.library_label_stale();
  if (reason === 'unavailable' || reason === 'stale_cursor' || reason === 'unauthorized')
    return m.library_labels_unavailable();
  return m.library_label_invalid();
}
