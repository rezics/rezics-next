import { type CompositionDocument } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { m } from '../../../paraglide/messages.js';
import { PageHeading } from '../../../shell/page-heading';
import { readerHref, type Failure, type Visibility, type ZoneEditorSession } from './model';

import { ZoneNameFields } from './name-fields';

const CompositionEditor = lazy(() => import('./composition'));
const SavedPreview = lazy(() => import('./preview'));

export function EditorFailure({ failure }: { failure: Failure }) {
  const message =
    failure.status === 404
      ? m.not_found_message()
      : failure.status === 401
        ? m.zone_editor_signed_out()
        : failure.code === 'platform_closed'
          ? m.zone_editor_closed()
          : failure.status === 403
            ? m.zone_editor_denied()
            : failure.status === 412
              ? m.zone_editor_conflict()
              : failure.code === 'semantic_not_ready'
                ? m.zone_editor_source_unavailable()
                : m.error_message();
  return (
    <div role="alert" className="space-y-2 rounded-xl border border-border p-4">
      <p>{message}</p>
      <p className="break-words text-sm text-muted-foreground">
        {failure.status} · {failure.code}
      </p>
      {failure.retryAfter ? <p>{m.zone_editor_retry_after({ seconds: failure.retryAfter })}</p> : null}
      {failure.errors?.length ? (
        <ul className="list-disc ps-5">
          {failure.errors.map((error) => (
            <li key={`${error.pointer}:${error.code}`}>
              <code>
                {error.pointer} · {error.code}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function EditorLoading() {
  return (
    <p role="status" aria-busy="true">
      {m.zone_editor_loading()}
    </p>
  );
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
  const [selected, setSelected] = useState('');
  const [newRoute, setNewRoute] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(state.saved?.zone.visibility ?? 'private');
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const { saved, draft, loaded } = state;
  useEffect(() => {
    if (!session.isCurrent()) return;
    setComposing(false);
    setCopied(null);
  }, [state.generation]);
  useEffect(() => {
    if (session.isCurrent() && saved) setVisibility(saved.zone.visibility);
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
  const page = draft?.configuration.pages.find((item) => item.route === selected) ?? draft?.configuration.pages[0];
  const route = page?.route ?? '';
  const href = saved
    ? readerHref(saved.zone.id, saved.configuration.pages.some((item) => item.route === route) ? route : '', locale)
    : '';
  function changeDocument(document: CompositionDocument) {
    if (!session.isCurrent()) return;
    const current = session.snapshot().draft;
    if (!current) return;
    session.edit({
      ...current,
      configuration: {
        ...current.configuration,
        pages: current.configuration.pages.map((item) => (item.route === route ? { ...item, document } : item)),
      },
    });
  }
  function changeRoute(value: string) {
    if (!session.isCurrent() || !draft) return;
    if (!value || draft.configuration.pages.some((item) => item !== page && item.route === value)) return;
    const pages = draft.configuration.pages
      .map((item) => (item === page ? { ...item, route: value } : item))
      .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
    session.edit({ ...draft, configuration: { ...draft.configuration, pages } });
    setSelected(value);
    setComposing(false);
  }
  function toggle(id: string, checked: boolean, scope: boolean) {
    if (!session.isCurrent() || !draft) return;
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
    if (!session.isCurrent()) return;
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      if (session.isCurrent()) setCopied('copied');
    } catch {
      if (session.isCurrent()) setCopied('failed');
    }
  }
  if (!session.isCurrent()) return <EditorLoading />;
  const scopeOptions = loaded.options.scopes;
  const mountOptions = loaded.options.collections;
  return (
    <article
      onClickCapture={(event) => {
        if (!session.isCurrent()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className="min-w-0 space-y-6 text-foreground"
      aria-busy={state.busy}
    >
      <header className="space-y-3">
        <PageHeading>{m.zone_editor_heading()}</PageHeading>
        <p className="max-w-3xl text-muted-foreground">{m.zone_editor_live_note()}</p>
      </header>
      {!draft || !saved ? (
        <>
          {loaded.resource.kind === 'failure' ? <EditorFailure failure={loaded.resource} /> : null}
          {state.failure ? <EditorFailure failure={state.failure} /> : null}
          <Button disabled={!enabled || state.busy} onClick={() => void session.refresh()}>
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
              {loaded.permissions.failure ? <EditorFailure failure={loaded.permissions.failure} /> : null}
            </div>
          ) : !loaded.permissions.configure ? (
            <p role="note">{m.zone_editor_denied()}</p>
          ) : null}
          {state.failure ? <EditorFailure failure={state.failure} /> : null}
          {state.notice ? (
            <p role="status">{state.notice === 'saved' ? m.zone_editor_saved() : m.zone_editor_published()}</p>
          ) : null}
          {state.conflict ? (
            <section className="space-y-3 rounded-xl border border-border p-4" aria-label={m.zone_editor_conflict()}>
              <p role="alert">{m.zone_editor_conflict()}</p>
              {state.conflict.resource.kind === 'failure' ? (
                <EditorFailure failure={state.conflict.resource} />
              ) : (
                <p>{m.zone_editor_saved_head({ revision: state.conflict.resource.value.zone.revision })}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={state.busy || state.conflict.resource.kind !== 'ready'}
                  onClick={() => session.resolve('reload')}
                >
                  {m.zone_editor_reload()}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    state.busy || state.conflict.resource.kind !== 'ready' || !state.conflict.permissions.configure
                  }
                  onClick={() => session.resolve('reapply')}
                >
                  {m.zone_editor_reapply()}
                </Button>
                <Button variant="outline" disabled={state.busy} onClick={() => void session.refresh()}>
                  {m.zone_editor_retry()}
                </Button>
              </div>
            </section>
          ) : null}
          {state.violations.length ? (
            <div role="alert" className="space-y-2">
              <p>{m.zone_editor_validation()}</p>
              <ul className="list-disc ps-5">
                {state.violations.map(({ pointer, code }) => (
                  <li key={`${pointer}:${code}`}>
                    <code>
                      {pointer} · {code}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ZoneNameFields
            locale={locale}
            labels={draft.configuration.labels}
            primaryLanguage={draft.configuration.primaryLanguage}
            disabled={editDisabled}
            errors={[
              ...state.violations.map((error) => `/configuration${error.pointer}`),
              ...(state.failure?.errors?.map((error) => error.pointer) ?? []),
            ]}
            onChange={(names) => session.edit({ ...draft, configuration: { ...draft.configuration, ...names } })}
          />
          <section className="min-w-0 space-y-4" aria-labelledby="zone-pages-heading">
            <h2 id="zone-pages-heading" className="text-xl font-semibold">
              {m.zone_editor_pages()}
            </h2>
            <p className="text-sm text-muted-foreground">{m.zone_editor_navigation_note()}</p>
            <Field>
              <FieldLabel htmlFor="zone-page">{m.zone_editor_page()}</FieldLabel>
              <NativeSelect
                id="zone-page"
                disabled={disabled}
                value={route}
                onChange={(event) => {
                  if (!session.isCurrent()) return;
                  setSelected(event.target.value);
                  setComposing(false);
                  session.clearPreview();
                }}
              >
                {draft.configuration.pages.map((item, index) => (
                  <NativeSelectOption key={`${index}:${item.route}`} value={item.route}>
                    {item.route || m.zone_home()}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            {page ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="zone-route">{m.zone_editor_route()}</FieldLabel>
                  <Input
                    id="zone-route"
                    value={route}
                    disabled={editDisabled || route === ''}
                    onChange={(event) => changeRoute(event.target.value)}
                    maxLength={255}
                    aria-describedby="zone-route-help"
                  />
                  <FieldDescription id="zone-route-help">{m.zone_editor_route_help()}</FieldDescription>
                </Field>
                <Button
                  variant="outline"
                  disabled={editDisabled || route === ''}
                  onClick={() => {
                    if (!session.isCurrent()) return;
                    session.edit({
                      ...draft,
                      configuration: {
                        ...draft.configuration,
                        pages: draft.configuration.pages.filter((item) => item !== page),
                      },
                    });
                    setSelected('');
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
                    if (session.isCurrent()) setNewRoute(event.target.value);
                  }}
                  disabled={editDisabled || draft.configuration.pages.length >= 16}
                  maxLength={255}
                />
              </Field>
              <Button
                variant="outline"
                disabled={
                  editDisabled ||
                  draft.configuration.pages.length >= 16 ||
                  !newRoute ||
                  draft.configuration.pages.some((item) => item.route === newRoute)
                }
                onClick={() => {
                  if (!session.isCurrent()) return;
                  const pages = [
                    ...draft.configuration.pages,
                    { route: newRoute, document: { root: { props: {} }, content: [] } },
                  ].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
                  session.edit({ ...draft, configuration: { ...draft.configuration, pages } });
                  setSelected(newRoute);
                  setNewRoute('');
                  setComposing(false);
                }}
              >
                {m.zone_editor_add()}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{m.zone_editor_composition_note()}</p>
            <Button
              variant="outline"
              disabled={editDisabled}
              onClick={() => {
                if (session.isCurrent()) setComposing(!composing);
              }}
              aria-expanded={composing}
            >
              {m.zone_editor_compose()}
            </Button>
            {composing && page && !editDisabled ? (
              <Suspense fallback={<EditorLoading />}>
                <CompositionEditor
                  key={`${state.generation}:${route}:${locale}`}
                  document={page.document}
                  locale={locale}
                  onChange={changeDocument}
                />
              </Suspense>
            ) : null}
          </section>
          <section className="space-y-4" aria-labelledby="zone-sources-heading">
            <h2 id="zone-sources-heading" className="text-xl font-semibold">
              {m.zone_editor_sources()}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">{m.zone_editor_source_note()}</p>
            <fieldset disabled={editDisabled} className="space-y-3">
              <legend className="font-semibold">{m.zone_editor_scopes()}</legend>
              {scopeOptions.kind === 'failure' ? (
                <EditorFailure failure={scopeOptions} />
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
            <fieldset disabled={editDisabled} className="space-y-3">
              <legend className="font-semibold">{m.zone_editor_mounts()}</legend>
              {mountOptions.kind === 'failure' ? <EditorFailure failure={mountOptions} /> : null}
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
              <Button variant="outline" disabled={disabled} onClick={() => void session.moreCollections()}>
                {m.zone_editor_more()}
              </Button>
            ) : null}
            <Button variant="outline" disabled={disabled} onClick={() => void session.refresh()}>
              {m.zone_editor_refresh()}
            </Button>
          </section>
          <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <Button disabled={editDisabled || !writeEnabled || !dirty} onClick={() => void session.save()}>
              {m.zone_editor_save()}
            </Button>
            <Field className="w-auto">
              <FieldLabel htmlFor="zone-visibility">{m.zone_editor_visibility()}</FieldLabel>
              <NativeSelect
                id="zone-visibility"
                value={visibility}
                disabled={disabled || !writeEnabled || !loaded.permissions.publish}
                onChange={(event) => {
                  if (session.isCurrent()) setVisibility(event.target.value as Visibility);
                }}
              >
                <NativeSelectOption value="private">{m.library_visibility_private()}</NativeSelectOption>
                <NativeSelectOption value="unlisted">{m.library_visibility_unlisted()}</NativeSelectOption>
                <NativeSelectOption value="public">{m.library_visibility_public()}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Button
              variant="outline"
              disabled={
                disabled ||
                !writeEnabled ||
                dirty ||
                !loaded.permissions.publish ||
                visibility === saved.zone.visibility
              }
              onClick={() => void session.publish(visibility)}
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
              <Button variant="outline" disabled={disabled || dirty} onClick={() => void session.preview(route)}>
                {m.zone_editor_preview()}
              </Button>
              <a className="text-primary underline" href={href} target="_blank" rel="noopener noreferrer">
                {m.zone_editor_open()}
              </a>
              <Button variant="outline" disabled={!enabled} onClick={() => void copy()}>
                {m.zone_editor_copy()}
              </Button>
            </div>
            {copied ? (
              <p role="status">{copied === 'copied' ? m.zone_editor_copied() : m.zone_editor_copy_failed()}</p>
            ) : null}
            {state.preview?.kind === 'failure' ? (
              <>
                <EditorFailure failure={state.preview} />
                <Button variant="outline" disabled={disabled || dirty} onClick={() => void session.preview(route)}>
                  {m.zone_editor_retry()}
                </Button>
              </>
            ) : null}
            {state.preview?.kind === 'preparing' ? (
              <div role="status">
                <p>{m.zone_preparing_message()}</p>
                <p>{m.zone_editor_retry_after({ seconds: state.preview.retryAfter })}</p>
                <Button variant="outline" disabled={disabled || dirty} onClick={() => void session.preview(route)}>
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
