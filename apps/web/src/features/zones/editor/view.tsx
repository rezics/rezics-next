import * as SharedSelect from '@rezics/ui/shadcn/select';
import { type CompositionDocument } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker, useRouter } from '@tanstack/react-router';
import { Alert, AlertTitle, AlertDescription } from '@rezics/ui/shadcn/alert';
import { m } from '../../../paraglide/messages.js';
import { PageHeading } from '../../../shell/page-heading';
import { ZoneLifecycleControls } from '../../catalogue/lifecycle-zone.tsx';
import { readerHref, type Visibility, type ZoneEditorSession } from './model';

import { ZoneNameFields } from './name-fields';
import {
  EditorFailure,
  FieldGuidanceList,
  TechnicalDetails,
  fieldGuidance,
  type CorrectionTarget,
  type FailureContext,
} from './error-guidance';
export { EditorFailure } from './error-guidance';

const CompositionEditor = lazy(() => import('./composition'));
const SavedPreview = lazy(() => import('./preview'));

export function EditorLoading() {
  return (
    <p role="status" aria-busy="true">
      {m.zone_editor_loading()}
    </p>
  );
}

function ZoneNavigationGuard({
  session,
  generation,
  dirty,
  busy,
}: {
  session: ZoneEditorSession;
  generation: number;
  dirty: boolean;
  busy: boolean;
}) {
  const router = useRouter({ warn: false });
  return router ? <RouterDepartureGuard session={session} generation={generation} dirty={dirty} busy={busy} /> : null;
}

function RouterDepartureGuard({
  session,
  generation,
  dirty,
  busy,
}: {
  session: ZoneEditorSession;
  generation: number;
  dirty: boolean;
  busy: boolean;
}) {
  const resolved = useRef(false);
  const current = () => session.isCurrent() && session.snapshot().generation === generation;
  const blocker = useBlocker({
    shouldBlockFn: () => {
      if (!current() || !session.dirty()) return false;
      resolved.current = false;
      return true;
    },
    disabled: !dirty || !current(),
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if ((!dirty || !current()) && blocker.status === 'blocked' && !resolved.current) {
      resolved.current = true;
      blocker.reset();
    }
  }, [blocker, dirty, generation, session]);
  useEffect(
    () => () => {
      const pending = blockerRef.current;
      if (pending.status === 'blocked' && !resolved.current) {
        resolved.current = true;
        pending.reset();
      }
    },
    [],
  );

  function resolve(leave: boolean) {
    if (blocker.status !== 'blocked' || resolved.current) return;
    resolved.current = true;
    const latest = session.snapshot();
    if (leave && current() && !latest.busy && session.dirty()) blocker.proceed();
    else blocker.reset();
  }

  return blocker.status === 'blocked' ? (
    <section role="alert" className="mb-6 space-y-3 border-t border-border pt-4">
      <p>{m.zone_editor_leave()}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => resolve(false)}>{m.zone_editor_stay()}</Button>
        <Button variant="outline" disabled={busy} onClick={() => resolve(true)}>
          {m.zone_editor_discard()}
        </Button>
      </div>
    </section>
  ) : null;
}

export function ZoneConfigurationEditor({
  session,
  locale,
  enabled = true,
  writeEnabled = enabled,
}: {
  session: ZoneEditorSession;
  locale: string;
  enabled?: boolean;
  writeEnabled?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const editor = useRef<HTMLElement>(null);
  const [operation, setOperation] = useState<FailureContext>('write');
  const [focusRequest, setFocusRequest] = useState<{
    target: CorrectionTarget;
    draft: typeof state.draft;
    generation: number;
  } | null>(null);
  const [selected, setSelected] = useState(0);
  const [newRoute, setNewRoute] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(state.saved?.zone.visibility ?? 'private');
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const { saved, draft, loaded } = state;
  useEffect(() => {
    if (!current()) return;
    setSelected(0);
    setComposing(false);
    setCopied(null);
    setFocusRequest(null);
  }, [state.generation]);
  useEffect(() => {
    if (current() && saved) setVisibility(saved.zone.visibility);
  }, [saved?.zone.visibility]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (session.dirty()) event.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [session]);
  const dirty = session.dirty();
  const disabled = !enabled || state.busy || !!state.conflict;
  const editDisabled = disabled || !loaded.permissions.configure;
  const page = draft?.configuration.pages[selected] ?? draft?.configuration.pages[0];
  const route = page?.route ?? '';
  const href = saved
    ? readerHref(saved.zone.id, saved.configuration.pages.some((item) => item.route === route) ? route : '', locale)
    : '';
  function current() {
    return session.isCurrent() && session.snapshot().generation === state.generation;
  }
  function currentDraft() {
    return current() && session.snapshot().draft === draft;
  }
  function canEdit() {
    const latest = session.snapshot();
    return currentDraft() && enabled && !latest.busy && !latest.conflict && latest.loaded.permissions.configure;
  }
  function correct(target: CorrectionTarget) {
    if (!currentDraft() || !draft || !enabled || session.snapshot().busy) return;
    if (target.pageIndex !== undefined) {
      const targetPage = draft.configuration.pages[target.pageIndex];
      if (!targetPage) return;
      setSelected(target.pageIndex);
      setComposing(false);
    }
    setFocusRequest({ target, draft, generation: state.generation });
  }
  useEffect(() => {
    if (!focusRequest || !session.isCurrent()) return;
    const latest = session.snapshot();
    if (
      latest.generation !== focusRequest.generation ||
      latest.draft !== focusRequest.draft ||
      latest.busy ||
      !enabled
    ) {
      setFocusRequest(null);
      return;
    }
    const { target } = focusRequest;
    if (target.pageIndex !== undefined && draft?.configuration.pages[target.pageIndex] !== page) return;
    const element = editor.current?.querySelector<HTMLElement>(`[id="${target.id}"]`);
    if (!element) return;
    // Reveal existing translations without synthesizing or changing a name.
    const details = element.closest('details');
    if (details) details.open = true;
    // A disabled field stays disabled; focus its existing section for readable guidance.
    const focusable = element.matches(':disabled, [aria-disabled="true"]')
      ? element.parentElement?.closest<HTMLElement>('[data-correction-section]')
      : element;
    focusable?.focus();
    setFocusRequest(null);
  }, [focusRequest, page, draft, enabled, session]);
  useEffect(() => {
    if (!session.isCurrent() || session.snapshot().generation !== state.generation) return;
    const id = state.violations.length ? 'zone-validation' : state.failure ? 'zone-mutation-failure' : undefined;
    if (id) editor.current?.querySelector<HTMLElement>(`#${id}`)?.focus();
  }, [state.violations, state.failure, state.generation, session]);
  const issues = [
    ...state.violations.map((issue, index) => ({ issue, id: `zone-local-error-${index}` })),
    ...(state.failure?.errors ?? []).map((issue, index) => ({ issue, id: `zone-api-error-${index}` })),
  ];
  const descriptions: Record<string, string> = {};
  for (const { issue, id } of issues) {
    const target = fieldGuidance(issue, draft, locale).target;
    if (!target || (target.pageIndex !== undefined && draft?.configuration.pages[target.pageIndex] !== page)) continue;
    descriptions[target.id] = [descriptions[target.id], id].filter(Boolean).join(' ');
  }
  const invalid = (id: string) => !!descriptions[id];
  async function readCurrent() {
    if (!current()) return;
    const previous = session.snapshot().failure;
    await session.refresh();
    if (current() && session.snapshot().failure !== previous) setOperation('read');
  }
  async function readMore() {
    if (!current()) return;
    const previous = session.snapshot().failure;
    await session.moreCollections();
    if (current() && session.snapshot().failure !== previous) setOperation('read');
  }
  function changeDocument(document: CompositionDocument) {
    if (!canEdit()) return;
    const current = session.snapshot().draft;
    if (!current) return;
    session.edit({
      ...current,
      configuration: {
        ...current.configuration,
        pages: current.configuration.pages.map((item, index) => (index === selected ? { ...item, document } : item)),
      },
    });
  }
  function changeRoute(value: string) {
    if (!canEdit() || !draft) return;
    if (!value || draft.configuration.pages.some((item) => item !== page && item.route === value)) return;
    const pages = draft.configuration.pages
      .map((item) => (item === page ? { ...item, route: value } : item))
      .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
    session.edit({ ...draft, configuration: { ...draft.configuration, pages } });
    setSelected(pages.findIndex((item) => item.route === value));
    setComposing(false);
  }
  function toggle(id: string, checked: boolean, scope: boolean) {
    if (!canEdit() || !draft) return;
    if (scope)
      session.edit({
        ...draft,
        configuration: {
          ...draft.configuration,
          scope: checked ? [...draft.configuration.scope, id] : draft.configuration.scope.filter((item) => item !== id),
        },
      });
    else
      session.edit({ ...draft, mounts: checked ? [...draft.mounts, id] : draft.mounts.filter((item) => item !== id) });
  }
  async function copy() {
    if (!current()) return;
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      if (current()) setCopied('copied');
    } catch {
      if (current()) setCopied('failed');
    }
  }
  if (!session.isCurrent()) return <EditorLoading />;
  const scopeOptions = loaded.options.scopes;
  const mountOptions = loaded.options.collections;
  return (
    <article
      ref={editor}
      onClickCapture={(event) => {
        if (!current()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className="flex min-w-0 flex-col gap-6 text-foreground"
      aria-busy={state.busy}
    >
      <ZoneNavigationGuard session={session} generation={state.generation} dirty={dirty} busy={state.busy} />
      <header className="space-y-3">
        <PageHeading>{m.zone_editor_heading()}</PageHeading>
        <p className="max-w-3xl text-muted-foreground">{m.zone_editor_live_note()}</p>
        {saved ? (
          <ZoneLifecycleControls
            deleted={saved.zone.deletedAt !== null}
            withheld={false}
            busy={state.busy || !writeEnabled}
            onDelete={() => {
              if (!current() || dirty || !writeEnabled) return;
              void session.changeLifecycle('delete');
            }}
            onRestore={() => {
              if (!current() || !writeEnabled) return;
              void session.changeLifecycle('restore');
            }}
          />
        ) : null}
      </header>
      {!draft || !saved ? (
        <>
          {loaded.resource.kind === 'failure' ? <EditorFailure failure={loaded.resource} locale={locale} /> : null}
          {state.failure ? (
            <EditorFailure
              id="zone-mutation-failure"
              failure={state.failure}
              locale={locale}
              context={operation}
              draft={draft}
              onCorrect={enabled ? correct : undefined}
              issuePrefix="zone-api-error"
            />
          ) : null}
          <Button
            className="h-auto max-w-full whitespace-normal py-2 text-start"
            disabled={!enabled || state.busy}
            onClick={readCurrent}
          >
            {m.zone_editor_retry()}
          </Button>
        </>
      ) : (
        <>
          <p role="status">
            {state.busy
              ? m.zone_editor_loading()
              : dirty
                ? m.zone_editor_dirty()
                : m.zone_editor_saved_head({ revision: saved.zone.revision })}
          </p>
          {!loaded.permissions.available ? (
            <div className="space-y-2">
              <p role="alert">{m.zone_editor_actions_unavailable()}</p>
              {loaded.permissions.failure ? (
                <EditorFailure failure={loaded.permissions.failure} locale={locale} />
              ) : null}
            </div>
          ) : !loaded.permissions.configure ? (
            <p role="note">{m.zone_editor_denied()}</p>
          ) : null}
          {state.failure ? (
            <EditorFailure
              id="zone-mutation-failure"
              failure={state.failure}
              locale={locale}
              context={operation}
              draft={draft}
              onCorrect={enabled ? correct : undefined}
              issuePrefix="zone-api-error"
            />
          ) : null}
          {state.notice ? (
            <p role="status">{state.notice === 'saved' ? m.zone_editor_saved() : m.zone_editor_published()}</p>
          ) : null}
          {state.conflict ? (
            <section className="space-y-3 border-t border-border pt-4" aria-label={m.zone_editor_conflict()}>
              <p role="alert">{m.zone_editor_conflict()}</p>
              {state.conflict.resource.kind === 'failure' ? (
                <EditorFailure failure={state.conflict.resource} locale={locale} />
              ) : (
                <p>{m.zone_editor_saved_head({ revision: state.conflict.resource.value.zone.revision })}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  className="h-auto max-w-full whitespace-normal py-2 text-start"
                  disabled={state.busy || state.conflict.resource.kind !== 'ready'}
                  onClick={() => {
                    if (current()) session.resolve('reload');
                  }}
                >
                  {m.zone_editor_reload()}
                </Button>
                <Button
                  className="h-auto max-w-full whitespace-normal py-2 text-start"
                  variant="outline"
                  disabled={
                    state.busy || state.conflict.resource.kind !== 'ready' || !state.conflict.permissions.configure
                  }
                  onClick={() => {
                    if (current()) session.resolve('reapply');
                  }}
                >
                  {m.zone_editor_reapply()}
                </Button>
                <Button
                  className="h-auto max-w-full whitespace-normal py-2 text-start"
                  variant="outline"
                  disabled={state.busy}
                  onClick={readCurrent}
                >
                  {m.zone_editor_retry()}
                </Button>
              </div>
            </section>
          ) : null}
          {state.violations.length ? (
            <Alert id="zone-validation" tabIndex={-1} aria-describedby="zone-validation-guidance">
              <AlertTitle>{m.zone_editor_validation()}</AlertTitle>
              <AlertDescription id="zone-validation-guidance" className="flex flex-col gap-3">
                <FieldGuidanceList
                  issues={state.violations}
                  draft={draft}
                  locale={locale}
                  onCorrect={enabled ? correct : undefined}
                  issuePrefix="zone-local-error"
                />
              </AlertDescription>
              <TechnicalDetails issues={state.violations} locale={locale} />
            </Alert>
          ) : null}
          <ZoneNameFields
            locale={locale}
            labels={draft.configuration.labels}
            primaryLanguage={draft.configuration.primaryLanguage}
            disabled={editDisabled}
            descriptions={descriptions}
            errors={issues.flatMap(({ issue }) => {
              const target = fieldGuidance(issue, draft, locale).target;
              return target?.language ? [`/configuration/labels/${target.language}`] : [];
            })}
            onChange={(names) => {
              if (canEdit()) session.edit({ ...draft, configuration: { ...draft.configuration, ...names } });
            }}
          />
          <section
            tabIndex={-1}
            data-correction-section=""
            className="min-w-0 space-y-4"
            aria-labelledby="zone-pages-heading"
            aria-describedby={descriptions['zone-pages-heading']}
          >
            <h2
              tabIndex={-1}
              data-correction-section=""
              aria-describedby={descriptions['zone-pages-heading']}
              id="zone-pages-heading"
              className="text-xl font-semibold"
            >
              {m.zone_editor_pages()}
            </h2>
            <p className="text-sm text-muted-foreground">{m.zone_editor_navigation_note()}</p>
            <Field>
              <FieldLabel htmlFor="zone-page">{m.zone_editor_page()}</FieldLabel>
              <SharedSelect.Select
                disabled={disabled}
                value={String(draft.configuration.pages.indexOf(page!))}
                items={draft.configuration.pages.map((item, index) => ({
                  value: String(index),
                  label: item.route || m.zone_home(),
                }))}
                onValueChange={(value) => {
                  if (value === null) return;
                  if (!currentDraft()) return;
                  setSelected(Number(value));
                  setComposing(false);
                  session.clearPreview();
                }}
              >
                <SharedSelect.SelectTrigger id="zone-page" className="max-md:min-h-11 pointer-coarse:min-h-11">
                  <SharedSelect.SelectValue />
                </SharedSelect.SelectTrigger>
                <SharedSelect.SelectContent>
                  <SharedSelect.SelectGroup>
                    {draft.configuration.pages.map((item, index) => (
                      <SharedSelect.SelectItem key={`${index}:${item.route}`} value={String(index)}>
                        {item.route || m.zone_home()}
                      </SharedSelect.SelectItem>
                    ))}
                  </SharedSelect.SelectGroup>
                </SharedSelect.SelectContent>
              </SharedSelect.Select>
            </Field>
            {page ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="min-w-0 flex-1" data-invalid={invalid('zone-route')}>
                  <FieldLabel htmlFor="zone-route">{m.zone_editor_route()}</FieldLabel>
                  <Input
                    id="zone-route"
                    value={route}
                    disabled={editDisabled || route === ''}
                    onChange={(event) => changeRoute(event.target.value)}
                    maxLength={255}
                    aria-invalid={invalid('zone-route')}
                    aria-describedby={['zone-route-help', descriptions['zone-route']].filter(Boolean).join(' ')}
                  />
                  <FieldDescription id="zone-route-help">{m.zone_editor_route_help()}</FieldDescription>
                </Field>
                <Button
                  className="h-auto max-w-full whitespace-normal py-2 text-start"
                  variant="outline"
                  disabled={editDisabled || route === ''}
                  onClick={() => {
                    if (!canEdit()) return;
                    session.edit({
                      ...draft,
                      configuration: {
                        ...draft.configuration,
                        pages: draft.configuration.pages.filter((item) => item !== page),
                      },
                    });
                    setSelected(0);
                    setComposing(false);
                  }}
                >
                  {m.zone_editor_remove()}
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-3">
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="zone-new-route">{m.zone_editor_new_route()}</FieldLabel>
                <Input
                  id="zone-new-route"
                  value={newRoute}
                  onChange={(event) => {
                    if (current()) setNewRoute(event.target.value);
                  }}
                  disabled={editDisabled || draft.configuration.pages.length >= 16}
                  maxLength={255}
                />
              </Field>
              <Button
                className="h-auto max-w-full whitespace-normal py-2 text-start"
                variant="outline"
                disabled={
                  editDisabled ||
                  draft.configuration.pages.length >= 16 ||
                  !newRoute ||
                  draft.configuration.pages.some((item) => item.route === newRoute)
                }
                onClick={() => {
                  if (!canEdit()) return;
                  const pages = [
                    ...draft.configuration.pages,
                    { route: newRoute, document: { root: { props: {} }, content: [] } },
                  ].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
                  session.edit({ ...draft, configuration: { ...draft.configuration, pages } });
                  setSelected(pages.findIndex((item) => item.route === newRoute));
                  setNewRoute('');
                  setComposing(false);
                }}
              >
                {m.zone_editor_add()}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{m.zone_editor_composition_note()}</p>
            <Button
              className="h-auto max-w-full whitespace-normal py-2 text-start"
              variant="outline"
              disabled={editDisabled}
              onClick={() => {
                if (canEdit()) setComposing(!composing);
              }}
              id="zone-compose"
              aria-invalid={invalid('zone-compose')}
              aria-describedby={descriptions['zone-compose']}
              aria-expanded={composing}
            >
              {m.zone_editor_compose()}
            </Button>
            {composing && page && !editDisabled ? (
              <Suspense fallback={<EditorLoading />}>
                <CompositionEditor
                  key={`${state.generation}:${selected}:${route}:${locale}`}
                  document={page.document}
                  locale={locale}
                  onChange={changeDocument}
                />
              </Suspense>
            ) : null}
          </section>
          <section
            tabIndex={-1}
            data-correction-section=""
            className="space-y-4"
            aria-labelledby="zone-sources-heading"
            aria-describedby={
              [descriptions['zone-scopes'], descriptions['zone-mounts']].filter(Boolean).join(' ') || undefined
            }
          >
            <h2 id="zone-sources-heading" className="text-xl font-semibold">
              {m.zone_editor_sources()}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{m.zone_editor_source_note()}</p>
            <fieldset
              id="zone-scopes"
              tabIndex={-1}
              data-correction-section=""
              aria-invalid={invalid('zone-scopes')}
              aria-describedby={descriptions['zone-scopes']}
              disabled={editDisabled}
              className="space-y-3"
            >
              <legend className="font-semibold">{m.zone_editor_scopes()}</legend>
              {scopeOptions.kind === 'failure' ? (
                <EditorFailure failure={scopeOptions} locale={locale} />
              ) : (
                <p className="break-all text-sm text-muted-foreground">
                  {m.zone_editor_release({ release: scopeOptions.value.release })}
                </p>
              )}
              {scopeOptions.kind === 'ready' && scopeOptions.value.ids.length === 0 ? (
                <p>{m.zone_editor_no_options()}</p>
              ) : null}
              {[
                ...new Set([
                  ...draft.configuration.scope,
                  ...(scopeOptions.kind === 'ready' ? scopeOptions.value.ids : []),
                ]),
              ].map((id) => (
                <Field orientation="horizontal" key={id}>
                  <Checkbox
                    id={`scope-${id}`}
                    checked={draft.configuration.scope.includes(id)}
                    disabled={
                      editDisabled ||
                      (!draft.configuration.scope.includes(id) && draft.configuration.scope.length >= 16)
                    }
                    onCheckedChange={(checked) => toggle(id, checked === true, true)}
                  />
                  <FieldLabel className="break-all" htmlFor={`scope-${id}`}>
                    {id}
                    {scopeOptions.kind !== 'ready' || !scopeOptions.value.ids.includes(id)
                      ? ` · ${m.zone_editor_option_unavailable()}`
                      : ''}
                  </FieldLabel>
                </Field>
              ))}
            </fieldset>
            <fieldset
              id="zone-mounts"
              tabIndex={-1}
              data-correction-section=""
              aria-invalid={invalid('zone-mounts')}
              aria-describedby={descriptions['zone-mounts']}
              disabled={editDisabled}
              className="space-y-3"
            >
              <legend className="font-semibold">{m.zone_editor_mounts()}</legend>
              {mountOptions.kind === 'failure' ? <EditorFailure failure={mountOptions} locale={locale} /> : null}
              {mountOptions.kind === 'ready' && !mountOptions.value.items.length ? (
                <p>{m.zone_editor_no_options()}</p>
              ) : null}
              {[
                ...new Set([
                  ...draft.mounts,
                  ...(mountOptions.kind === 'ready' ? mountOptions.value.items.map((item) => item.id) : []),
                ]),
              ].map((id) => {
                const item =
                  mountOptions.kind === 'ready' ? mountOptions.value.items.find((entry) => entry.id === id) : undefined;
                return (
                  <Field orientation="horizontal" key={id}>
                    <Checkbox
                      id={`mount-${id}`}
                      checked={draft.mounts.includes(id)}
                      disabled={editDisabled || (!draft.mounts.includes(id) && draft.mounts.length >= 16)}
                      onCheckedChange={(checked) => toggle(id, checked === true, false)}
                    />
                    <FieldLabel className="break-words" htmlFor={`mount-${id}`}>
                      {item?.title ?? `${id} · ${m.zone_editor_option_unavailable()}`}
                    </FieldLabel>
                  </Field>
                );
              })}
            </fieldset>
            {mountOptions.kind === 'ready' && mountOptions.value.next ? (
              <Button
                className="h-auto max-w-full whitespace-normal py-2 text-start"
                variant="outline"
                disabled={disabled}
                onClick={() => void readMore()}
              >
                {m.zone_editor_more()}
              </Button>
            ) : null}
            <Button
              className="h-auto max-w-full whitespace-normal py-2 text-start"
              variant="outline"
              disabled={disabled}
              onClick={readCurrent}
            >
              {m.zone_editor_refresh()}
            </Button>
          </section>
          <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <Button
              className="h-auto max-w-full whitespace-normal py-2 text-start"
              disabled={editDisabled || !writeEnabled || !dirty}
              onClick={() => {
                if (currentDraft()) {
                  setOperation('save');
                  void session.save();
                }
              }}
            >
              {m.zone_editor_save()}
            </Button>
            <Field
              className="w-auto min-w-0"
              data-invalid={invalid('zone-visibility')}
              tabIndex={-1}
              data-correction-section=""
            >
              <FieldLabel htmlFor="zone-visibility">{m.zone_editor_visibility()}</FieldLabel>
              <SharedSelect.Select
                value={visibility}
                disabled={disabled || !writeEnabled || !loaded.permissions.publish}
                items={[
                  { value: 'private', label: m.library_visibility_private() },
                  { value: 'unlisted', label: m.library_visibility_unlisted() },
                  { value: 'public', label: m.library_visibility_public() },
                ]}
                onValueChange={(value) => {
                  if (value !== null && current()) setVisibility(value as Visibility);
                }}
              >
                <SharedSelect.SelectTrigger
                  id="zone-visibility"
                  aria-invalid={invalid('zone-visibility')}
                  aria-describedby={descriptions['zone-visibility']}
                  className="max-md:min-h-11 pointer-coarse:min-h-11"
                >
                  <SharedSelect.SelectValue />
                </SharedSelect.SelectTrigger>
                <SharedSelect.SelectContent>
                  <SharedSelect.SelectGroup>
                    <SharedSelect.SelectItem value="private">{m.library_visibility_private()}</SharedSelect.SelectItem>
                    <SharedSelect.SelectItem value="unlisted">
                      {m.library_visibility_unlisted()}
                    </SharedSelect.SelectItem>
                    <SharedSelect.SelectItem value="public">{m.library_visibility_public()}</SharedSelect.SelectItem>
                  </SharedSelect.SelectGroup>
                </SharedSelect.SelectContent>
              </SharedSelect.Select>
            </Field>
            <Button
              className="h-auto max-w-full whitespace-normal py-2 text-start"
              variant="outline"
              disabled={
                disabled ||
                !writeEnabled ||
                dirty ||
                !loaded.permissions.publish ||
                visibility === saved.zone.visibility
              }
              onClick={() => {
                if (current()) {
                  setOperation('publish');
                  void session.publish(visibility);
                }
              }}
            >
              {m.zone_editor_publish()}
            </Button>
          </div>
          <section className="space-y-4" aria-labelledby="zone-preview-heading">
            <h2 id="zone-preview-heading" className="text-xl font-semibold">
              {m.zone_editor_preview()}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{m.zone_editor_preview_note()}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="h-auto max-w-full whitespace-normal py-2 text-start"
                variant="outline"
                disabled={disabled || dirty}
                onClick={() => {
                  if (current()) void session.preview(route);
                }}
              >
                {m.zone_editor_preview()}
              </Button>
              <a className="text-primary underline" href={href} target="_blank" rel="noopener noreferrer">
                {m.zone_editor_open()}
              </a>
              <Button
                className="h-auto max-w-full whitespace-normal py-2 text-start"
                variant="outline"
                disabled={!enabled}
                onClick={() => void copy()}
              >
                {m.zone_editor_copy()}
              </Button>
            </div>
            {copied ? (
              <p role="status">{copied === 'copied' ? m.zone_editor_copied() : m.zone_editor_copy_failed()}</p>
            ) : null}
            {state.preview?.kind === 'failure' ? (
              <>
                <EditorFailure failure={state.preview} locale={locale} context="preview" />
                <Button
                  className="h-auto max-w-full whitespace-normal py-2 text-start"
                  variant="outline"
                  disabled={disabled || dirty}
                  onClick={() => {
                    if (current()) void session.preview(route);
                  }}
                >
                  {m.zone_editor_retry()}
                </Button>
              </>
            ) : null}
            {state.preview?.kind === 'preparing' ? (
              <div role="status">
                <p>{m.zone_preparing_message()}</p>
                <p>{m.zone_editor_retry_after({ seconds: state.preview.retryAfter })}</p>
                <Button
                  className="h-auto max-w-full whitespace-normal py-2 text-start"
                  variant="outline"
                  disabled={disabled || dirty}
                  onClick={() => {
                    if (current()) void session.preview(route);
                  }}
                >
                  {m.zone_editor_retry()}
                </Button>
              </div>
            ) : null}
            {state.preview?.kind === 'ready' ? (
              <Suspense fallback={<EditorLoading />}>
                <SavedPreview page={state.preview.value} route={route} locale={locale} />
              </Suspense>
            ) : null}
          </section>
        </>
      )}
    </article>
  );
}
