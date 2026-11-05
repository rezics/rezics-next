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
import { ArchiveRecoveryConflict, ArchiveRecoveryResults } from './results';
import { toggleOccurrence, togglePage } from './selection';
import { ArchiveCollectionRecoveryUpload } from './upload';
import { useRecoveryVisit, type RecoveryVisit } from './visit';
import type { RecoveryReader } from './window';
import {
  archiveBase64FromCustody,
  bindArchiveCustodyOwner,
  completedArchiveFor,
} from '../private-export/custody';
import { ArchiveRecoveryDestinations } from '../private-export/destinations';

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
  const observed = useRecoveryVisit();
  const current = visit === undefined ? observed : visit;
  const operation = useOperationAdmission('collection.list');
  if (!current) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
        <p role="status">{m.library_archive_recovery_sign_in()}</p>
      </main>
    );
  }
  if (operation !== 'available') {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
        <p role="status">{m.library_archive_recovery_unavailable()}</p>
      </main>
    );
  }
  return <RecoverySession key={`${visitKey(current)}:${operation}`} visit={current} />;
}

function RecoverySession({ visit }: { visit: RecoveryVisit }) {
  const port = useArchiveCollectionRecoveryPort();
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
    <a className="min-h-11 inline-flex items-center underline" href={localizeHref('/library')}>
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
    reader: RecoveryReader,
    revision: number,
    headingId: string,
    action: Promise<void>,
  ) {
    if (event.detail !== 0 || document.activeElement !== event.currentTarget) {
      touch(action);
      return;
    }
    movementFocus.current?.cancel();
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      document.removeEventListener('focusin', onFocusIn, true);
    };
    const onFocusIn = () => cancel();
    const request = { cancel };
    movementFocus.current = request;
    document.addEventListener('focusin', onFocusIn, true);
    void action.then(() => {
      document.removeEventListener('focusin', onFocusIn, true);
      if (movementFocus.current === request) movementFocus.current = null;
      const current = journey.snapshot();
      const nextRevision =
        reader === 'collections'
          ? current.collectionsWindow.revision
          : reader === 'occurrences'
            ? current.occurrencesWindow.revision
            : current.outcomesWindow.revision;
      const nextStage = reader === 'collections' ? 'collections' : reader === 'occurrences' ? 'occurrences' : 'results';
      if (cancelled || !visit.current() || current.stage !== nextStage || nextRevision <= revision) return;
      document.getElementById(headingId)?.focus();
    });
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

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
      {heading}
      <nav aria-label={m.library_archive_recovery_steps()}>
        <ol className="flex flex-wrap gap-2 text-sm">
          {(['upload', 'collections', 'occurrences', 'review', 'results'] as const).map((step, index) => {
            const current =
              (snapshot.stage === 'upload' && step === 'upload') ||
              (snapshot.stage === 'collections' && step === 'collections') ||
              (snapshot.stage === 'occurrences' && step === 'occurrences') ||
              (snapshot.stage === 'review' && step === 'review') ||
              (['results', 'conflict', 'expired', 'denied', 'unavailable'].includes(snapshot.stage) &&
                step === 'results');
            const label =
              step === 'upload'
                ? m.library_archive_recovery_step_upload()
                : step === 'collections'
                  ? m.library_archive_recovery_step_collection()
                  : step === 'occurrences'
                    ? m.library_archive_recovery_step_occurrences()
                    : step === 'review'
                      ? m.library_archive_recovery_step_review()
                      : m.library_archive_recovery_step_results();
            return (
              <li key={step} aria-current={current ? 'step' : undefined}>
                <span
                  className={`inline-flex min-h-11 items-center rounded-full border px-3 ${current ? 'border-primary bg-primary/10 font-semibold' : ''}`}
                >
                  {index + 1}. {label}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      {text ? (
        <p tabIndex={-1} role="status" aria-live="polite" className="rounded-md border p-3">
          {text}
        </p>
      ) : null}
      {snapshot.readRetry ? (
        <button
          type="button"
          className="min-h-11 rounded-md border px-4 font-medium"
          disabled={snapshot.busy || locked}
          onClick={() => touch(journey.retryRead())}
        >
          {m.library_archive_recovery_retry_page()}
        </button>
      ) : null}
      {snapshot.notice?.kind === 'unknown' ? (
        <button
          type="button"
          className="min-h-11 rounded-md border px-4 font-medium"
          disabled={snapshot.busy}
          onClick={() => touch(journey.retryUnknown())}
        >
          {m.library_archive_recovery_retry_original()}
        </button>
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
            moveReader(
              event,
              'collections',
              snapshot.collectionsWindow.revision,
              'recovery-collections-title',
              journey.loadCollections(),
            )
          }
          onPrevious={(event) =>
            moveReader(
              event,
              'collections',
              snapshot.collectionsWindow.revision,
              'recovery-collections-title',
              journey.previousCollections(),
            )
          }
          onNext={(cursor, event) =>
            moveReader(
              event,
              'collections',
              snapshot.collectionsWindow.revision,
              'recovery-collections-title',
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
          onReview={() => journey.prepareReview()}
          onPage={(cursor, event) =>
            moveReader(
              event,
              'occurrences',
              snapshot.occurrencesWindow.revision,
              'recovery-occurrences-title',
              journey.loadOccurrences(cursor),
            )
          }
          onFirst={(event) =>
            moveReader(
              event,
              'occurrences',
              snapshot.occurrencesWindow.revision,
              'recovery-occurrences-title',
              journey.loadOccurrences(),
            )
          }
          onPrevious={(event) =>
            moveReader(
              event,
              'occurrences',
              snapshot.occurrencesWindow.revision,
              'recovery-occurrences-title',
              journey.previousOccurrences(),
            )
          }
          onCollections={() => touch(journey.loadCollections())}
        />
      ) : null}

      {snapshot.stage === 'review' && snapshot.selectedCollection ? (
        <div className="grid gap-4">
          <button
            type="button"
            className="min-h-11 justify-self-start rounded-md border px-4"
            disabled={snapshot.busy || locked}
            onClick={() => journey.editSelection()}
          >
            {m.library_archive_recovery_edit_selection()}
          </button>
          <ArchiveRecoveryReview
            collection={snapshot.selectedCollection}
            selected={snapshot.selected}
            targets={snapshot.targets}
            review={snapshot.review}
            busy={snapshot.busy || locked}
            onTarget={(sourceId, target) => journey.setTarget(sourceId, target)}
            onSubmit={() => touch(journey.reviewSelection())}
            onApply={() => touch(journey.apply())}
          />
        </div>
      ) : null}

      {snapshot.stage === 'conflict' ? (
        <ArchiveRecoveryConflict busy={snapshot.busy || locked} onRefresh={() => touch(journey.refreshConflict())} />
      ) : null}

      {snapshot.stage === 'results' && snapshot.status ? (
        <div className="grid gap-4">
          {snapshot.status.state === 'applying' ? (
            <button
              type="button"
              className="min-h-11 justify-self-start rounded-md border px-4"
              disabled={snapshot.busy || locked}
              onClick={() => touch(journey.continueApply())}
            >
              {m.library_archive_recovery_apply_next({ commands: RECOVERY_APPLY_COMMANDS })}
            </button>
          ) : null}
          <ArchiveRecoveryResults
            status={snapshot.status}
            page={snapshot.outcomesPage}
            receiving={snapshot.receiving}
            busy={snapshot.busy || locked || Boolean(snapshot.readRetry)}
            canPrevious={snapshot.outcomesWindow.canPrevious}
            onReadCollection={(cursor) => touch(journey.readReceivingCollection(cursor))}
            onRead={() => touch(journey.loadOutcomes())}
            onFirst={(event) =>
              moveReader(
                event,
                'outcomes',
                snapshot.outcomesWindow.revision,
                'recovery-results-title',
                journey.loadOutcomes(),
              )
            }
            onPrevious={(event) =>
              moveReader(
                event,
                'outcomes',
                snapshot.outcomesWindow.revision,
                'recovery-results-title',
                journey.previousOutcomes(),
              )
            }
            onNext={(cursor, event) =>
              moveReader(
                event,
                'outcomes',
                snapshot.outcomesWindow.revision,
                'recovery-results-title',
                journey.loadOutcomes(cursor),
              )
            }
          />
          <button
            type="button"
            className="min-h-11 justify-self-start rounded-md border px-4"
            disabled={snapshot.busy || locked}
            onClick={() => touch(journey.readStatus())}
          >
            {m.library_archive_recovery_read_status()}
          </button>
          {['complete', 'partial', 'cancelled'].includes(snapshot.status.state) ? (
            <button
              type="button"
              className="min-h-11 justify-self-start rounded-md border px-4"
              disabled={snapshot.busy || locked}
              onClick={() => journey.restart()}
            >
              {m.library_archive_recovery_restart()}
            </button>
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
            <button
              type="button"
              className="min-h-11 justify-self-start rounded-md border px-4"
              disabled={snapshot.busy}
              onClick={() => journey.restart()}
            >
              {m.library_archive_recovery_restart()}
            </button>
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
    </main>
  );
}
