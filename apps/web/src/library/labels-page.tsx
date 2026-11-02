import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { EllipsisIcon } from 'lucide-react';
import { undoToast as UndoToast } from '@rezics/ui/undo-toast';
import { toast } from '@rezics/ui/shadcn/toast';
import { manageLabel } from './labels-actions';
import { readLabelsPage } from './labels-read-route';
import type { LabelInput, LabelsPage, LabelFeedback } from './labels-read';
import { shelfHref } from './shelf-params';
import type { LibraryLabelSummary } from './subject-labels';
import type { ManagementGuard } from './management-current-origin';
import type { GatedOperation } from '../kernel/exposure';
import { hasUnsentLabelName, useLabelDraftNavigation } from './label-draft-navigation';

/** A catalogue label opens its complete personal shelf. */
export function LabelShelfLink({ label, locale }: { label: LibraryLabelSummary; locale: string }) {
  return (
    <>
      <ContentItemTitleLink
        as={ListRowLink}
        stretch={false}
        data-library-label-link
        href={shelfHref(locale, { label: label.id })}
      >
        {label.name}
      </ContentItemTitleLink>
      <ContentItemHeading
        level={2}
        className="min-w-0 flex-1 line-clamp-2 break-words text-[17px] leading-snug font-semibold [overflow-wrap:anywhere] sm:line-clamp-1 sm:text-lg md:text-xl"
        title={label.name}
      >
        {label.name}
      </ContentItemHeading>
    </>
  );
}

// The private loader's Exposure snapshot also gates the server-rendered, no-script forms.
function LabelExposure({
  page,
  operation,
  children,
  current,
}: {
  page: LabelsPage;
  operation: 'create' | 'rename' | 'delete';
  children: ReactNode;
  current?: ManagementGuard['isCurrent'] | undefined;
}) {
  const name = `library_label.${operation}` as const;
  return page.operations.includes(name) && (!current || current(name)) ? children : null;
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
  if (!feedback || feedback.ok || (feedback.operation !== 'rename' && feedback.operation !== 'delete')) return null;
  // A committed write can disappear from the refreshed prefix page before its reply arrives.
  // Keep its recovery form separate from the current catalogue, without inventing a live row.
  const captured = feedback.retry;
  const target =
    label ??
    (feedback.id && captured?.revision !== undefined
      ? {
          id: feedback.id,
          name: feedback.name ?? '',
          revision: captured.revision,
          renameKey: captured.idempotencyKey,
          deleteKey: captured.idempotencyKey,
        }
      : null);
  if (!target) return null;
  return {
    operation: feedback.operation,
    label: {
      ...target,
      ...(captured
        ? {
            revision: captured.revision ?? target.revision,
            [feedback.operation === 'rename' ? 'renameKey' : 'deleteKey']: captured.idempotencyKey,
          }
        : {}),
    },
    name: feedback.name ?? target.name,
  };
}

const alwaysCurrent = () => true;
const sameInput = (a: LabelInput, b: LabelInput) =>
  a.operation === b.operation &&
  a.id === b.id &&
  (a.operation === 'restore' || a.name === b.name) &&
  a.revision === b.revision;
type Attempt = {
  input: LabelInput;
  renderedKey: string;
  unresolved: boolean;
  headers: HeadersInit;
  send: typeof manageLabel;
};

export function LabelsPageView({
  page: initial,
  isCurrent = alwaysCurrent,
  refresh,
  originating,
  cursor,
  locale = getLocale(),
}: {
  page: LabelsPage;
  isCurrent?: () => boolean;
  refresh?: () => Promise<LabelsPage | null>;
  originating?: ManagementGuard | undefined;
  cursor?: string;
  locale?: string;
}) {
  const [page, setPage] = useState(initial);
  const [source, setSource] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [action, setAction] = useState<LabelAction | null>(() => failedAction(initial));
  const [createName, setCreateName] = useState(() =>
    initial.feedback?.operation === 'create' && !initial.feedback.ok ? (initial.feedback.name ?? '') : '',
  );
  const createField = useRef<HTMLInputElement>(null);
  const renameField = useRef<HTMLInputElement>(null);
  const locked = useRef<{ current: () => boolean } | null>(null);
  const mounted = useRef(false);
  const attempts = useRef(new Map<string, Attempt>());
  const ownedToast = useRef<{ id: string; owner: string } | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const latestPage = useRef(page);
  const path = `/${locale}/library/labels`;
  const alive = () => mounted.current && isCurrent();
  function retireToast() {
    const owned = ownedToast.current;
    ownedToast.current = null;
    if (!owned) return;
    // UndoToast uses a shared replaceable ID. A functional update scrubs only our installed entry.
    toast.update(owned.id, (previous) =>
      previous.data?.labelsOwner === owned.owner
        ? {
            title: '',
            description: '',
            actionProps: { disabled: true, children: null, onClick: undefined },
            timeout: 1,
          }
        : {},
    );
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      retireToast();
    };
  }, []);
  useEffect(() => setHydrated(true), []);
  function preserveAttempts(fresh: LabelsPage, previous: LabelsPage): LabelsPage {
    let next = fresh;
    for (const { input, unresolved } of attempts.current.values()) {
      if (!unresolved) continue;
      if (input.operation === 'create') next = { ...next, createKey: previous.createKey };
      if (input.operation === 'restore' && previous.feedback?.undo)
        next = { ...next, feedback: previous.feedback, undoKey: previous.undoKey };
    }
    return next;
  }
  // Reconcile during render: a loader replacement must never expose an effect-delayed old page.
  if (source !== initial) {
    const next = preserveAttempts(initial, page);
    setSource(initial);
    setPage(next);
    // An open confirmation owns the revision it showed, even after a newer read.
    setAction((selected) => selected ?? failedAction(next));
  }
  latestPage.current = page;
  if (locked.current && !locked.current.current()) {
    locked.current = null;
    setBusy(false);
  }
  const operationOf = (input: LabelInput) =>
    `library_label.${input.operation === 'restore' ? 'delete' : input.operation}` as GatedOperation;
  function admitted(input: LabelInput) {
    const current = latestPage.current;
    return (
      alive() &&
      current.signedIn &&
      (!current.state || current.state === 'loaded') &&
      (originating
        ? originating.isCurrent(operationOf(input)) && !!originating.headers(operationOf(input))
        : !!current.csrfToken) &&
      current.operations.includes('library_label.list') &&
      current.operations.includes(`library_label.${input.operation === 'restore' ? 'delete' : input.operation}`)
    );
  }
  function originalName(operation: 'create' | 'rename', id = '') {
    const attempt = attempts.current.get(`${operation}:${id}`);
    if (attempt) return attempt.unresolved ? attempt.input.name : undefined;
    const feedback = page.feedback;
    return feedback?.operation === operation &&
      (feedback.id ?? '') === id &&
      !feedback.ok &&
      feedback.reason === 'unavailable'
      ? feedback.name
      : undefined;
  }
  const createDirty = hasUnsentLabelName(createName, '', originalName('create'));
  const renameDirty =
    action?.operation === 'rename' &&
    hasUnsentLabelName(action.name, action.label.name, originalName('rename', action.label.id));
  const navigation = useLabelDraftNavigation({
    dirty: createDirty || renameDirty,
    isCurrent: () =>
      (createDirty && admitted({ operation: 'create', idempotencyKey: page.createKey })) ||
      (renameDirty && admitted({ operation: 'rename', idempotencyKey: action!.label.renameKey })),
    focus: () => (renameDirty ? renameField.current : createField.current),
  });
  function chooseAction(next: LabelAction | null) {
    void navigation.confirm(renameDirty).then((discard) => {
      if (
        discard &&
        alive() &&
        !locked.current &&
        (!originating || originating.isCurrent(`library_label.${next?.operation ?? action?.operation ?? 'rename'}`))
      )
        setAction(next);
    });
  }
  async function submit(supplied: LabelInput) {
    if (!admitted(supplied) || locked.current) return;
    const slot = `${supplied.operation}:${supplied.id ?? ''}`;
    const previous = attempts.current.get(slot);
    const input =
      previous &&
      (previous.unresolved ||
        (sameInput(previous.input, supplied) &&
          (previous.renderedKey === supplied.idempotencyKey ||
            previous.input.idempotencyKey === supplied.idempotencyKey)))
        ? previous.input
        : {
            ...supplied,
            idempotencyKey:
              previous &&
              (previous.input.idempotencyKey === supplied.idempotencyKey ||
                previous.renderedKey === supplied.idempotencyKey) &&
              !sameInput(previous.input, supplied)
                ? crypto.randomUUID()
                : supplied.idempotencyKey,
          };
    const headers = originating
      ? originating.headers(operationOf(input))
      : { 'X-CSRF-Token': latestPage.current.csrfToken };
    if (!headers) return;
    const attempt: Attempt = previous?.unresolved
      ? previous
      : {
          input,
          renderedKey: supplied.idempotencyKey,
          unresolved: true,
          headers: new Headers(headers),
          send: manageLabel,
        };
    attempts.current.set(slot, attempt);
    const lock = { current: () => admitted(input) };
    locked.current = lock;
    setBusy(true);
    const page = latestPage.current;
    try {
      if (!admitted(input)) return;
      const result = await attempt.send({ data: attempt.input, headers: attempt.headers });
      if (!admitted(input)) return;
      attempt.unresolved = !result.ok && result.reason === 'unavailable';
      if (result.ok && input.operation === 'create') setCreateName((value) => (value === input.name ? '' : value));
      if (result.ok && input.operation === 'rename')
        setAction((selected) =>
          !selected || selected.label.id !== input.id
            ? selected
            : selected.name === input.name
              ? null
              : { ...selected, label: { ...selected.label, name: input.name ?? selected.label.name } },
        );
      const feedback: LabelFeedback = {
        ...result,
        operation: input.operation,
        ...(!result.ok
          ? {
              retry: {
                idempotencyKey: input.idempotencyKey,
                ...(input.revision === undefined ? {} : { revision: input.revision }),
              },
            }
          : {}),
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(result.ok && input.operation === 'delete' && result.revision !== undefined
          ? { undo: { id: input.id!, name: input.name ?? '', revision: result.revision }, undoKey: crypto.randomUUID() }
          : {}),
      };
      const previousUndo = page.feedback?.undo;
      const undoUnavailable =
        input.operation === 'restore' &&
        ['library_label_restore_stale', 'library_label_restore_expired', 'not_found'].includes(result.reason ?? '');
      const retained =
        feedback.undo ||
        undoUnavailable ||
        (result.ok &&
          input.operation === 'restore' &&
          previousUndo?.id === input.id &&
          previousUndo?.revision === input.revision)
          ? feedback
          : {
              ...feedback,
              ...(previousUndo ? { undo: previousUndo, undoKey: page.feedback?.undoKey ?? page.undoKey } : {}),
            };
      let current: LabelsPage | null;
      try {
        if (!admitted(input)) return;
        current = refresh ? await refresh() : await readLabelsPage({ data: { query: page.query, cursor } });
        if (!admitted(input) || !current) return;
      } catch {
        if (!admitted(input)) return;
        current = result.ok ? { ...page, state: 'unavailable' } : latestPage.current;
      }
      if (!admitted(input)) return;
      // A failed refresh must not discard the form or its draft after a refused write.
      if (!result.ok && (current.state === 'unavailable' || current.state === 'preparing'))
        current = latestPage.current;
      if (
        !current.signedIn ||
        !current.operations.includes('library_label.list') ||
        (current.state && current.state !== 'loaded')
      ) {
        retireToast();
        setPage({ ...current, feedback: retained, undoKey: retained.undoKey ?? current.undoKey });
        setAction(null);
        return;
      }
      current = preserveAttempts(current, latestPage.current);
      setPage({ ...current, feedback: retained, undoKey: retained.undoKey ?? current.undoKey });
      if (input.operation === 'rename' || input.operation === 'delete') {
        setAction((selected) =>
          !selected || selected.label.id !== input.id
            ? selected
            : result.ok && (input.operation === 'delete' || selected.name === input.name)
              ? null
              : selected,
        );
      }
      if ((result.ok && input.operation === 'restore') || undoUnavailable) retireToast();
      if (feedback.undo && admitted(input)) {
        const undo = feedback.undo;
        retireToast();
        const owner = crypto.randomUUID();
        const id = UndoToast(
          m.library_label_deleted({ name: undo.name }),
          () => {
            if (!admitted({ operation: 'restore', idempotencyKey: feedback.undoKey! })) return;
            void submit({
              operation: 'restore',
              id: undo.id,
              revision: undo.revision,
              idempotencyKey: feedback.undoKey!,
            });
          },
          { undo: m.library_label_undo() },
        );
        ownedToast.current = { id, owner };
        toast.update(id, { data: { labelsOwner: owner } });
      }
    } catch {
      if (!admitted(input)) return;
      setPage((current) => ({
        ...current,
        feedback: {
          ...current.feedback,
          ...input,
          ok: false,
          reason: 'unavailable',
          retry: {
            idempotencyKey: input.idempotencyKey,
            ...(input.revision === undefined ? {} : { revision: input.revision }),
          },
        },
      }));
    } finally {
      if (alive() && (!originating || originating.isCurrent(operationOf(input))) && locked.current === lock) {
        locked.current = null;
        setBusy(false);
      }
    }
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!alive()) return;
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
  const staleCursor =
    feedback?.reason === 'stale_cursor' && (!page.state || page.state === 'loaded' || page.state === 'unavailable');
  const firstPageSearch = new URLSearchParams(page.query !== undefined ? { q: page.query } : {});
  const firstPagePath = firstPageSearch.size ? `${path}?${firstPageSearch}` : path;
  const search = new URLSearchParams({
    ...(page.query !== undefined ? { q: page.query } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const mutationPath = search.size ? `${path}?${search}` : path;
  const fieldError = (operation: string, id?: string) =>
    feedback && !feedback.ok && feedback.operation === operation && feedback.id === id;
  const error = (id: string) => (
    <p id={id} role="alert" className="break-words [overflow-wrap:anywhere] text-sm text-destructive">
      {labelError(feedback!)}
    </p>
  );
  function actionForm(selected: LabelAction, fallback = false) {
    const { operation } = selected;
    const failed = fallback ? failedAction(page) : null;
    const label =
      failed?.operation === operation && failed.label.id === selected.label.id ? failed.label : selected.label;
    const invalid = fieldError(operation, label.id);
    const errorId = `${operation}-error-${label.id}`;
    return (
      <form method="post" action={mutationPath} onSubmit={onSubmit} className="min-w-0 space-y-4" aria-busy={busy}>
        {hidden(operation, operation === 'rename' ? label.renameKey : label.deleteKey, label.id, label.revision)}
        {operation === 'rename' ? (
          <Field>
            <FieldLabel htmlFor={`label-${label.id}`}>{m.library_label_name()}</FieldLabel>
            <Input
              ref={fallback ? undefined : renameField}
              id={`label-${label.id}`}
              name="name"
              required
              maxLength={1000}
              className={fieldClass}
              disabled={busy}
              {...(fallback
                ? { defaultValue: selected.name }
                : {
                    value: selected.name,
                    onChange: (event) => {
                      if (
                        alive() &&
                        (!originating || originating.isCurrent(`library_label.${selected.operation}`)) &&
                        !locked.current
                      )
                        setAction({ ...selected, name: event.target.value });
                    },
                  })}
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
            <a
              onClick={(event) => {
                if (!alive()) event.preventDefault();
              }}
              href={mutationPath}
              className={buttonVariants({ variant: 'outline', className: actionClass })}
            >
              {m.action_cancel()}
            </a>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              disabled={busy}
              onClick={() => {
                if (
                  alive() &&
                  (!originating || originating.isCurrent(`library_label.${selected.operation}`)) &&
                  !locked.current
                )
                  chooseAction(null);
              }}
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
    <LabelExposure current={hydrated ? originating?.isCurrent : undefined} page={page} operation="delete">
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
          {staleCursor
            ? m.library_labels_stale_cursor()
            : page.state === 'preparing'
              ? m.library_labels_preparing()
              : page.state === 'denied'
                ? m.library_labels_denied()
                : page.state === 'closed'
                  ? m.library_subject_label_closed()
                  : m.library_labels_unavailable()}
        </p>
        {feedback && !feedback.ok && feedback.operation ? error('label-error') : null}
        {undoForm}
        <a
          onClick={(event) => {
            if (!alive()) event.preventDefault();
          }}
          href={staleCursor ? firstPagePath : mutationPath}
          className={buttonVariants({ variant: 'outline', className: actionClass })}
        >
          {staleCursor ? m.library_collections_first_page() : m.subject_view_retry()}
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
      {navigation.boundary}
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
      <form
        method="get"
        action={path}
        onSubmit={(event) => {
          if (!alive()) event.preventDefault();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <Field className="min-w-0 flex-1 basis-48">
          <FieldLabel htmlFor="label-prefix">{m.library_labels_prefix()}</FieldLabel>
          <Input id="label-prefix" name="q" className={fieldClass} defaultValue={page.query ?? ''} />
        </Field>
        <Button type="submit" variant="outline" className={actionClass}>
          {m.library_labels_filter()}
        </Button>
        {page.query ? (
          <a
            onClick={(event) => {
              if (!alive()) event.preventDefault();
            }}
            href={path}
            className={buttonVariants({ variant: 'ghost', className: actionClass })}
          >
            {m.library_clear_state()}
          </a>
        ) : null}
      </form>
      <LabelExposure current={hydrated ? originating?.isCurrent : undefined} page={page} operation="create">
        <form key={page.createKey} method="post" action={mutationPath} onSubmit={onSubmit} className="space-y-2">
          {hidden('create', page.createKey)}
          <Field>
            <FieldLabel htmlFor="new-label">{m.library_label_name()}</FieldLabel>
            <div className="flex flex-wrap gap-2">
              <Input
                ref={createField}
                id="new-label"
                name="name"
                required
                maxLength={1000}
                className={`${fieldClass} flex-1 basis-48`}
                value={createName}
                onChange={(event) => {
                  if (alive() && (!originating || originating.isCurrent('library_label.create')))
                    setCreateName(event.target.value);
                }}
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
      {!hydrated && failedAction(page) && !page.labels.some((label) => label.id === feedback?.id) ? (
        <LabelExposure page={page} operation={failedAction(page)!.operation}>
          {actionForm(failedAction(page)!, true)}
        </LabelExposure>
      ) : null}
      {page.labels.length ? (
        <ul className="space-y-1">
          {page.labels.map((label) => {
            const entries: MenuEntry[] = [];
            if (
              page.operations.includes('library_label.rename') &&
              (!originating || originating.isCurrent('library_label.rename'))
            )
              entries.push({
                type: 'item',
                label: m.library_label_rename(),
                onSelect: () => {
                  if (alive() && (!originating || originating.isCurrent('library_label.rename')) && !locked.current)
                    chooseAction({ operation: 'rename', label, name: label.name });
                },
              });
            if (
              page.operations.includes('library_label.delete') &&
              (!originating || originating.isCurrent('library_label.delete'))
            )
              entries.push({
                type: 'destructive',
                label: m.library_label_delete(),
                onSelect: () => {
                  if (alive() && (!originating || originating.isCurrent('library_label.delete')) && !locked.current)
                    chooseAction({ operation: 'delete', label, name: label.name });
                },
              });
            return (
              <ListRow key={label.id} className="min-w-0 px-2 py-3 sm:py-4">
                <div className="flex min-w-0 items-start gap-3">
                  <LabelShelfLink label={label} locale={locale} />
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
                  <div className="flex min-w-0 flex-wrap gap-2">
                    {(['rename', 'delete'] as const).map((operation) => (
                      <LabelExposure
                        current={hydrated ? originating?.isCurrent : undefined}
                        key={operation}
                        page={page}
                        operation={operation}
                      >
                        <ListRowControl className="min-w-0 max-w-full has-[details[open]]:basis-full">
                          <details
                            name="library-label-action"
                            className="min-w-0 max-w-full open:basis-full"
                            open={fieldError(operation, label.id) || undefined}
                          >
                            <summary
                              className={buttonVariants({
                                variant: 'outline',
                                className: `${actionClass} cursor-pointer`,
                              })}
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
                        </ListRowControl>
                      </LabelExposure>
                    ))}
                  </div>
                ) : null}
              </ListRow>
            );
          })}
        </ul>
      ) : !feedback || feedback.ok || feedback.operation ? (
        <p className="text-muted-foreground">
          {cursor !== undefined
            ? m.library_labels_page_empty()
            : page.query
              ? m.library_subject_label_no_results()
              : m.library_labels_empty()}
        </p>
      ) : null}
      {hydrated &&
      action &&
      page.operations.includes(`library_label.${action.operation}`) &&
      (!originating || originating.isCurrent(`library_label.${action.operation}`)) ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (
              alive() &&
              (!originating || originating.isCurrent(`library_label.${action.operation}`)) &&
              !open &&
              !locked.current
            )
              chooseAction(null);
          }}
        >
          <DialogContent
            showCloseButton={false}
            finalFocus={() => (alive() ? (actionTriggers.current.get(action.label.id) ?? pageRef.current) : false)}
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
      {cursor !== undefined || page.next || staleCursor ? (
        <nav className="flex flex-wrap gap-2">
          {cursor !== undefined || staleCursor ? (
            <a
              onClick={(event) => {
                if (!alive()) event.preventDefault();
              }}
              href={firstPagePath}
              className={buttonVariants({ variant: 'outline', className: actionClass })}
            >
              {m.library_collections_first_page()}
            </a>
          ) : null}
          {page.next && !staleCursor ? (
            <a
              className={buttonVariants({ variant: 'outline', className: actionClass })}
              onClick={(event) => {
                if (!alive()) event.preventDefault();
              }}
              href={`${path}?${new URLSearchParams({ ...(page.query !== undefined ? { q: page.query } : {}), cursor: page.next })}`}
            >
              {m.library_label_more()}
            </a>
          ) : null}
        </nav>
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
  if (reason === 'stale_cursor') return m.library_labels_stale_cursor();
  if (reason === 'unavailable')
    return feedback.operation ? m.library_label_unconfirmed() : m.library_labels_unavailable();
  if (reason === 'unauthorized') return m.library_labels_unavailable();
  return m.library_label_invalid();
}
