import { QueryClientContext } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
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
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import type { CollectionVisibility } from '../library/reads';
import { readOwnedCollection, readOwnedCollectionsPage, saveCollectionVisibility } from './actions';
import type { OwnedCollection } from './preferences';
import { usePreferenceRetry } from './preference-failure-retry';
import type { CollectionPrivacyFailure } from './collection-privacy-data';
import { useSettingsNavigationDraft } from './reading-navigation';
import { collectionPrivacyNeedsNavigationDecision } from './settings-draft-state';
import {
  CollectionPrivacyEditor,
  CollectionPrivacyPager,
  type CollectionPrivacyIO,
  type CollectionPrivacyPageRead,
} from './collection-privacy-recovery';

import {
  SettingsSessionOwner,
  useSettingsSessionOwner,
  useSettingsLiveness,
  useSettingsDisposal,
} from './settings-session-owner';

const preferenceActionClassName = 'h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal wrap-anywhere';
const noPagerSubscribe = () => () => {};
const noPagerSnapshot = () => null;

function visibilityOptions(collection: OwnedCollection): CollectionVisibility[] {
  return [...new Set([collection.visibility, ...collection.allowedVisibilityActions])];
}
export function collectionPrivacyIO(
  owner: SettingsSessionOwner,
  transport = {
    save: (data: Parameters<CollectionPrivacyIO['save']>[0], token: string) =>
      saveCollectionVisibility({ data, headers: { 'X-CSRF-Token': token } }),
    read: (data: string) => readOwnedCollection({ data }),
  },
): CollectionPrivacyIO {
  return {
    save: (data) => owner.guard((token) => transport.save(data, token)),
    read: (id) => owner.guardRead(() => transport.read(id)),
  };
}
const nativePageRead: CollectionPrivacyPageRead = (data) => readOwnedCollectionsPage({ data });
const ListRestartContext = createContext<CollectionPrivacyPager | null>(null);

function label(value: CollectionVisibility) {
  return value === 'private'
    ? m.settings_privacy_private()
    : value === 'unlisted'
      ? m.settings_privacy_unlisted()
      : m.settings_privacy_public();
}
function explanation(value: CollectionVisibility) {
  return value === 'private'
    ? m.settings_privacy_private_text()
    : value === 'unlisted'
      ? m.settings_privacy_unlisted_text()
      : m.settings_privacy_public_text();
}
function failureText(failure: CollectionPrivacyFailure | 'invalid' | undefined | null) {
  return failure === 'closed'
    ? m.settings_privacy_closed()
    : failure === 'forbidden'
      ? m.settings_privacy_forbidden()
      : failure === 'invalid'
        ? m.settings_privacy_refused()
        : m.settings_privacy_unavailable();
}

type CollectionRowProps = { collection: OwnedCollection; io?: CollectionPrivacyIO };
type OwnedRowProps = CollectionRowProps & { owner: SettingsSessionOwner | null };

export function CollectionRow(props: CollectionRowProps) {
  const client = useContext(QueryClientContext);
  const owner = useSettingsSessionOwner(undefined, undefined, !!props.io);
  // Explicit isolated IO has no session or exposure producer. An installed owner still takes precedence.
  if (!client) return <CollectionRowView {...props} owner={owner} canSave={!!props.io} canRead={!!props.io} />;
  return <AdmittedCollectionRow {...props} owner={owner} />;
}

function AdmittedCollectionRow(props: OwnedRowProps) {
  const canSave = useOperation('collection.update');
  const canRead = useOperation('collection.get');
  return <CollectionRowView {...props} canSave={canSave} canRead={canRead} />;
}

function CollectionRowView({
  collection,
  io,
  owner,
  canSave,
  canRead,
}: OwnedRowProps & { canSave: boolean; canRead: boolean }) {
  const mayWrite = () => (owner ? owner.isCurrent() : !!io);
  const isCurrent = useSettingsLiveness(owner?.readCurrent ?? (() => !!io));
  const [editor] = useState(
    () =>
      new CollectionPrivacyEditor(
        collection,
        owner
          ? collectionPrivacyIO(owner, io ? { save: (data) => io.save(data), read: (id) => io.read(id) } : undefined)
          : (io ?? {
              save: async () => {
                throw new Error('Settings viewer unavailable');
              },
              read: async () => {
                throw new Error('Settings viewer unavailable');
              },
            }),
        isCurrent,
        () => isCurrent() && mayWrite(),
      ),
  );
  useSettingsDisposal(editor.dispose);
  const pager = useContext(ListRestartContext);
  const pageState = useSyncExternalStore(
    pager?.subscribe ?? noPagerSubscribe,
    pager?.snapshot ?? noPagerSnapshot,
    pager?.snapshot ?? noPagerSnapshot,
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  useSettingsNavigationDraft(
    'collection-privacy',
    isCurrent() && collectionPrivacyNeedsNavigationDecision(state),
    () => isCurrent() && collectionPrivacyNeedsNavigationDecision(editor.snapshot()),
    editor,
  );
  useLayoutEffect(() => pager?.registerRow(editor), [editor, pager]);
  useLayoutEffect(() => editor.receive(collection), [collection, editor]);
  const commandWaiting = usePreferenceRetry(undefined, editor.commandRetryDeadline());
  const readWaiting = usePreferenceRetry(undefined, editor.currentReadRetryDeadline());
  const waiting = commandWaiting || readWaiting;
  const id = useId();
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const busy = state.phase === 'saving' || state.phase === 'reloading' || !!pageState?.loading;
  const { current, desired, phase } = state;
  const abandonAction =
    state.attempt && ['uncertain', 'readback'].includes(phase) ? (
      <Button
        className={preferenceActionClassName}
        type="button"
        variant="outline"
        disabled={busy || waiting}
        onClick={() => setConfirmAbandon(true)}
      >
        {m.settings_privacy_stop_tracking()}
      </Button>
    ) : null;
  const abandonmentDialog = state.attempt ? (
    <AlertDialog open={confirmAbandon} onOpenChange={setConfirmAbandon}>
      <AlertDialogContent className="min-w-0 w-[calc(100vw-2rem)] max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{m.settings_privacy_abandon_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {state.receipt ? m.settings_privacy_abandon_receipt_text() : m.settings_privacy_abandon_unknown_text()}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="min-w-0 flex-col-reverse sm:flex-row sm:flex-wrap">
          <AlertDialogCancel className={preferenceActionClassName} onClick={() => setConfirmAbandon(false)}>
            {m.settings_privacy_keep_tracking()}
          </AlertDialogCancel>
          <AlertDialogAction
            className={preferenceActionClassName}
            onClick={() => {
              editor.abandon();
              setConfirmAbandon(false);
            }}
          >
            {m.settings_privacy_confirm_stop_tracking()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;
  if (!isCurrent()) return null;
  if (state.readRefusal) {
    return (
      <ListRow className="py-3">
        <ListRowControl className="min-w-0 max-w-full">
          <Alert variant="destructive" aria-live="polite">
            <AlertTitle>
              {state.attempt
                ? phase === 'readback'
                  ? m.settings_privacy_readback_title()
                  : m.settings_privacy_uncertain_title()
                : m.settings_privacy_read_failed_title()}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{failureText(state.failure ?? state.readRefusal)}</p>
              {state.attempt ? (
                <p>{phase === 'readback' ? m.settings_privacy_readback_text() : m.settings_privacy_uncertain_text()}</p>
              ) : (
                <p>{m.settings_privacy_reload_after_refusal()}</p>
              )}
              {waiting ? <p role="status">{m.settings_privacy_row_retry_wait()}</p> : null}
              {busy ? <p role="status">{m.settings_privacy_reading()}</p> : null}
              {abandonAction}
              <Button
                className={preferenceActionClassName}
                type="button"
                variant="outline"
                disabled={!canRead || busy || readWaiting || !!pageState?.restarting}
                onClick={() => {
                  if (!pageState?.restarting) {
                    if (state.attempt) void editor.reload();
                    else void pager?.restart();
                  }
                }}
              >
                {state.attempt ? m.settings_privacy_reload_row() : m.settings_privacy_refresh_list()}
              </Button>
            </AlertDescription>
          </Alert>
        </ListRowControl>
        {abandonmentDialog}
      </ListRow>
    );
  }
  if (!current) return null;
  const options = [...new Set([...visibilityOptions(current), ...(desired !== current.visibility ? [desired] : [])])];
  const canChangeVisibility = current.revision !== null && current.allowedVisibilityActions.length > 0;
  const href = `/${getLocale()}/collections/${encodeURIComponent(current.id)}`;
  return (
    <ListRow className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] sm:items-center">
      <div className="min-w-0">
        <ListRowLink href={href}>{current.title}</ListRowLink>
        <span
          aria-hidden="true"
          className="break-words font-medium text-primary underline-offset-4 group-hover:underline group-focus-within:underline"
        >
          {current.title}
        </span>
        <p className="mt-1 text-sm text-muted-foreground">{explanation(current.visibility)}</p>
        <p id={`${id}-current`} className="mt-1 text-sm text-muted-foreground">
          {m.settings_privacy_current({ visibility: label(current.visibility) })}
        </p>
      </div>
      <ListRowControl className="min-w-0 max-w-full">
        <Field className="min-w-0">
          <FieldLabel className="max-w-full wrap-anywhere" htmlFor={id}>
            {m.settings_privacy_visibility_label()}
          </FieldLabel>
          <NativeSelect
            className="w-full min-w-0 max-w-full [&>select]:h-auto [&>select]:min-h-11 [&>select]:min-w-11"
            id={id}
            value={desired}
            aria-describedby={`${id}-current`}
            disabled={
              !isCurrent() ||
              pageState?.loading ||
              !mayWrite() ||
              !canSave ||
              !canChangeVisibility ||
              phase === 'abandoned' ||
              (waiting && (phase === 'idle' || phase === 'saved'))
            }
            onChange={(event) => {
              if (pageState?.loading) return;
              const value = options.find((option) => option === event.target.value);
              if (value) void editor.edit(value);
            }}
          >
            {options.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {label(value)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </ListRowControl>
      <ListRowControl className="min-w-0 max-w-full sm:col-span-2">
        <div aria-live="polite" aria-atomic="true" className="space-y-3">
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {phase === 'saving' ? m.settings_saving() : m.settings_privacy_reading()}
            </p>
          ) : null}
          {waiting ? <p role="status">{m.settings_privacy_row_retry_wait()}</p> : null}
          {phase === 'saved' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.settings_saved()}
            </p>
          ) : null}
          {phase === 'abandoned' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {state.outcomeUnknown
                ? m.settings_privacy_abandoned_unknown_text()
                : m.settings_privacy_abandoned_receipt_text()}
            </p>
          ) : null}
          {['uncertain', 'readback', 'conflict', 'refused', 'review'].includes(phase) ? (
            <Alert variant={phase === 'uncertain' || phase === 'refused' ? 'destructive' : 'default'}>
              <AlertTitle>
                {phase === 'uncertain'
                  ? m.settings_privacy_uncertain_title()
                  : phase === 'readback'
                    ? m.settings_privacy_readback_title()
                    : phase === 'conflict'
                      ? m.settings_privacy_conflict_title()
                      : phase === 'review'
                        ? m.settings_privacy_review_title()
                        : m.settings_failed_title()}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {phase === 'uncertain'
                    ? m.settings_privacy_uncertain_text()
                    : phase === 'readback'
                      ? m.settings_privacy_readback_text()
                      : phase === 'conflict'
                        ? m.settings_privacy_conflict_text()
                        : phase === 'review'
                          ? m.settings_privacy_review_text()
                          : failureText(state.failure)}
                </p>
                {state.failure && phase !== 'refused' ? <p>{failureText(state.failure)}</p> : null}
                <div className="flex min-w-0 flex-wrap gap-2">
                  {phase === 'uncertain' ? (
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      variant="outline"
                      disabled={!mayWrite() || !canSave || busy || commandWaiting}
                      onClick={() => {
                        if (!pageState?.loading) void editor.retry();
                      }}
                    >
                      {m.settings_privacy_retry_original()}
                    </Button>
                  ) : null}
                  {phase === 'review' && desired !== current.visibility ? (
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      disabled={
                        !mayWrite() ||
                        !canSave ||
                        !current.allowedVisibilityActions.includes(desired) ||
                        busy ||
                        commandWaiting
                      }
                      onClick={() => {
                        if (!pageState?.loading) void editor.submit();
                      }}
                    >
                      {m.settings_privacy_save_choice()}
                    </Button>
                  ) : null}
                  {abandonAction}
                  <Button
                    className={preferenceActionClassName}
                    type="button"
                    variant="outline"
                    disabled={!canRead || busy || readWaiting}
                    onClick={() => {
                      if (!pageState?.loading) void editor.reload();
                    }}
                  >
                    {m.settings_privacy_reload_row()}
                  </Button>
                </div>
                <p>
                  {state.attempt ? m.settings_privacy_reload_keeps_original() : m.settings_privacy_reload_discards()}
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </ListRowControl>
      {abandonmentDialog}
    </ListRow>
  );
}

/** Mounts afresh whenever the prepared account or operation admission changes. */
export function CollectionPrivacySection() {
  const admitted = useOperation('account.collections');
  const { state, subject, csrfToken } = useSession();
  return admitted && state === 'signed-in' && subject ? (
    <CollectionPrivacyView key={JSON.stringify([subject, csrfToken])} />
  ) : null;
}

export function CollectionPrivacyView({
  read = nativePageRead,
  io,
}: {
  read?: CollectionPrivacyPageRead;
  io?: CollectionPrivacyIO;
}) {
  const owner = useSettingsSessionOwner(undefined, undefined, !!io || read !== nativePageRead);
  const isCurrent = useSettingsLiveness(owner?.readCurrent ?? (() => read !== nativePageRead));
  const [pager] = useState(
    () =>
      new CollectionPrivacyPager((cursor) => (owner ? owner.guardRead(() => read(cursor)) : read(cursor)), isCurrent),
  );
  useSettingsDisposal(pager.dispose);
  const state = useSyncExternalStore(pager.subscribe, pager.snapshot, pager.snapshot);
  const retryWaiting = usePreferenceRetry(undefined, pager.retryDeadline());
  const restartWaiting = usePreferenceRetry(undefined, pager.restartDeadline());
  const waiting = retryWaiting || restartWaiting;
  const retryButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const loadMoreButton = useRef<HTMLButtonElement>(null);
  const focusAfterPage = useRef(false);
  useEffect(() => {
    void pager.load();
  }, [pager]);
  useEffect(() => {
    if (!focusAfterPage.current || state.loading) return;
    focusAfterPage.current = false;
    if (state.failure) {
      if (state.nativeFailure?.code === 'invalid_cursor') refreshButton.current?.focus();
      else retryButton.current?.focus();
    } else if (state.next !== null) loadMoreButton.current?.focus();
    else refreshButton.current?.focus();
  }, [state.failure, state.loading, state.nativeFailure, state.next]);
  return (
    <section id="privacy" aria-labelledby="settings-privacy-heading" className="scroll-mt-6">
      <Card className="min-w-0 max-w-full">
        <CardHeader>
          <CardTitle>
            <h2 id="settings-privacy-heading">{m.settings_privacy_heading()}</h2>
          </CardTitle>
          <CardDescription>
            {m.settings_privacy_text()} {m.settings_privacy_members()}
          </CardDescription>
          <CardDescription>{m.settings_automatic_save_help()}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4">
          {state.loading ? <p role="status">{m.settings_privacy_loading()}</p> : null}
          {state.failure ? (
            <Alert variant="destructive">
              <AlertTitle>
                {state.loaded && state.next !== null && !pager.retryStartsAtFirstPage()
                  ? m.settings_privacy_page_load_failed()
                  : m.settings_privacy_list_load_failed()}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {state.failure === 'unavailable' && !state.loaded
                    ? m.settings_privacy_list_retry()
                    : failureText(state.failure)}
                </p>
                {state.nativeFailure?.code === 'invalid_cursor' ? <p>{m.settings_privacy_list_restart()}</p> : null}
                {waiting ? <p role="status">{m.settings_privacy_page_retry_wait()}</p> : null}
                <Button
                  ref={retryButton}
                  className={preferenceActionClassName}
                  type="button"
                  variant="outline"
                  disabled={state.loading || retryWaiting || (state.restartBlocked && pager.retryReplacesRows())}
                  onClick={() => {
                    focusAfterPage.current = true;
                    void pager.load();
                  }}
                >
                  {m.settings_retry()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {state.loaded && !state.failure && state.collections.length === 0 && state.next === null ? (
            <p className="text-sm text-muted-foreground">{m.settings_privacy_empty()}</p>
          ) : null}
          <ListRestartContext.Provider value={pager}>
            <ul className="space-y-3">
              {state.collections.map((collection) => (
                <CollectionRow
                  key={`${state.window}:${collection.id}`}
                  collection={collection}
                  {...(io ? { io } : {})}
                />
              ))}
            </ul>
          </ListRestartContext.Provider>
          {state.loaded || state.failure ? (
            <div className="space-y-2">
              <Button
                ref={refreshButton}
                className={preferenceActionClassName}
                type="button"
                variant="outline"
                disabled={state.loading || restartWaiting || state.restartBlocked}
                aria-describedby={state.restartBlocked ? 'settings-privacy-refresh-blocked' : undefined}
                onClick={() => {
                  focusAfterPage.current = true;
                  void pager.restart();
                }}
              >
                {m.settings_privacy_refresh_list()}
              </Button>
              {state.restartBlocked ? (
                <p id="settings-privacy-refresh-blocked" role="status" className="text-sm text-muted-foreground">
                  {m.settings_privacy_refresh_blocked()}
                </p>
              ) : null}
            </div>
          ) : null}
          {state.next !== null && !state.failure ? (
            <Button
              ref={loadMoreButton}
              className={preferenceActionClassName}
              type="button"
              variant="outline"
              disabled={state.loading || waiting || state.restartBlocked}
              aria-describedby={state.restartBlocked ? 'settings-privacy-refresh-blocked' : undefined}
              onClick={() => {
                focusAfterPage.current = true;
                void pager.load();
              }}
            >
              {state.loading ? m.settings_privacy_loading() : m.settings_privacy_load_more()}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
