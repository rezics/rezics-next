import { useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@rezics/ui/shadcn/empty';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@rezics/ui/shadcn/alert-dialog';
import { ContentItem } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Tombstone } from '@rezics/ui/tombstone';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { useContextIntent } from './intent';
import { useContextCurrent } from './lifetime';
import {
  admits,
  detailHref,
  directoryHref,
  lifecycleOperation,
  type Actions,
  type Command,
  type DirectoryInput,
  type DirectoryWorkspace,
  type Failure,
  type MutationResult,
  type Result,
  type Workspace,
} from './model';
import {
  capturedMatches,
  emptyLabelRow,
  labelsFromDraft,
  policyFingerprint,
  policyPreview,
  type LabelRow,
  type SettingsPreview,
  type SettingsRead,
} from './settings';
import { CapturedSettings, ContextLabelRows, SettingsPicker, SettingsReview } from './settings-view';

const width = 'mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]';
const actionClassName = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-md py-2 underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const options = (locale: string) => ({ locale: locale as never });
function failureText(kind: Failure['kind'], locale: string) {
  const o = options(locale);
  switch (kind) {
    case 'signed-out':
      return m.ctxw_signed_out({}, o);
    case 'denied':
      return m.ctxw_denied({}, o);
    case 'missing':
      return m.ctxw_missing({}, o);
    case 'invalid':
      return m.ctxw_invalid({}, o);
    case 'conflict':
      return m.ctxw_conflict({}, o);
    case 'stale':
      return m.ctxw_stale({}, o);
    case 'unknown':
      return m.ctxw_unknown({}, o);
    default:
      return m.ctxw_unavailable({}, o);
  }
}
export function ContextFeedback({ failure, locale, retry }: { failure: Failure; locale: string; retry?: () => void }) {
  return (
    <div role="alert" className="space-y-3">
      <p>{failureText(failure.kind, locale)}</p>
      {retry ? (
        <Button className={actionClassName} variant="outline" onClick={retry}>
          {m.ctxw_reread({}, options(locale))}
        </Button>
      ) : null}
      {failure.kind === 'signed-out' ? (
        <a className={linkClassName} href={`/auth/sign-in?return_to=${encodeURIComponent(directoryHref(locale))}`}>
          {m.account_sign_in({}, options(locale))}
        </a>
      ) : null}
    </div>
  );
}
function ContextDeparture({
  locale,
  protect,
  unsettled,
  current,
  onLeave,
}: {
  locale: string;
  protect: boolean;
  unsettled: boolean;
  current: () => boolean;
  onLeave: () => void;
}) {
  const router = useRouter({ warn: false });
  return router ? (
    <ContextRouterDeparture
      locale={locale}
      protect={protect}
      unsettled={unsettled}
      current={current}
      onLeave={onLeave}
    />
  ) : null;
}
function ContextRouterDeparture({
  locale,
  protect,
  unsettled,
  current,
  onLeave,
}: {
  locale: string;
  protect: boolean;
  unsettled: boolean;
  current: () => boolean;
  onLeave: () => void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const stayButton = useRef<HTMLButtonElement>(null);
  const resolved = useRef(false);
  const leaving = useRef(false);
  const shouldBlockFn = useCallback(() => {
    if (!protect || !current()) return false;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    resolved.current = false;
    leaving.current = false;
    return true;
  }, [protect, current]);
  const blocker = useBlocker({
    shouldBlockFn,
    disabled: !protect,
    enableBeforeUnload: () => protect && current(),
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useLayoutEffect(
    () => () => {
      const pending = blockerRef.current;
      if (pending.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pending.reset();
      }
    },
    [],
  );
  useEffect(() => {
    if ((!protect || !current()) && blocker.status === 'blocked' && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [protect, current, blocker]);

  function resolve(leave: boolean) {
    if (!current() || blocker.status !== 'blocked' || resolved.current) return;
    resolved.current = true;
    leaving.current = leave;
    if (leave) {
      onLeave();
      blocker.proceed();
    } else blocker.reset();
  }

  const o = options(locale);
  return (
    <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(open) => !open && resolve(false)}>
      <AlertDialogContent
        initialFocus={stayButton}
        finalFocus={() => (leaving.current ? false : returnFocus.current?.isConnected ? returnFocus.current : false)}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{m.zone_editor_leave({}, o)}</AlertDialogTitle>
          <AlertDialogDescription>
            {unsettled ? m.thread_authoring_leave_pending({}, o) : m.thread_authoring_leave_unsaved({}, o)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={stayButton}>{m.thread_authoring_stay({}, o)}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => resolve(true)}>
            {unsettled ? m.thread_authoring_leave({}, o) : m.zone_editor_discard({}, o)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function Permission({ actions, locale }: { actions: Result<Actions> | null; locale: string }) {
  const o = options(locale);
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {!actions
        ? m.ctxw_loading({}, o)
        : actions.kind !== 'ready'
          ? m.ctxw_actions_unavailable({}, o)
          : m.ctxw_current_actions({}, o)}
    </p>
  );
}
function MutationFeedback({ intent, locale }: { intent: ReturnType<typeof useContextIntent>; locale: string }) {
  const o = options(locale);
  const result = intent.result;
  if (intent.busy) return <p role="status">{m.ctxw_loading({}, o)}</p>;
  if (!result) return null;
  return (
    <div
      ref={intent.feedback as RefObject<HTMLDivElement>}
      tabIndex={-1}
      role={result.kind === 'confirmed' ? 'status' : 'alert'}
      className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p>{result.kind === 'confirmed' ? m.ctxw_confirmed({}, o) : failureText(result.kind, locale)}</p>
      {result.kind === 'confirmed' && result.current.kind !== 'ready' ? (
        <ContextFeedback failure={result.current} locale={locale} />
      ) : null}
      {result.kind === 'unknown' && intent.pending ? (
        <Button className={actionClassName} onClick={() => void intent.submit(intent.pending)}>
          {m.ctxw_retry_same({}, o)}
        </Button>
      ) : null}
      {intent.pending ? (
        <div className="flex flex-wrap gap-2">
          <Button className={actionClassName} variant="outline" onClick={() => void intent.refresh()}>
            {m.ctxw_reread({}, o)}
          </Button>
          {result.kind !== 'unknown' ? (
            <Button className={actionClassName} variant="outline" onClick={() => void intent.refresh(true)}>
              {m.ctxw_review_request({}, o)}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
export function ContextDirectoryView({
  locale,
  input,
  data,
  reload,
}: {
  locale: string;
  input: DirectoryInput;
  data: DirectoryWorkspace | null;
  reload: () => Promise<unknown>;
}) {
  const o = options(locale);
  const searchId = useId();
  const page = data?.page;
  const canCreate = data && admits(data.creation, 'create');
  const emptyTitle =
    page?.kind === 'ready' && page.value.next
      ? m.ctxw_empty_page({}, o)
      : input.cursor
        ? m.ctxw_empty_final_page({}, o)
        : input.query
          ? m.ctxw_no_matches({}, o)
          : m.ctxw_empty({}, o);
  const emptyHelp =
    page?.kind === 'ready' && page.value.next
      ? m.ctxw_empty_page_help({}, o)
      : input.cursor
        ? m.ctxw_empty_final_page_help({}, o)
        : m.ctxw_empty_help({}, o);
  return (
    <article className={width} aria-busy={!data}>
      <header className="space-y-3">
        <PageHeading>{m.ctxw_title({}, o)}</PageHeading>
        <p className="max-w-prose text-muted-foreground">{m.ctxw_intro({}, o)}</p>
        {canCreate ? (
          <a className={cn(buttonVariants(), actionClassName)} href={`${directoryHref(locale)}/new`}>
            {m.ctxw_create({}, o)}
          </a>
        ) : (
          <Button className={actionClassName} disabled>
            {m.ctxw_create({}, o)}
          </Button>
        )}
        <Permission actions={data?.creation ?? null} locale={locale} />
      </header>
      <nav aria-label={m.ctxw_views({}, o)} className="flex flex-wrap gap-4">
        <a
          className={linkClassName}
          aria-current={!input.deleted ? 'page' : undefined}
          href={directoryHref(locale, { query: input.query })}
        >
          {m.ctxw_active({}, o)}
        </a>
        <a
          className={linkClassName}
          aria-current={input.deleted ? 'page' : undefined}
          href={directoryHref(locale, { query: input.query, deleted: true })}
        >
          {m.ctxw_deleted({}, o)}
        </a>
      </nav>
      <form action={directoryHref(locale)} method="get" className="flex flex-wrap items-end gap-3">
        <Field className="min-w-0 flex-1 basis-48">
          <FieldLabel htmlFor={searchId}>{m.ctxw_search({}, o)}</FieldLabel>
          <Input id={searchId} name="query" type="search" defaultValue={input.query ?? ''} />
        </Field>
        {input.deleted ? <input type="hidden" name="deleted" value="true" /> : null}
        <Button className={actionClassName} type="submit" variant="outline">
          {m.ctxw_search_action({}, o)}
        </Button>
      </form>
      {!page ? (
        <p role="status">{m.ctxw_loading({}, o)}</p>
      ) : page.kind !== 'ready' ? (
        <ContextFeedback failure={page} locale={locale} retry={() => void reload()} />
      ) : page.value.contexts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyHelp}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul aria-label={m.ctxw_title({}, o)}>
          {page.value.contexts.map((entry) => {
            const title = pickText(entry.labels, locale);
            return (
              <ContentItem
                key={entry.id}
                title={title.text || m.context_unnamed({}, o)}
                {...(title.lang ? { titleLang: title.lang } : {})}
                href={detailHref(locale, entry.id)}
                metadata={
                  <>
                    {entry.kind === 'global' ? m.ctxw_global({}, o) : m.ctxw_community({}, o)} ·{' '}
                    {entry.state === 'deleted' ? m.ctxw_deleted({}, o) : m.ctxw_active({}, o)}
                  </>
                }
              />
            );
          })}
        </ul>
      )}
      {page?.kind === 'ready' && page.value.next ? (
        <a
          className={cn(buttonVariants({ variant: 'outline' }), actionClassName)}
          href={directoryHref(locale, { ...input, cursor: page.value.next })}
        >
          {m.ctxw_next({}, o)}
        </a>
      ) : null}
      {input.cursor ? (
        <a className={linkClassName} href={directoryHref(locale, { ...input, cursor: undefined })}>
          {m.ctxw_restart({}, o)}
        </a>
      ) : null}
    </article>
  );
}
export function ContextCreateView({
  locale,
  actions,
  submit,
  reload,
  settings,
  loadSettings,
}: {
  locale: string;
  actions: Result<Actions> | null;
  submit: (command: Command) => Promise<MutationResult>;
  reload: () => Promise<unknown>;
  settings?: SettingsRead | null;
  loadSettings?: (digest?: string) => Promise<SettingsRead | undefined>;
}) {
  const current = useContextCurrent();
  const o = options(locale);
  const [rows, setRows] = useState<LabelRow[]>(() => [emptyLabelRow(locale)]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inventory, setInventory] = useState<SettingsRead | null | undefined>(settings);
  const [captured, setCaptured] = useState<SettingsRead | null>(null);
  const [changed, setChanged] = useState(false);
  const preview = useRef<SettingsPreview | null>(null);
  const intent = useContextIntent(submit, reload);
  const locked = intent.busy || !!intent.pending;
  const created = intent.result?.kind === 'confirmed' ? intent.result : null;
  const createdContext =
    created?.created ?? (created?.current.kind === 'ready' ? created.current.value.context : null);
  const snapshot = inventory?.kind === 'ready' ? inventory.snapshot : null;
  const review = snapshot
    ? policyPreview(snapshot, selected)
    : { settings: selected, release: '', defaults: {} };
  useEffect(() => {
    if (settings) setInventory(settings);
  }, [settings]);
  useEffect(() => {
    if (!current() || !loadSettings || inventory) return;
    let cancelled = false;
    setInventory({ kind: 'loading' });
    void loadSettings().then((latest) => {
      if (!cancelled && current() && latest) setInventory(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [current, inventory, loadSettings]);
  const capturedDigest = createdContext?.settings?.release;
  useEffect(() => {
    if (!current() || !loadSettings || !capturedDigest) return;
    if (snapshot?.digest === capturedDigest) return;
    let cancelled = false;
    setCaptured({ kind: 'loading' });
    void loadSettings(capturedDigest).then((latest) => {
      if (!cancelled && current() && latest) setCaptured(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [capturedDigest, current, loadSettings, snapshot]);
  async function confirm() {
    if (!current() || !actions || !admits(actions, 'create') || locked) return;
    const labels = labelsFromDraft(rows);
    if (!labels) return;
    let settingsId = selected ?? undefined;
    if (selected && loadSettings) {
      const latest = await loadSettings();
      if (!current()) return;
      if (latest?.kind === 'ready') {
        const next = policyPreview(latest.snapshot, selected);
        const previous = snapshot ? policyPreview(snapshot, selected) : next;
        setInventory(latest);
        if (!next.settings) return;
        if (policyFingerprint(previous) !== policyFingerprint(next)) {
          setChanged(true);
          return;
        }
        settingsId = next.settings;
        preview.current = next;
      } else {
        if (latest) setInventory(latest);
        preview.current = { settings: selected, release: snapshot?.digest ?? '', defaults: snapshot?.contexts[selected]?.defaults ?? {} };
      }
    } else {
      preview.current = review;
    }
    setChanged(false);
    await intent.submit({
      operation: 'create',
      labels,
      key: crypto.randomUUID(),
      ...(actions.session ? { session: actions.session } : {}),
      ...(settingsId ? { settings: settingsId } : {}),
    });
  }
  return (
    <article className={width}>
      <a className={linkClassName} href={directoryHref(locale)}>
        {m.ctxw_title({}, o)}
      </a>
      <header className="space-y-3">
        <PageHeading>{m.ctxw_create({}, o)}</PageHeading>
        <p className="text-muted-foreground">{m.ctxw_create_help({}, o)}</p>
      </header>
      <MutationFeedback intent={intent} locale={locale} />
      {created ? (
        <div className="space-y-5">
          {createdContext ? (
            <CapturedSettings
              locale={locale}
              captured={{ settings: createdContext.settings, defaults: createdContext.defaults }}
              snapshot={
                snapshot && createdContext.settings && snapshot.digest === createdContext.settings.release
                  ? snapshot
                  : captured?.kind === 'ready' && captured.snapshot.digest === createdContext.settings?.release
                    ? captured.snapshot
                    : null
              }
              {...(createdContext.settings
                ? {
                    labels:
                      snapshot?.digest === createdContext.settings.release
                        ? 'ready'
                        : captured
                          ? captured.kind === 'ready'
                            ? 'ready'
                            : captured.kind
                          : undefined,
                  }
                : {})}
              {...(preview.current ? { preview: preview.current } : {})}
              mismatch={!!preview.current && !capturedMatches(preview.current, createdContext)}
            />
          ) : null}
          <a className={cn(buttonVariants(), actionClassName)} href={detailHref(locale, created.id)}>
            {m.ctxw_open({}, o)}
          </a>
        </div>
      ) : (
        <form
          className="max-w-xl space-y-5"
          aria-busy={intent.busy}
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <ContextLabelRows
            locale={locale}
            rows={rows}
            disabled={locked}
            invalidId={intent.result?.kind === 'invalid' ? `${rows[0]?.id}-text` : undefined}
            onChange={(next) => {
              if (current()) {
                setRows(next);
                setChanged(false);
              }
            }}
          />
          {loadSettings || settings ? (
            <SettingsPicker
              locale={locale}
              inventory={inventory}
              selected={selected}
              disabled={locked}
              onSelect={(id) => {
                if (current() && !locked) {
                  setSelected(id);
                  setChanged(false);
                }
              }}
              {...(loadSettings
                ? {
                    onReload: () => {
                      void loadSettings().then((latest) => {
                        if (current() && latest) setInventory(latest);
                      });
                    },
                  }
                : {})}
            />
          ) : null}
          {labelsFromDraft(rows) ? (
            <SettingsReview
              locale={locale}
              labels={labelsFromDraft(rows)!}
              preview={review}
              snapshot={snapshot}
              changed={changed}
            />
          ) : null}
          <Permission actions={actions} locale={locale} />
          {actions?.kind === 'ready' && !admits(actions, 'create') ? <p role="status">{m.ctxw_denied({}, o)}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              className={actionClassName}
              type="submit"
              disabled={locked || !actions || !admits(actions, 'create') || !labelsFromDraft(rows)}
            >
              {m.ctxw_create({}, o)}
            </Button>
            <Button
              className={actionClassName}
              type="button"
              variant="outline"
              disabled={intent.busy}
              onClick={() => void intent.refresh()}
            >
              {m.ctxw_reread({}, o)}
            </Button>
          </div>
        </form>
      )}
      <ContextDeparture
        locale={locale}
        protect={
          current() &&
          (!!intent.pending ||
            (!created && (rows.some((row) => row.text !== '' || row.language !== locale) || selected !== null)))
        }
        unsettled={intent.busy || intent.result?.kind === 'unknown'}
        current={current}
        onLeave={() => {
          setRows([emptyLabelRow(locale)]);
          setSelected(null);
          intent.retire();
        }}
      />
    </article>
  );
}
function ServerDate({ value, locale }: { value: string; locale: string }) {
  const date = new Date(value);
  return (
    <time dateTime={value}>
      {Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(date)}
    </time>
  );
}
function SubjectJourney({ id, locale, search }: { id: string; locale: string; search?: EntityPickerSearch }) {
  const current = useContextCurrent();
  const [subjects, setSubjects] = useState<EntityPickerSubject[]>([]);
  const o = options(locale);
  const subject = subjects[0];
  return (
    <section className="max-w-xl space-y-3">
      <h2 className="text-xl font-semibold">{m.ctxw_subjects({}, o)}</h2>
      <p className="text-sm text-muted-foreground">{m.ctxw_subjects_help({}, o)}</p>
      {search ? (
        <EntityPicker
          search={search}
          value={subjects}
          onValueChange={(subjects) => {
            if (current()) setSubjects(subjects);
          }}
          label={m.ctxw_choose_subject({}, o)}
          src={(id, variant) => `/media/images/${id}/${variant}`}
        />
      ) : null}
      {subject ? (
        <a
          className={cn(buttonVariants({ variant: 'outline' }), actionClassName)}
          href={`${subjectHref({ id: subject.id, label: subject.title }, locale).href}/context-review?${new URLSearchParams({ context: id })}`}
        >
          {m.ctxw_review_subject({}, o)}
        </a>
      ) : null}
    </section>
  );
}
export function ContextDetailView({
  id,
  locale,
  data,
  submit,
  reload,
  search,
  settings,
  loadSettings,
}: {
  id: string;
  locale: string;
  data: Result<Workspace> | null;
  submit: (command: Command) => Promise<MutationResult>;
  reload: () => Promise<unknown>;
  search?: EntityPickerSearch;
  settings?: SettingsRead | null;
  loadSettings?: (digest?: string) => Promise<SettingsRead | undefined>;
}) {
  const live = useContextCurrent();
  const o = options(locale);
  const intent = useContextIntent(submit, reload);
  const [confirm, setConfirm] = useState(false);
  const [captured, setCaptured] = useState<SettingsRead | null | undefined>(settings);
  const visible = !intent.busy && (!intent.pending || intent.reviewed);
  const current = visible && data?.kind === 'ready' ? data.value : null;
  const digest = current?.context?.settings?.release;
  useEffect(() => {
    if (settings) setCaptured(settings);
  }, [settings]);
  useEffect(() => {
    if (!live() || !loadSettings || !digest) return;
    let cancelled = false;
    setCaptured({ kind: 'loading' });
    void loadSettings(digest).then((latest) => {
      if (!cancelled && live() && latest) setCaptured(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [digest, loadSettings, live]);
  const resource = current?.context ?? current?.lifecycle;
  const operation = current ? lifecycleOperation(current) : null;
  const allowed = !!(operation && current && admits(current.actions, operation));
  const restoring = current?.lifecycle?.state === 'deleted';
  return (
    <article className={width} aria-busy={intent.busy || !data}>
      <a className={linkClassName} href={directoryHref(locale)}>
        {m.ctxw_title({}, o)}
      </a>
      <PageHeading className="[overflow-wrap:anywhere]">
        {resource ? pickText(resource.labels, locale).text || m.context_unnamed({}, o) : m.ctxw_title({}, o)}
      </PageHeading>
      <MutationFeedback intent={intent} locale={locale} />
      {!data ? (
        <p role="status">{m.ctxw_loading({}, o)}</p>
      ) : visible && data.kind !== 'ready' ? (
        <ContextFeedback failure={data} locale={locale} />
      ) : null}
      <Button
        className={actionClassName}
        variant="outline"
        disabled={intent.busy}
        onClick={() => void intent.refresh()}
      >
        {m.ctxw_reread({}, o)}
      </Button>
      {current && resource ? (
        <>
          <p className="text-sm text-muted-foreground">
            {resource.kind === 'global' ? m.ctxw_global_help({}, o) : m.ctxw_community({}, o)}
          </p>
          {current.lifecycle?.state === 'deleted' ? (
            <section className="space-y-3">
              <Tombstone shape="row" reason="deleted" labels={{ deleted: m.ctxw_deleted({}, o) }} />
              <p>{m.ctxw_deleted_help({}, o)}</p>
              <dl className="space-y-2 text-sm">
                {current.lifecycle.deletedAt ? (
                  <div>
                    <dt className="font-semibold">{m.ctxw_deleted_at({}, o)}</dt>
                    <dd>
                      <ServerDate value={current.lifecycle.deletedAt} locale={locale} />
                    </dd>
                  </div>
                ) : null}
                {current.lifecycle.purgeAfter ? (
                  <div>
                    <dt className="font-semibold">{m.ctxw_purge_after({}, o)}</dt>
                    <dd>
                      <ServerDate value={current.lifecycle.purgeAfter} locale={locale} />
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className="text-sm text-muted-foreground">{m.ctxw_restore_help({}, o)}</p>
            </section>
          ) : null}
          {current.context ? (
            <>
              <CapturedSettings
                locale={locale}
                captured={{ settings: current.context.settings, defaults: current.context.defaults }}
                snapshot={captured?.kind === 'ready' ? captured.snapshot : null}
                {...(captured ? { labels: captured.kind === 'ready' ? 'ready' : captured.kind } : {})}
              />
              <SubjectJourney key={`${id}:${locale}`} id={id} locale={locale} {...(search ? { search } : {})} />
            </>
          ) : null}
          {current.lifecycleUnavailable ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.ctxw_lifecycle_unavailable({}, o)}
            </p>
          ) : null}
          {resource.kind === 'community' ? (
            <section className="space-y-3">
              <Permission actions={current.actions} locale={locale} />
              <AlertDialog
                open={confirm}
                onOpenChange={(open) => {
                  if (live()) setConfirm(open);
                }}
              >
                <AlertDialogTrigger
                  render={
                    <Button
                      className={actionClassName}
                      variant={operation === 'delete' ? 'destructive' : 'outline'}
                      disabled={!allowed || intent.busy || !!intent.pending}
                    />
                  }
                >
                  {restoring ? m.ctxw_restore({}, o) : m.ctxw_delete({}, o)}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{restoring ? m.ctxw_restore({}, o) : m.ctxw_delete({}, o)}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {restoring ? m.ctxw_restore_help({}, o) : m.ctxw_delete_help({}, o)}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className={actionClassName}>{m.ctxw_cancel({}, o)}</AlertDialogCancel>
                    <AlertDialogAction
                      className={actionClassName}
                      variant={operation === 'delete' ? 'destructive' : 'default'}
                      disabled={!allowed || !!intent.pending}
                      onClick={() => {
                        if (!live()) return;
                        setConfirm(false);
                        if (operation && allowed && !intent.pending)
                          void intent.submit({
                            operation,
                            id,
                            key: crypto.randomUUID(),
                            ...(data?.session ? { session: data.session } : {}),
                          });
                      }}
                    >
                      {restoring ? m.ctxw_restore({}, o) : m.ctxw_delete({}, o)}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {!allowed ? (
                <p className="text-sm text-muted-foreground">
                  {current.actions.kind === 'ready' ? m.ctxw_no_action({}, o) : m.ctxw_actions_unavailable({}, o)}
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      <ContextDeparture
        locale={locale}
        protect={live() && !!intent.pending}
        unsettled={intent.busy || intent.result?.kind === 'unknown'}
        current={live}
        onLeave={intent.retire}
      />
    </article>
  );
}
