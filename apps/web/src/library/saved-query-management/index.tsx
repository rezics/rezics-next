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
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { useCollectionCurrentAdmission } from '../collection-current-admission';
import { admitsCollectionOperation } from '../collection-records';
import type { DynamicCollectionPage } from '../dynamic-collection';
import { useSession } from '../../session/query';
import { CollectionMetadataEditor } from '../collection-editor';
import { SavedQueryManagementController, type ManagedSavedQuery } from './controller';
import { savedQueryReturnTo } from './return-to';

type Operation = 'collection.update' | 'collection.delete';

function isOrdinaryOwner(page: ManagedSavedQuery, viewerId: string | null): viewerId is string {
  return Boolean(viewerId && !page.builtinKind && page.curatorAccountId === viewerId);
}

function actionFor(operation: Operation): string {
  return operation === 'collection.update' ? 'collection:update' : 'collection:delete';
}

function pageAllows(page: ManagedSavedQuery, operation: Operation): boolean {
  return admitsCollectionOperation(page.viewerActions, actionFor(operation), operation);
}

/** Current owner-only entry to saved-query metadata and delete commands. */
export function SavedQueryManagement({
  page,
  viewerId,
  queryKey,
  readCurrent,
  returnTo,
  onMetadata,
}: {
  page: DynamicCollectionPage;
  viewerId: string | null;
  queryKey?: readonly unknown[];
  readCurrent?: (() => Promise<DynamicCollectionPage>) | undefined;
  returnTo?: string | undefined;
  onMetadata: (page: ManagedSavedQuery) => void;
}) {
  const session = useSession();
  const evidence = JSON.stringify([page.visibility !== null, page.viewerActions]);
  const admission = useCollectionCurrentAdmission(page.id, evidence, queryKey);
  if (!isOrdinaryOwner(page, viewerId)) return null;

  const current = (operation: Operation, candidate: ManagedSavedQuery = page) =>
    isOrdinaryOwner(candidate, viewerId) &&
    candidate.visibility !== undefined &&
    candidate.visibility !== null &&
    pageAllows(candidate, operation) &&
    admission.current('collection.get') &&
    admission.current(operation);
  const canUpdate = current('collection.update');
  const canDelete = current('collection.delete');
  const unavailable =
    page.viewerActions?.state === 'unavailable' || page.visibility === undefined || !Number.isSafeInteger(page.revision);
  const accessState: 'ready' | 'preparing' | 'denied' | 'unavailable' = !admission.observed()
    ? 'preparing'
    : unavailable
      ? 'unavailable'
      : canUpdate || canDelete
        ? 'ready'
        : 'denied';
  const identity = JSON.stringify([
    admission.owner,
    page.id,
    viewerId,
    session.state,
    session.subject,
    session.csrfToken ?? null,
  ]);

  return (
    <SavedQueryManagementLifetime
      key={identity}
      page={page}
      viewerId={viewerId}
      accessState={accessState}
      canUpdate={canUpdate}
      canDelete={canDelete}
      isCurrent={current}
      csrf={(operation) => admission.csrf(operation)}
      readCurrent={readCurrent}
      onMetadata={onMetadata}
      returnTo={returnTo}
    />
  );
}

function SavedQueryManagementLifetime({
  page,
  viewerId,
  accessState,
  canUpdate,
  canDelete,
  isCurrent,
  csrf,
  readCurrent,
  onMetadata,
  returnTo,
}: {
  page: DynamicCollectionPage;
  viewerId: string;
  accessState: 'ready' | 'preparing' | 'denied' | 'unavailable';
  canUpdate: boolean;
  canDelete: boolean;
  isCurrent: (operation: Operation, candidate?: ManagedSavedQuery) => boolean;
  csrf: (operation: Operation) => string | null;
  readCurrent?: (() => Promise<DynamicCollectionPage>) | undefined;
  onMetadata: (page: ManagedSavedQuery) => void;
  returnTo?: string | undefined;
}) {
  const ports = useRef({ page, viewerId, isCurrent, csrf, readCurrent, onMetadata, returnTo });
  ports.current = { page, viewerId, isCurrent, csrf, readCurrent, onMetadata, returnTo };
  const [controller] = useState(
    () =>
      new SavedQueryManagementController({
        collectionId: page.id,
        viewerId,
        readCurrent: async () => {
          const read = ports.current.readCurrent;
          if (!read) throw new Error('Current Collection read unavailable');
          return read();
        },
        isCurrent: (operation, candidate) => ports.current.isCurrent(operation, candidate),
        csrf: (operation) => ports.current.csrf(operation),
        onMetadata: (candidate) => ports.current.onMetadata(candidate),
        onDeleted: () => {
          const destination = savedQueryReturnTo(ports.current.returnTo, getLocale());
          window.location.assign(destination);
        },
      }),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const previousPhase = useRef(state.phase);

  useEffect(() => {
    if (previousPhase.current === 'reading' && state.phase === 'ready') {
      if (controller.can('collection.update'))
        document.getElementById('collection-edit-title')?.focus();
      else close.current?.focus();
    }
    if (previousPhase.current === 'ready' && state.phase === 'closed') trigger.current?.focus();
    previousPhase.current = state.phase;
  }, [controller, state.phase]);
  useLayoutEffect(() => () => controller.retire(), [controller]);

  function retryRead() {
    if (readCurrent) controller.retryRead();
  }

  function submitMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controller.save();
  }

  function renderOutcome() {
    if (state.outcome === 'saved') return <p role="status">{m.library_saved_query_management_saved()}</p>;
    if (state.outcome === 'conflict')
      return (
        <div className="space-y-2" role="alert">
          <p>{m.library_collection_conflict()}</p>
          <Button type="button" variant="outline" onClick={controller.requestReconcile}>
            {m.library_saved_query_management_read_current()}
          </Button>
        </div>
      );
    if (state.outcome === 'refused')
      return (
        <div className="space-y-2" role="alert">
          <p>{m.library_saved_query_management_refused()}</p>
          <Button type="button" variant="outline" onClick={controller.requestReconcile}>
            {m.library_saved_query_management_read_current()}
          </Button>
        </div>
      );
    if (state.outcome !== 'unknown' || !state.intent) return null;
    const operation = state.intent.operation;
    const retryAllowed = controller.can(operation) && !state.busy;
    return (
      <div className="space-y-3 rounded-lg border border-border p-3" role="alert">
        <p>{m.library_saved_query_management_unknown()}</p>
        <p className="break-words text-sm text-muted-foreground">
          {m.library_rule_collection_revision({ revision: state.snapshot?.revision ?? 0 })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!retryAllowed} onClick={controller.retryOriginal}>
            {m.library_saved_query_management_retry_original()}
          </Button>
          <Button type="button" variant="outline" onClick={controller.requestReconcile}>
            {m.library_saved_query_management_read_current()}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      className="mt-4 space-y-3 [&_button]:min-h-11 [&_input]:min-h-11 [&_textarea]:min-h-24"
      aria-label={m.library_saved_query_manage()}
      data-saved-query-management
    >
      {accessState === 'ready' ? (
        state.phase === 'closed' ? (
          <Button ref={trigger} type="button" variant="outline" onClick={controller.open}>
            {m.library_saved_query_manage()}
          </Button>
        ) : null
      ) : accessState === 'preparing' ? (
        <p role="status">{m.library_saved_query_management_preparing()}</p>
      ) : (
        <div className="space-y-2">
          <p role={accessState === 'unavailable' ? 'alert' : 'status'}>
            {accessState === 'unavailable'
              ? m.library_saved_query_management_unavailable()
              : m.library_saved_query_management_denied()}
          </p>
          {readCurrent ? (
            <Button type="button" variant="outline" disabled={state.phase === 'reading'} onClick={controller.open}>
              {m.library_collections_retry()}
            </Button>
          ) : null}
        </div>
      )}

      {state.phase === 'reading' ? <p role="status">{m.library_saved_query_management_preparing()}</p> : null}
      {state.busy ? <p role="status">{m.library_saved_query_management_pending()}</p> : null}
      {state.phase === 'unavailable' ? (
        <div className="space-y-2" role="alert">
          {state.confirmedNotice === 'saved' ? <p>{m.library_saved_query_management_saved()}</p> : null}
          <p>{m.library_saved_query_management_unavailable()}</p>
          <Button type="button" variant="outline" onClick={retryRead}>
            {m.library_collections_retry()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'denied' ? (
        <div className="space-y-2">
          <p role="status">{m.library_saved_query_management_denied()}</p>
          <Button type="button" variant="outline" onClick={retryRead}>
            {m.library_collections_retry()}
          </Button>
        </div>
      ) : null}

      {state.phase === 'ready' && state.snapshot ? (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">{m.library_saved_query_management_heading()}</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {m.library_saved_query_management_metadata_only()}
            </p>
          </div>
          {renderOutcome()}
          {state.intent ? (
            <dl className="grid min-w-0 gap-2 rounded-lg border border-border p-3 text-sm">
              <dt className="font-medium">{m.library_collection_title()}</dt>
              <dd className="break-words">{state.intent.operation === 'collection.update' ? state.title : state.snapshot.title}</dd>
              <dt className="font-medium">{m.library_saved_query_management_collection_id()}</dt>
              <dd className="break-all font-mono">{state.snapshot.id}</dd>
              <dt className="font-medium">{m.library_rule_collection_revision({ revision: state.snapshot.revision ?? 0 })}</dt>
              <dd>{state.snapshot.revision ?? 0}</dd>
            </dl>
          ) : canUpdate ? (
            <CollectionMetadataEditor
              title={state.title}
              description={state.description}
              disabled={state.busy || state.outcome === 'conflict' || !isCurrent('collection.update', state.snapshot)}
              textSubmitted={state.textSubmitted}
              onTitleChange={controller.setTitle}
              onDescriptionChange={controller.setDescription}
              onSubmit={submitMetadata}
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={!controller.dirty || state.busy || state.outcome === 'conflict'}
                  aria-busy={state.busy}
                >
                  {m.library_collection_save()}
                </Button>
                <Button
                  ref={close}
                  type="button"
                  variant="outline"
                  disabled={state.busy}
                  onClick={controller.requestClose}
                >
                  {m.library_collection_cancel()}
                </Button>
                {canDelete ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={state.busy || !isCurrent('collection.delete', state.snapshot)}
                    onClick={controller.requestDelete}
                  >
                    {m.library_collection_delete()}
                  </Button>
                ) : null}
              </div>
            </CollectionMetadataEditor>
          ) : !state.intent ? (
            <div className="flex flex-wrap gap-2">
              <Button
                ref={close}
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={controller.requestClose}
              >
                {m.library_collection_cancel()}
              </Button>
              {canDelete ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={state.busy || !isCurrent('collection.delete', state.snapshot)}
                  onClick={controller.requestDelete}
                >
                  {m.library_collection_delete()}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <AlertDialog
        open={state.dialog === 'delete'}
        onOpenChange={(open, details) => {
          if (!open && state.busy) {
            details.cancel();
            return;
          }
          if (!open) controller.cancelDialog();
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_collection_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.library_saved_query_management_delete_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          {state.snapshot ? (
            <dl className="grid min-w-0 gap-2 text-sm">
              <dt className="font-medium">{m.library_collection_title()}</dt>
              <dd className="break-words">{state.snapshot.title}</dd>
              <dt className="font-medium">{m.library_saved_query_management_collection_id()}</dt>
              <dd className="break-all font-mono">{state.snapshot.id}</dd>
              <dt className="font-medium">{m.library_rule_collection_revision({ revision: state.snapshot.revision ?? 0 })}</dt>
            </dl>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={state.busy}>
              {m.library_collection_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-11"
              disabled={state.busy || !canDelete}
              aria-busy={state.busy}
              onClick={controller.confirmDelete}
            >
              {m.library_collection_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={state.dialog === 'departure'}
        onOpenChange={(open, details) => {
          if (!open && state.busy) {
            details.cancel();
            return;
          }
          if (!open) controller.cancelDialog();
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_saved_query_management_leave_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.library_saved_query_management_leave_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={state.busy}>
              {m.library_collection_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction className="min-h-11" variant="destructive" onClick={controller.confirmDeparture}>
              {m.library_saved_query_management_leave_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={state.dialog === 'reconcile'}
        onOpenChange={(open, details) => {
          if (!open && state.busy) {
            details.cancel();
            return;
          }
          if (!open) controller.cancelDialog();
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_saved_query_management_reconcile_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.library_saved_query_management_reconcile_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={state.busy}>
              {m.library_collection_cancel()}
            </AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={controller.confirmReconcile}>
              {m.library_saved_query_management_reconcile_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
