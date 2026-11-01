import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { EllipsisIcon } from 'lucide-react';
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
        className="min-w-0 flex-1 truncate font-medium text-foreground group-hover:underline group-focus-within:underline"
        title={label.name}
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
const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] px-3 py-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
type LabelAction = {
  operation: 'rename' | 'delete';
  label: LabelsPage['labels'][number];
  name: string;
};

function failedAction(page: LabelsPage): LabelAction | null {
  const feedback = page.feedback;
  const label = page.labels.find((label) => label.id === feedback?.id);
  return feedback && !feedback.ok && label && (feedback.operation === 'rename' || feedback.operation === 'delete')
    ? { operation: feedback.operation, label, name: feedback.name ?? label.name }
    : null;
}

export function LabelsPageView({ page: initial }: { page: LabelsPage }) {
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [action, setAction] = useState<LabelAction | null>(() => failedAction(initial));
  const locked = useRef(false);
  const pageRef = useRef<HTMLElement>(null);
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const latestPage = useRef(page);
  latestPage.current = page;
  const latestInitial = useRef(initial);
  latestInitial.current = initial;
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    setPage(initial);
    setAction(failedAction(initial));
  }, [initial]);
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
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(result.ok && input.operation === 'delete' && result.revision !== undefined
          ? { undo: { id: input.id!, name: input.name ?? '', revision: result.revision }, undoKey: crypto.randomUUID() }
          : {}),
      };
      const previousUndo = page.feedback?.undo;
      const retained =
        feedback.undo ||
        (result.ok &&
          input.operation === 'restore' &&
          previousUndo?.id === input.id &&
          previousUndo?.revision === input.revision)
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
        current = result.ok ? { ...page, state: 'unavailable' } : page;
      }
      // A failed refresh must not discard the form or its draft after a refused write.
      if (!result.ok && (current.state === 'unavailable' || current.state === 'preparing')) current = page;
      setPage((visible) => ({
        ...(initialAtSubmit === latestInitial.current ? current : visible),
        feedback: retained,
        undoKey: retained.undoKey ?? visible.undoKey,
      }));
      if (input.operation === 'rename' || input.operation === 'delete') {
        setAction((selected) =>
          !selected || selected.label.id !== input.id
            ? selected
            : result.ok
              ? null
              : {
                  ...selected,
                  label: current.labels.find((label) => label.id === input.id) ?? selected.label,
                },
        );
      }
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
      setPage((current) => ({
        ...current,
        feedback: { ...current.feedback, ...input, ok: false, reason: 'unavailable' },
      }));
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
    <p id={id} role="alert" className="break-words [overflow-wrap:anywhere] text-sm text-destructive">
      {labelError(feedback!)}
    </p>
  );
  function actionForm(selected: LabelAction, fallback = false) {
    const { label, operation } = selected;
    const invalid = fieldError(operation, label.id);
    const errorId = `${operation}-error-${label.id}`;
    return (
      <form method="post" action={mutationPath} onSubmit={onSubmit} className="min-w-0 space-y-4" aria-busy={busy}>
        {hidden(operation, operation === 'rename' ? label.renameKey : label.deleteKey, label.id, label.revision)}
        {operation === 'rename' ? (
          <Field>
            <FieldLabel htmlFor={`label-${label.id}`}>{m.library_label_name()}</FieldLabel>
            <Input
              id={`label-${label.id}`}
              name="name"
              required
              maxLength={1000}
              className={fieldClass}
              disabled={busy}
              {...(fallback
                ? { defaultValue: selected.name }
                : { value: selected.name, onChange: (event) => setAction({ ...selected, name: event.target.value }) })}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
            />
          </Field>
        ) : (
          <input type="hidden" name="name" value={label.name} />
        )}
        {invalid ? error(errorId) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {fallback ? (
            <a href={mutationPath} className={buttonVariants({ variant: 'outline', className: actionClass })}>
              {m.action_cancel()}
            </a>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              disabled={busy}
              onClick={() => setAction(null)}
            >
              {m.action_cancel()}
            </Button>
          )}
          <Button
            type="submit"
            variant={operation === 'rename' ? 'outline' : 'destructive'}
            className={actionClass}
            disabled={busy}
          >
            {operation === 'rename' ? m.library_label_rename() : m.library_label_delete()}
          </Button>
        </div>
      </form>
    );
  }
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
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {m.library_label_deleted({ name: feedback.undo.name })}
        </span>
        <Button type="submit" variant="outline" className={actionClass} disabled={busy}>
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
        <a href={mutationPath} className={buttonVariants({ variant: 'outline', className: actionClass })}>
          {m.library_labels_heading()}
        </a>
      </article>
    );
  if (!page.signedIn)
    return (
      <article className="space-y-6">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <a
          href={`/auth/sign-in?return_to=${encodeURIComponent(path)}`}
          className={buttonVariants({ className: actionClass })}
        >
          {m.library_sign_in()}
        </a>
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
    <article ref={pageRef} tabIndex={-1} className="min-w-0 max-w-3xl space-y-8 text-foreground" aria-busy={busy}>
      <header className="space-y-2">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p className="text-muted-foreground">{m.library_labels_private()}</p>
      </header>
      {feedback &&
      !feedback.ok &&
      !fieldError('create') &&
      !fieldError('rename', feedback.id) &&
      !fieldError('delete', feedback.id)
        ? error('label-error')
        : null}
      <form method="get" action={path} className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1 basis-48">
          <FieldLabel htmlFor="label-prefix">{m.library_labels_prefix()}</FieldLabel>
          <Input id="label-prefix" name="q" className={fieldClass} defaultValue={page.query ?? ''} />
        </Field>
        <Button type="submit" variant="outline" className={actionClass}>
          {m.library_labels_filter()}
        </Button>
        {page.query ? (
          <a href={path} className={buttonVariants({ variant: 'ghost', className: actionClass })}>
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
              <Button type="submit" variant="default" size="lg" className={actionClass} disabled={busy}>
                {m.library_label_create()}
              </Button>
            </div>
            {fieldError('create') ? error('create-error') : null}
          </Field>
        </form>
      </LabelExposure>
      {undoForm}
      {page.labels.length ? (
        <ul className="space-y-1">
          {page.labels.map((label) => {
            const entries: MenuEntry[] = [];
            if (page.operations.includes('library_label.rename'))
              entries.push({
                type: 'item',
                label: m.library_label_rename(),
                onSelect: () => setAction({ operation: 'rename', label, name: label.name }),
              });
            if (page.operations.includes('library_label.delete'))
              entries.push({
                type: 'destructive',
                label: m.library_label_delete(),
                onSelect: () => setAction({ operation: 'delete', label, name: label.name }),
              });
            return (
              <ListRow key={label.id} className="min-w-0 px-2 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <LabelShelfLink label={label} locale={getLocale()} />
                  {hydrated && entries.length ? (
                    <ListRowControl className="shrink-0">
                      <Menu
                        title={m.library_labels_heading()}
                        trigger={
                          <Button
                            ref={(element) => {
                              if (element) actionTriggers.current.set(label.id, element);
                              else actionTriggers.current.delete(label.id);
                            }}
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11"
                            disabled={busy}
                            aria-label={m.library_label_actions({ name: label.name })}
                          >
                            <EllipsisIcon aria-hidden="true" />
                          </Button>
                        }
                        entries={entries}
                      />
                    </ListRowControl>
                  ) : null}
                </div>
                {!hydrated ? (
                  <ListRowControl className="flex min-w-0 flex-wrap gap-2">
                    {(['rename', 'delete'] as const).map((operation) => (
                      <LabelExposure key={operation} page={page} operation={operation}>
                        <details
                          name="library-label-action"
                          className="min-w-0 max-w-full open:basis-full"
                          open={fieldError(operation, label.id) || undefined}
                        >
                          <summary
                            className={buttonVariants({ variant: 'outline', className: `${actionClass} cursor-pointer` })}
                          >
                            {operation === 'rename' ? m.library_label_rename() : m.library_label_delete()}
                          </summary>
                          <div className="space-y-3 py-3">
                            {operation === 'delete' ? (
                              <p className="break-words [overflow-wrap:anywhere]">
                                {m.library_label_delete_confirmation({ name: label.name })}
                              </p>
                            ) : null}
                            {actionForm(
                              {
                                operation,
                                label,
                                name: fieldError(operation, label.id) ? (feedback?.name ?? label.name) : label.name,
                              },
                              true,
                            )}
                          </div>
                        </details>
                      </LabelExposure>
                    ))}
                  </ListRowControl>
                ) : null}
              </ListRow>
            );
          })}
        </ul>
      ) : !feedback || feedback.ok || feedback.operation ? (
        <p className="text-muted-foreground">
          {page.query ? m.library_subject_label_no_results() : m.library_labels_empty()}
        </p>
      ) : null}
      {hydrated && action && page.operations.includes(`library_label.${action.operation}`) ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setAction(null);
          }}
        >
          <DialogContent
            showCloseButton={false}
            finalFocus={() => actionTriggers.current.get(action.label.id) ?? pageRef.current}
            className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto"
          >
            <DialogTitle className="break-words [overflow-wrap:anywhere]">
              {action.operation === 'rename' ? m.library_label_rename() : m.library_label_delete()}
            </DialogTitle>
            <DialogDescription className="break-words [overflow-wrap:anywhere]">
              {action.operation === 'rename'
                ? action.label.name
                : m.library_label_delete_confirmation({ name: action.label.name })}
            </DialogDescription>
            {actionForm(action)}
          </DialogContent>
        </Dialog>
      ) : null}
      {page.next ? (
        <nav>
          <a
            className={buttonVariants({ variant: 'outline', className: actionClass })}
            href={`${path}?${new URLSearchParams({ ...(page.query ? { q: page.query } : {}), cursor: page.next })}`}
          >
            {m.library_label_more()}
          </a>
        </nav>
      ) : null}
      {feedback?.reason === 'stale_cursor' ? (
        <a href={path} className={buttonVariants({ variant: 'outline', className: actionClass })}>
          {m.library_labels_heading()}
        </a>
      ) : null}
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
