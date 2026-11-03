import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useOperation } from '../../kernel/exposure';
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
  useOperation('collection.list');
  if (!current) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
        <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
        <p role="status">{m.library_archive_recovery_sign_in()}</p>
      </main>
    );
  }
  return <RecoverySession key={`${current.subject}:${current.csrfToken}`} visit={current} />;
}

function RecoverySession({ visit }: { visit: RecoveryVisit }) {
  const port = useArchiveCollectionRecoveryPort();
  const liveRegion = useRef<HTMLParagraphElement>(null);
  const journeyRef = useRef<ArchiveCollectionRecoveryJourney | null>(null);
  if (!journeyRef.current) {
    journeyRef.current = createArchiveCollectionRecoveryJourney({ port, visit });
  }
  const journey = journeyRef.current;
  const snapshot = useSyncExternalStore(journey.subscribe, journey.snapshot, journey.snapshot);
  const [focusVersion, setFocusVersion] = useState(0);
  const text = noticeText(snapshot.notice);
  const locked = snapshot.notice?.kind === 'unknown';
  const terminalStage = terminal(snapshot.stage);
  const returnLink = (
    <a className="min-h-11 inline-flex items-center underline" href={localizeHref('/library')}>
      {m.library_archive_recovery_return_library()}
    </a>
  );

  useEffect(() => () => journey.retire(), [journey, visit]);
  useEffect(() => {
    liveRegion.current?.focus();
  }, [snapshot.stage, snapshot.notice?.kind, focusVersion]);

  function touch(action: Promise<void>) {
    void action.then(() => setFocusVersion((value) => value + 1));
  }

  const heading = (
    <div className="grid gap-3">
      <PageHeading>{m.library_archive_recovery_title()}</PageHeading>
      <p>{m.library_archive_recovery_intro()}</p>
      <p className="rounded-lg border-l-4 border-primary p-3 text-sm">
        {m.library_archive_recovery_scope_notice()}
      </p>
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
              (['results', 'conflict', 'expired', 'denied', 'unavailable'].includes(snapshot.stage) && step === 'results');
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
                <span className={`inline-flex min-h-11 items-center rounded-full border px-3 ${current ? 'border-primary bg-primary/10 font-semibold' : ''}`}>
                  {index + 1}. {label}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      {text ? (
        <p ref={liveRegion} tabIndex={-1} role="status" aria-live="polite" className="rounded-md border p-3">
          {text}
        </p>
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
          onUpload={(archiveBase64) => journey.upload(archiveBase64)}
        />
      ) : null}

      {snapshot.stage === 'collections' && snapshot.collectionsPage ? (
        <ArchiveCollectionChooser
          page={snapshot.collectionsPage}
          busy={snapshot.busy || locked}
          onChoose={(collection) => touch(journey.chooseCollection(collection))}
          onFirst={() => touch(journey.loadCollections())}
          onNext={(cursor) => touch(journey.loadCollections(cursor))}
        />
      ) : null}

      {snapshot.stage === 'occurrences' && snapshot.occurrencesPage ? (
        <ArchiveOccurrenceChooser
          page={snapshot.occurrencesPage}
          selected={snapshot.selected}
          busy={snapshot.busy || locked}
          onToggle={(row) => journey.setSelection(toggleOccurrence(snapshot.selected, row))}
          onTogglePage={(rows) => journey.setSelection(togglePage(snapshot.selected, rows))}
          onReview={() => journey.prepareReview()}
          onPage={(cursor) => touch(journey.loadOccurrences(cursor))}
          onFirst={() => touch(journey.loadOccurrences())}
          onCollections={() => touch(journey.loadCollections())}
        />
      ) : null}

      {snapshot.stage === 'review' && snapshot.selectedCollection ? (
        <div className="grid gap-4">
          <button type="button" className="min-h-11 justify-self-start rounded-md border px-4" disabled={snapshot.busy || locked}
            onClick={() => journey.editSelection()}>
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
            <button type="button" className="min-h-11 justify-self-start rounded-md border px-4" disabled={snapshot.busy || locked}
              onClick={() => touch(journey.continueApply())}>
              {m.library_archive_recovery_apply_next({ commands: RECOVERY_APPLY_COMMANDS })}
            </button>
          ) : null}
          <ArchiveRecoveryResults
            status={snapshot.status}
            page={snapshot.outcomesPage}
            busy={snapshot.busy || locked}
            onRead={() => touch(journey.loadOutcomes())}
            onFirst={() => touch(journey.loadOutcomes())}
            onNext={(cursor) => touch(journey.loadOutcomes(cursor))}
          />
          <button type="button" className="min-h-11 justify-self-start rounded-md border px-4" disabled={snapshot.busy || locked}
            onClick={() => touch(journey.readStatus())}>
            {m.library_archive_recovery_read_status()}
          </button>
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
            <button type="button" className="min-h-11 justify-self-start rounded-md border px-4" disabled={snapshot.busy}
              onClick={() => journey.restart()}>
              {m.library_archive_recovery_restart()}
            </button>
          ) : null}
          {returnLink}
        </section>
      ) : null}

      {!terminalStage && snapshot.stage !== 'upload' ? returnLink : null}
      <ArchiveRecoveryDeparture
        active={Boolean(snapshot.uploadId) && !terminalStage && !(snapshot.status?.state === 'complete' || snapshot.status?.state === 'partial' || snapshot.status?.state === 'cancelled')}
        locked={locked}
        busy={snapshot.busy}
        canCancel={Boolean(snapshot.uploadId) && !['complete', 'partial', 'cancelled', 'expired'].includes(snapshot.status?.state ?? '')}
        onLeave={() => journey.retire()}
        onCancel={() => touch(journey.cancel())}
      />
    </main>
  );
}
