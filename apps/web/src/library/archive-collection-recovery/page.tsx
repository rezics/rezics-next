import { useCallback, useEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import { useOperationAdmission } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { ArchiveRecoveryDeparture } from './departure';
import {
  createArchiveCollectionRecoveryJourney,
  type ArchiveCollectionRecoveryJourney,
  type RecoveryNotice,
} from './controller';
import { RECOVERY_APPLY_COMMANDS } from './contract';
import { useArchiveCollectionRecoveryPort } from './port';
import { ArchiveCollectionChooser, ArchiveOccurrenceChooser, ArchiveRecoveryReview } from './review';
import { ArchiveRecoveryConflict, ArchiveRecoveryResults, ArchiveRecoveryUnknown } from './results';
import { ArchiveCollectionWorkspace } from './collection-workspace';
import { actionClass } from '../private-export/controls';
import { toggleOccurrence, togglePage } from './selection';
import { ArchiveCollectionRecoveryUpload } from './upload';
import { useRecoveryVisit, type RecoveryVisit } from './visit';
import type { RecoveryReader } from './window';
import { archiveBase64FromCustody, bindArchiveCustodyOwner, completedArchiveFor } from '../private-export/custody';
import { ArchiveRecoveryDestinations } from '../private-export/destinations';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';

const visitIds = new WeakMap<RecoveryVisit, number>();
let nextVisitId = 0;

function visitKey(visit: RecoveryVisit): number {
  let id = visitIds.get(visit);
  if (id === undefined) {
    id = ++nextVisitId;
    visitIds.set(visit, id);
  }
  return id;
}

function noticeText(notice: RecoveryNotice): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_archive_recovery_uncertain();
  if (notice.kind === 'denied') return m.library_archive_recovery_denied();
  if (notice.kind === 'not-found') return m.library_archive_recovery_expired_help();
  if (notice.kind === 'conflict') return m.library_archive_recovery_conflict_help();
  if (notice.kind === 'invalid') return m.library_archive_recovery_invalid();
  return m.library_archive_recovery_unavailable();
}

function terminal(stage: string): stage is 'expired' | 'denied' | 'unavailable' {
  return stage === 'expired' || stage === 'denied' || stage === 'unavailable';
}

export function PrivateArchiveCollectionRecoveryPage({ visit }: { visit?: RecoveryVisit | null }) {
  if (visit === undefined) return <CurrentArchiveCollectionRecoveryPage />;
  return <ArchiveCollectionRecoveryPageForVisit current={visit} />;
}

function CurrentArchiveCollectionRecoveryPage() {
  const current = useRecoveryVisit();
  return <ArchiveCollectionRecoveryPageForVisit current={current} />;
}

function ArchiveCollectionRecoveryPageForVisit({ current }: { current: RecoveryVisit | null }) {
  const operation = useOperationAdmission('collection.list');
  if (!current) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
        <p role="status">{m.library_archive_recovery_sign_in()}</p>
      </div>
    );
  }
  if (operation !== 'available') {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
        <p role="status">{m.library_archive_recovery_unavailable()}</p>
      </div>
    );
  }
  return <RecoverySession key={`${visitKey(current)}:${operation}`} visit={current} />;
}

function RecoverySession({ visit }: { visit: RecoveryVisit }) {
  const port = useArchiveCollectionRecoveryPort(visit);
  const journeyRef = useRef<ArchiveCollectionRecoveryJourney | null>(null);
  if (!journeyRef.current) {
    journeyRef.current = createArchiveCollectionRecoveryJourney({ port, visit });
  }
  const journey = journeyRef.current;
  const snapshotCache = useRef<ReturnType<typeof journey.snapshot> | null>(null);
  const subscribe = useCallback(
    (notify: () => void) =>
      journey.subscribe(() => {
        snapshotCache.current = null;
        notify();
      }),
    [journey],
  );
  const getSnapshot = useCallback(() => (snapshotCache.current ??= journey.snapshot()), [journey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const movementFocus = useRef<{ cancel: () => void } | null>(null);
  const text = noticeText(snapshot.notice);
  const locked = snapshot.notice?.kind === 'unknown';
  const terminalStage = terminal(snapshot.stage);
  const returnLink = (
    <a className={buttonVariants({ variant: 'link', className: actionClass })} href={localizeHref('/library')}>
      {m.library_archive_recovery_return_library()}
    </a>
  );

  useEffect(
    () => () => {
      movementFocus.current?.cancel();
      journey.retire();
    },
    [journey, visit],
  );
  function touch(action: Promise<void>) {
    void action;
  }

  function moveReader(
    event: MouseEvent<HTMLButtonElement>,
    reader: RecoveryReader | 'receiving',
    revision: number,
    headingId: string,
    action: () => Promise<void>,
  ) {
    movementFocus.current?.cancel();
    movementFocus.current = null;
    const trigger = event.currentTarget;
    if (event.detail !== 0 || document.activeElement !== trigger) {
      touch(action());
      return;
    }
    let cancelled = false;
    const release = () => {
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
    const cancel = () => {
      cancelled = true;
      release();
    };
    const request = { cancel };
    movementFocus.current = request;
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    const pending = action();
    const admitted = journey.snapshot().receivingWindow;
    void pending
      .then(() => {
        release();
        if (movementFocus.current === request) movementFocus.current = null;
        const current = journey.snapshot();
        const nextRevision =
          reader === 'collections'
            ? current.collectionsWindow.revision
            : reader === 'occurrences'
              ? current.occurrencesWindow.revision
              : reader === 'receiving'
                ? current.receivingWindow.revision
                : current.outcomesWindow.revision;
        const nextStage =
          reader === 'collections' ? 'collections' : reader === 'occurrences' ? 'occurrences' : 'results';
        const readbackRetired =
          reader === 'receiving' &&
          (current.receivingWindow.lifetime !== admitted.lifetime ||
            current.receivingWindow.request !== admitted.request ||
            current.receivingWindow.loading ||
            current.receivingWindow.failure !== null);
        if (
          cancelled ||
          !visit.current() ||
          current.stage !== nextStage ||
          nextRevision <= revision ||
          readbackRetired ||
          (document.activeElement !== trigger && document.activeElement !== document.body)
        )
          return;
        document.getElementById(headingId)?.focus();
      })
      .finally(release);
  }

  bindArchiveCustodyOwner(visit.subject);
  const completed = completedArchiveFor(visit.subject);
  const heading = (
    <div className="grid gap-3">
      <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
      <p>{m.library_archive_recovery_intro()}</p>
      <p className="rounded-lg border-l-4 border-primary p-3 text-sm">{m.library_archive_recovery_scope_notice()}</p>
      <ArchiveRecoveryDestinations current="collections" />
    </div>
  );
  const primaryAction =
    snapshot.stage === 'occurrences' ? (
      <Button
        type="button"
        variant="outline"
        className={actionClass}
        disabled={snapshot.busy || locked || !snapshot.selected.size}
        onClick={() => journey.prepareReview()}
      >
        {m.library_archive_recovery_open_review()}
      </Button>
    ) : snapshot.stage === 'conflict' ? (
      <Button
        variant="outline"
        className={actionClass}
        type="button"
        disabled={snapshot.busy || locked}
        onClick={() => touch(journey.refreshConflict())}
      >
        {m.library_archive_recovery_refresh()}
      </Button>
    ) : snapshot.stage === 'results' && snapshot.status ? (
      <>
        {snapshot.status.state === 'applying' ? (
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={snapshot.busy || locked}
            onClick={() => touch(journey.continueApply())}
          >
            {m.library_archive_recovery_apply_next({ commands: RECOVERY_APPLY_COMMANDS })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          disabled={snapshot.busy || locked || Boolean(snapshot.readRetry)}
          onClick={() => touch(journey.loadOutcomes())}
        >
          {m.library_archive_recovery_read_outcomes()}
        </Button>
      </>
    ) : null;

  return (
    <ArchiveCollectionWorkspace
      routeHeading={heading}
      stage={snapshot.stage}
      collection={snapshot.selectedCollection}
      primaryAction={primaryAction}
    >
      {text && snapshot.notice?.kind !== 'unknown' ? (
        <p tabIndex={-1} role="status" aria-live="polite" className="rounded-md border p-3">
          {text}
        </p>
      ) : null}
      {snapshot.readRetry ? (
        <Button
          type="button"
          variant="outline"
          disabled={snapshot.busy || locked}
          onClick={() => touch(journey.retryRead())}
        >
          {m.library_archive_recovery_retry_page()}
        </Button>
      ) : null}
      {snapshot.notice?.kind === 'unknown' ? (
        <ArchiveRecoveryUnknown busy={snapshot.busy} onRetry={() => touch(journey.retryUnknown())} />
      ) : null}

      {snapshot.stage === 'upload' ? (
        <ArchiveCollectionRecoveryUpload
          busy={snapshot.busy}
          locked={locked}
          isCurrent={() => visit.current()}
          canUseOriginal={snapshot.hasOriginalArchive}
          canUseCompleted={completed !== null}
          onUpload={(archiveBase64) => journey.upload(archiveBase64)}
          onUseOriginal={() => journey.adoptOriginalArchive()}
          onUseCompleted={() => journey.upload(archiveBase64FromCustody(completed!))}
        />
      ) : null}

      {snapshot.stage === 'collections' && snapshot.collectionsPage ? (
        <ArchiveCollectionChooser
          page={snapshot.collectionsPage}
          busy={snapshot.busy || locked || Boolean(snapshot.readRetry)}
          canPrevious={snapshot.collectionsWindow.canPrevious}
          onChoose={(collection) => touch(journey.chooseCollection(collection))}
          onFirst={(event) =>
            moveReader(event, 'collections', snapshot.collectionsWindow.revision, 'recovery-collections-title', () =>
              journey.loadCollections(),
            )
          }
          onPrevious={(event) =>
            moveReader(event, 'collections', snapshot.collectionsWindow.revision, 'recovery-collections-title', () =>
              journey.previousCollections(),
            )
          }
          onNext={(cursor, event) =>
            moveReader(event, 'collections', snapshot.collectionsWindow.revision, 'recovery-collections-title', () =>
              journey.loadCollections(cursor),
            )
          }
        />
      ) : null}

      {snapshot.stage === 'occurrences' && snapshot.occurrencesPage ? (
        <ArchiveOccurrenceChooser
          page={snapshot.occurrencesPage}
          selected={snapshot.selected}
          busy={snapshot.busy || locked || Boolean(snapshot.readRetry)}
          canPrevious={snapshot.occurrencesWindow.canPrevious}
          onToggle={(row) => journey.setSelection(toggleOccurrence(snapshot.selected, row))}
          onTogglePage={(rows) => journey.setSelection(togglePage(snapshot.selected, rows))}
          showReviewAction={false}
          onPage={(cursor, event) =>
            moveReader(event, 'occurrences', snapshot.occurrencesWindow.revision, 'recovery-occurrences-title', () =>
              journey.loadOccurrences(cursor),
            )
          }
          onFirst={(event) =>
            moveReader(event, 'occurrences', snapshot.occurrencesWindow.revision, 'recovery-occurrences-title', () =>
              journey.loadOccurrences(),
            )
          }
          onPrevious={(event) =>
            moveReader(event, 'occurrences', snapshot.occurrencesWindow.revision, 'recovery-occurrences-title', () =>
              journey.previousOccurrences(),
            )
          }
          onCollections={() => touch(journey.loadCollections())}
        />
      ) : null}

      {snapshot.stage === 'review' && snapshot.selectedCollection ? (
        <div className="grid gap-4">
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={snapshot.busy || locked}
            onClick={() => journey.editSelection()}
          >
            {m.library_archive_recovery_edit_selection()}
          </Button>
          <ArchiveRecoveryReview
            collection={snapshot.selectedCollection}
            selected={snapshot.selected}
            targets={snapshot.targets}
            presentationKind={snapshot.presentationKind}
            presentationEvidence={snapshot.occurrencesPage?.collection ?? null}
            review={snapshot.review}
            busy={snapshot.busy || locked}
            onTarget={(sourceId, target) => journey.setTarget(sourceId, target)}
            onPresentationKind={(kind) => journey.setPresentationKind(kind)}
            onSubmit={() => touch(journey.reviewSelection())}
            onApply={() => touch(journey.apply())}
          />
        </div>
      ) : null}

      {snapshot.stage === 'conflict' ? (
        <ArchiveRecoveryConflict
          busy={snapshot.busy || locked}
          showRefreshAction={false}
          onRefresh={() => touch(journey.refreshConflict())}
        />
      ) : null}

      {snapshot.stage === 'results' && snapshot.status ? (
        <div className="grid gap-4">
          <ArchiveRecoveryResults
            status={snapshot.status}
            targets={snapshot.targets}
            page={snapshot.outcomesPage}
            receiving={snapshot.receiving}
            busy={snapshot.busy || locked || Boolean(snapshot.readRetry)}
            canPrevious={snapshot.outcomesWindow.canPrevious}
            receivingWindow={snapshot.receivingWindow}
            receivingBusy={snapshot.busy}
            showReadAction={false}
            receivingActions={{
              onFirst: (event) =>
                moveReader(event, 'receiving', snapshot.receivingWindow.revision, 'recovery-receiving-title', () =>
                  journey.readReceivingCollection(),
                ),
              onPrevious: (event) =>
                moveReader(event, 'receiving', snapshot.receivingWindow.revision, 'recovery-receiving-title', () =>
                  journey.previousReceivingCollection(),
                ),
              onNext: (cursor, event) =>
                moveReader(event, 'receiving', snapshot.receivingWindow.revision, 'recovery-receiving-title', () =>
                  journey.readReceivingCollection(cursor),
                ),
              onRetry: (event) =>
                moveReader(event, 'receiving', snapshot.receivingWindow.revision, 'recovery-receiving-title', () =>
                  journey.retryReceivingCollection(),
                ),
            }}
            onRead={() => touch(journey.loadOutcomes())}
            onFirst={(event) =>
              moveReader(event, 'outcomes', snapshot.outcomesWindow.revision, 'recovery-results-title', () =>
                journey.loadOutcomes(),
              )
            }
            onPrevious={(event) =>
              moveReader(event, 'outcomes', snapshot.outcomesWindow.revision, 'recovery-results-title', () =>
                journey.previousOutcomes(),
              )
            }
            onNext={(cursor, event) =>
              moveReader(event, 'outcomes', snapshot.outcomesWindow.revision, 'recovery-results-title', () =>
                journey.loadOutcomes(cursor),
              )
            }
          />
          {snapshot.status.presentation.state === 'unsupported_or_stale' && !snapshot.status.collectionId ? (
            <Button
              type="button"
              variant="outline"
              className="justify-self-start"
              disabled={snapshot.busy || locked}
              onClick={() => journey.prepareReview()}
            >
              {m.library_archive_recovery_edit_selection()}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={snapshot.busy || locked}
            onClick={() => touch(journey.readStatus())}
          >
            {m.library_archive_recovery_read_status()}
          </Button>
          {['complete', 'partial', 'cancelled'].includes(snapshot.status.state) ? (
            <Button
              type="button"
              variant="outline"
              className="justify-self-start"
              disabled={snapshot.busy || locked}
              onClick={() => journey.restart()}
            >
              {m.library_archive_recovery_restart()}
            </Button>
          ) : null}
        </div>
      ) : null}

      {terminalStage ? (
        <section className="grid gap-4 rounded-xl border p-4" data-recovery-state={snapshot.stage}>
          <p role="status">
            {snapshot.stage === 'expired'
              ? m.library_archive_recovery_expired_help()
              : snapshot.stage === 'denied'
                ? m.library_archive_recovery_denied()
                : m.library_archive_recovery_unavailable()}
          </p>
          {snapshot.stage !== 'denied' ? (
            <Button
              type="button"
              variant="outline"
              className="justify-self-start"
              disabled={snapshot.busy}
              onClick={() => journey.restart()}
            >
              {m.library_archive_recovery_restart()}
            </Button>
          ) : null}
          {returnLink}
        </section>
      ) : null}

      {!terminalStage && snapshot.stage !== 'upload' ? returnLink : null}
      <ArchiveRecoveryDeparture
        active={
          Boolean(snapshot.uploadId) &&
          !terminalStage &&
          !(
            snapshot.status?.state === 'complete' ||
            snapshot.status?.state === 'partial' ||
            snapshot.status?.state === 'cancelled'
          )
        }
        locked={locked}
        busy={snapshot.busy}
        canCancel={
          Boolean(snapshot.uploadId) &&
          !['complete', 'partial', 'cancelled', 'expired'].includes(snapshot.status?.state ?? '')
        }
        onLeave={() => journey.retire()}
        onCancel={() => touch(journey.cancel())}
      />
    </ArchiveCollectionWorkspace>
  );
}
