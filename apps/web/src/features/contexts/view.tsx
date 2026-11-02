import { useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
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
import { locales } from '../../paraglide/runtime.js';
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

const width = 'mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]';
const actionClassName = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-md py-2 underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
// Preserve native list-item display so the disclosure marker and keyboard behavior remain available.
const summaryClassName =
  'min-h-11 min-w-11 cursor-pointer content-center py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
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
}: {
  locale: string;
  actions: Result<Actions> | null;
  submit: (command: Command) => Promise<MutationResult>;
  reload: () => Promise<unknown>;
}) {
  const current = useContextCurrent();
  const o = options(locale);
  const [label, setLabel] = useState('');
  const [language, setLanguage] = useState(locale);
  const field = useId();
  const intent = useContextIntent(submit, reload);
  const locked = intent.busy || !!intent.pending;
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const created = intent.result?.kind === 'confirmed' ? intent.result : null;
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
        <a className={cn(buttonVariants(), actionClassName)} href={detailHref(locale, created.id)}>
          {m.ctxw_open({}, o)}
        </a>
      ) : (
        <form
          className="max-w-xl space-y-5"
          aria-busy={intent.busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (current() && actions && admits(actions, 'create') && !locked)
              void intent.submit({
                operation: 'create',
                labels: { [language]: label.trim() },
                key: crypto.randomUUID(),
                ...(actions.session ? { session: actions.session } : {}),
              });
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${field}-language`}>{m.ctxw_language({}, o)}</FieldLabel>
            <NativeSelect
              id={`${field}-language`}
              value={language}
              disabled={locked}
              onChange={(event) => {
                if (current()) setLanguage(event.target.value);
              }}
            >
              {locales.map((language) => (
                <NativeSelectOption key={language} value={language}>
                  {names.of(language) ?? language}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field data-invalid={intent.result?.kind === 'invalid'}>
            <FieldLabel htmlFor={field}>{m.ctxw_label({}, o)}</FieldLabel>
            <Input
              id={field}
              lang={language}
              value={label}
              required
              disabled={locked}
              aria-invalid={intent.result?.kind === 'invalid'}
              aria-describedby={`${field}-help`}
              onChange={(event) => {
                if (current()) setLabel(event.target.value);
              }}
            />
            <FieldDescription id={`${field}-help`}>{m.ctxw_label_help({}, o)}</FieldDescription>
          </Field>
          <Permission actions={actions} locale={locale} />
          {actions?.kind === 'ready' && !admits(actions, 'create') ? <p role="status">{m.ctxw_denied({}, o)}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              className={actionClassName}
              type="submit"
              disabled={locked || !actions || !admits(actions, 'create')}
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
        protect={current() && (!!intent.pending || (!created && (label !== '' || language !== locale)))}
        unsettled={intent.busy || intent.result?.kind === 'unknown'}
        current={current}
        onLeave={() => {
          setLabel('');
          setLanguage(locale);
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
}: {
  id: string;
  locale: string;
  data: Result<Workspace> | null;
  submit: (command: Command) => Promise<MutationResult>;
  reload: () => Promise<unknown>;
  search?: EntityPickerSearch;
}) {
  const live = useContextCurrent();
  const o = options(locale);
  const intent = useContextIntent(submit, reload);
  const [confirm, setConfirm] = useState(false);
  const visible = !intent.busy && (!intent.pending || intent.reviewed);
  const current = visible && data?.kind === 'ready' ? data.value : null;
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
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">{m.ctxw_settings({}, o)}</h2>
                <p className="text-sm text-muted-foreground">{m.ctxw_settings_help({}, o)}</p>
                {current.context.settings ? (
                  <div className="space-y-2">
                    <p className="font-medium">{m.ctx_reader_settings_selected({}, o)}</p>
                    <details className="min-w-0 rounded-lg border border-border px-3 text-sm">
                      <summary className={summaryClassName}>{m.ctx_reader_settings_details({}, o)}</summary>
                      <dl className="space-y-3 pb-3">
                        <div>
                          <dt className="text-muted-foreground">{m.ctxw_setting({}, o)}</dt>
                          <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="auto">
                            {current.context.settings.id}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">{m.ctxw_release({}, o)}</dt>
                          <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="auto">
                            {current.context.settings.release}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </div>
                ) : (
                  <p>{m.ctxw_no_settings({}, o)}</p>
                )}
                {Object.keys(current.context.defaults).length ? (
                  <div className="space-y-3">
                    <h3 className="font-semibold">{m.ctx_reader_defaults({}, o)}</h3>
                    <dl className="space-y-3">
                      {Object.entries(current.context.defaults).map(([property, mode], index) => (
                        <div key={property} className="min-w-0 space-y-1 rounded-lg border border-border p-3">
                          <dt className="font-medium">{m.ctx_reader_rule({ number: index + 1 }, o)}</dt>
                          <dd className="space-y-1">
                            <p>{mode === 'suppress' ? m.ctxw_suppress({}, o) : m.ctxw_inherit({}, o)}</p>
                            <details className="min-w-0 text-sm">
                              <summary className={summaryClassName}>
                                {m.ctx_reader_rule_reference({ number: index + 1 }, o)}
                              </summary>
                              <dl className="space-y-1 pb-2">
                                <dt className="text-muted-foreground">{m.ctx_reader_property_key({}, o)}</dt>
                                <dd className="select-text font-mono [overflow-wrap:anywhere]" dir="auto">
                                  {property}
                                </dd>
                              </dl>
                            </details>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{m.ctx_reader_no_defaults({}, o)}</p>
                )}
              </section>
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
