import { useRecoveryLifetime } from '../recovery-lifetime';
import { useLocation } from '@tanstack/react-router';
import { useEffect, useReducer, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale, localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import type { ProgressChoices } from '../progress-profile';
import { ArchiveRecoveryDeparture } from '../archive-collection-recovery/departure';
import { archiveFileFromCustody, bindArchiveCustodyOwner, completedArchiveFor } from '../private-export/custody';
import { ArchiveRecoveryDestinations } from '../private-export/destinations';
import { ProgressRecoveryJourney, type Snapshot } from './controller';
import { browserProgressRecoveryPort } from './port';
import { RecoveryReview, RecoveryResult, EvidenceDetails, progressModeLabel, progressStateLabel } from './review';

import { MappingPanel, Pager } from './mapping-panel';
import { ProgressWorkspace } from './progress-workspace';
import { NativeCheckbox } from '@rezics/ui/native-checkbox';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';

export { Pager };
export const action = 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]';
type Journey = ProgressRecoveryJourney<ProgressChoices>;
type View = Snapshot<ProgressChoices>;

export function ArchiveProgressRecoveryPage() {
  const location = useLocation();
  const scope = useRecoveryLifetime(location.pathname + location.searchStr, getLocale());
  const [, update] = useReducer((n) => n + 1, 0);
  const [owned, setJourney] = useState<{ scope: typeof scope; journey: Journey } | null>(null);
  const journey = owned?.scope === scope ? owned.journey : null;
  useEffect(() => {
    if (!scope.subject || !scope.csrfToken || !scope.current()) return;
    let active = true;
    let mounted: Journey | undefined;
    const current = () =>
      active && scope.current() && scope.address === window.location.pathname + window.location.search;
    const stop = scope.onRetire(() => mounted?.retire());
    void browserProgressRecoveryPort({ expectedReader: scope.subject, expectedCredential: scope.csrfToken }).then(
      (port) => {
        if (!current()) return;
        mounted = new ProgressRecoveryJourney(port, crypto.randomUUID(), current, update);
        setJourney({ scope, journey: mounted });
      },
    );
    return () => {
      active = false;
      stop();
      mounted?.retire();
    };
  }, [scope]);
  const snap = journey?.snapshot();
  if (!scope.current() || !journey || !snap)
    return (
      <main className="p-6">
        <p role="status">{m.library_archive_progress_preparing()}</p>
      </main>
    );
  return <RecoveryJourney key={scope.address + scope.csrfToken} journey={journey} snap={snap} owner={scope.subject} />;
}

export function RecoveryJourney({ journey, snap, owner }: { journey: Journey; snap: View; owner: string | null }) {
  if (owner) bindArchiveCustodyOwner(owner);
  const completed = owner ? completedArchiveFor(owner) : null;
  const [consent, setConsent] = useState('');
  const locked = snap.busy || snap.pending;
  useEffect(() => {
    if (!snap.upload || snap.notice === 'expired') return;
    const timer = setTimeout(() => journey.expire(), Math.max(0, Date.parse(snap.upload.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [journey, snap.upload, snap.notice === 'expired']);
  const notices = {
    ready: m.library_archive_progress_ready,
    uncertain: m.library_archive_progress_uncertain,
    recoverable: m.library_archive_progress_recoverable,
    refused: m.library_archive_progress_refused,
    expired: m.library_archive_progress_expired,
    oversize: m.library_archive_progress_oversize,
    cancelled: m.library_archive_progress_cancelled,
    removed: m.library_archive_progress_removed,
  };
  const retryable = snap.pending || snap.notice === 'uncertain' || snap.notice === 'recoverable';
  const intake = !snap.upload ? (
    <section className="min-w-0 space-y-4 rounded-lg border p-4" aria-label={m.library_archive_progress_file()}>
      {snap.refusal ? <EvidenceDetails value={{ status: snap.refusal }} /> : null}
      {retryable ? (
        <Button variant="outline" className={action} disabled={snap.busy} onClick={() => void journey.retry()}>
          {m.library_archive_progress_retry()}
        </Button>
      ) : null}
      <div className="space-y-3">
        <label className="block space-y-2">
          <span>{m.library_archive_progress_file()}</span>
          <Input
           
            type="file"
            accept="application/json,.json"
            disabled={locked}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void journey.upload(file);
            }}
          />
        </label>
        {snap.hasOriginalArchive ? (
          <Button variant="outline" className={action} disabled={locked} onClick={() => void journey.adoptOriginal()}>
            {m.library_archive_recovery_restart_original()}
          </Button>
        ) : completed ? (
          <Button
            variant="outline" className={action}
            disabled={locked}
            onClick={() => void journey.upload(archiveFileFromCustody(completed))}
          >
            {m.library_archive_use_completed_export()}
          </Button>
        ) : null}
        {completed || snap.hasOriginalArchive ? <p>{m.library_archive_completed_export_help()}</p> : null}
        {snap.cancelled || snap.notice === 'removed' ? (
          <Button variant="outline" className={action} disabled={locked} onClick={() => journey.restart()}>
            {m.library_archive_progress_restart()}
          </Button>
        ) : null}
      </div>
    </section>
  ) : null;
  const sourceContext = snap.upload ? (
    <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label={m.library_archive_recovery_coverage_title()}>
      <h2 className="text-xl font-semibold">{m.library_archive_recovery_coverage_title()}</h2>
      <p>{m.library_archive_progress_expiry({ at: snap.upload.expiresAt })}</p>
      <p>{m.library_archive_progress_holdings()}</p>
      {snap.holdings ? (
        <>
          <p>{m.library_archive_recovery_manifest_rows({ rows: snap.holdings.manifest.rows })}</p>
          <EvidenceDetails value={snap.holdings} />
          <Pager
            next={snap.holdings.next}
            disabled={locked}
            onFirst={() => void journey.page('holdings')}
            onNext={(after) => void journey.page('holdings', after)}
          />
        </>
      ) : null}
    </section>
  ) : null;
  const occurrenceBrowser = snap.upload ? (
    <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label={m.library_archive_progress_occurrences()}>
      <h2 className="text-xl font-semibold">{m.library_archive_progress_occurrences()}</h2>
      {!snap.occurrences ? (
        <Button variant="outline" className={action} disabled={locked} onClick={() => void journey.inspect()}>
          {m.library_archive_progress_inspect()}
        </Button>
      ) : (
        <>
          {!snap.occurrences.occurrences.length ? (
            <p>{m.library_archive_progress_empty()}</p>
          ) : (
            <ul className="min-w-0 space-y-3">
              {snap.occurrences.occurrences.map(({ ordinal, evidence }) => (
                <li className="min-w-0 rounded-md border p-3" key={ordinal}>
                  <p>
                    {m.library_archive_present_item({ number: ordinal + 1 })} · {progressStateLabel(evidence.state)}
                  </p>
                  <p>
                    {progressModeLabel(evidence.mode)} · {evidence.amount ?? m.library_progress_measure_absent()}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {m.library_archive_present_title_unavailable()} · {m.library_progress_unit_unspecified()}
                  </p>
                  <p className="text-sm">{m.library_archive_progress_unit_help({ count: evidence.completed_unit_count })}</p>
                  <EvidenceDetails value={{ ordinal, evidence }} />
                  <Button
                    variant="outline" className={action}
                    disabled={locked || snap.cancelled}
                    aria-pressed={snap.selected?.session_id === evidence.session_id}
                    onClick={() => {
                      setConsent('');
                      void journey.select(evidence);
                    }}
                  >
                    {m.library_archive_progress_select()}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Pager
            next={snap.occurrences.next}
            disabled={locked}
            onFirst={() => void journey.page('occurrences')}
            onNext={(after) => void journey.page('occurrences', after)}
          />
        </>
      )}
    </section>
  ) : null;
  const plan = snap.selected && !snap.cancelled ? (
    <div className="min-w-0 space-y-4">
      <MappingPanel key={snap.selected.session_id} journey={journey} snap={snap} />
      {snap.review ? <RecoveryReview review={snap.review} operands={snap.operands!} /> : null}
    </div>
  ) : null;
  const applyAction = snap.review?.applicable && !snap.application && !snap.cancelled ? (
    <div className="space-y-3 rounded-lg border p-4">
      <label className="flex items-center gap-3">
        <NativeCheckbox
         
          checked={consent === snap.review.reviewId}
          disabled={locked}
          onChange={(event) => setConsent(event.target.checked ? snap.review!.reviewId : '')}
        />
        {m.library_archive_progress_consent()}
      </label>
      <Button
        variant="outline" className={action}
        disabled={locked || consent !== snap.review.reviewId}
        onClick={() => {
          setConsent('');
          void journey.confirm(snap.review!.reviewId);
        }}
      >
        {m.library_archive_progress_confirm()}
      </Button>
    </div>
  ) : null;
  const operation = snap.upload && (snap.refusal || retryable || applyAction || snap.application || snap.result) ? (
    <section className="min-w-0 space-y-4" aria-label={m.library_archive_progress_result()}>
      {snap.refusal ? <EvidenceDetails value={{ status: snap.refusal }} /> : null}
      {retryable ? (
        <Button variant="outline" className={action} disabled={snap.busy} onClick={() => void journey.retry()}>
          {m.library_archive_progress_retry()}
        </Button>
      ) : null}
      {applyAction}
      <RecoveryResult application={snap.application} result={snap.result} pending={snap.pending} />
      {snap.application && !snap.pending ? (
        <Button variant="outline" className={action} disabled={locked} onClick={() => void journey.readResult()}>
          {m.library_archive_progress_readback()}
        </Button>
      ) : null}
    </section>
  ) : null;
  const restoredSession = snap.result?.progressSession?.id ? (
    <section
      className="min-w-0 rounded-lg border p-4"
      aria-label={m.library_archive_progress_open_session()}
    >
      <a className={buttonVariants({ variant: 'outline' })} href={localizeHref(`/library/progress/${snap.result.progressSession.id}`)}>
        {m.library_archive_progress_open_session()}
      </a>
    </section>
  ) : null;
  const archiveActions = snap.upload ? (
    <section
      className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border p-4"
      aria-label={m.library_archive_progress_remove()}
    >
      <Button variant="outline" className={action} disabled={locked} onClick={() => void journey.remove()}>
        {m.library_archive_progress_remove()}
      </Button>
      {snap.removed ? <p>{snap.removed}</p> : null}
      {snap.upload && !snap.cancelled ? (
        <Button variant="outline" className={action} onClick={() => void journey.cancel()}>
          {m.library_archive_recovery_confirm_cancel()}
        </Button>
      ) : null}
      {snap.cancelled || snap.notice === 'removed' ? (
        <Button variant="outline" className={action} disabled={locked} onClick={() => journey.restart()}>
          {m.library_archive_progress_restart()}
        </Button>
      ) : null}
    </section>
  ) : null;
  return (
    <main className="h-auto mx-auto w-full max-w-7xl space-y-6 px-4 py-6 [overflow-wrap:anywhere]">
      <PageHeading>{m.library_archive_progress_title()}</PageHeading>
      <p>{m.library_archive_progress_intro()}</p>
      <ArchiveRecoveryDestinations current="progress" />
      <p role="status" aria-live="polite">
        {notices[snap.notice]()}
      </p>
      {intake}
      {snap.upload ? (
        <ProgressWorkspace
          sourceContext={sourceContext}
          occurrenceBrowser={occurrenceBrowser}
          plan={plan}
          operation={operation}
          restoredSession={restoredSession}
          archiveActions={archiveActions}
        />
      ) : null}
      <ArchiveRecoveryDeparture
        active={!!snap.upload || snap.pending}
        locked={snap.pending}
        busy={false}
        canCancel={false}
        onCancel={() => void journey.cancel()}
        onLeave={() => journey.retire()}
      />
    </main>
  );
}
