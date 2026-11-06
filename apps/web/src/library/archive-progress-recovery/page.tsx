import { QueryClientContext } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useContext, useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { exposureQuery, sessionQuery } from '../../session/query';
import { m } from '../../paraglide/messages.js';
import { getLocale, localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { IndependentMeasuresReadout } from '../independent-measures/editor';
import { measureValueKind } from '../independent-measures/contract';
import { EpisodeChecklistEditor } from '../episode-checklist/editor';
import { preparingVisit } from '../episode-checklist/controller';
import type { ProgressChoices } from '../progress-profile';
import { ArchiveRecoveryDeparture } from '../archive-collection-recovery/departure';
import { archiveFileFromCustody, bindArchiveCustodyOwner, completedArchiveFor } from '../private-export/custody';
import { ArchiveRecoveryDestinations } from '../private-export/destinations';
import { ProgressRecoveryJourney, type Snapshot } from './controller';
import { browserProgressRecoveryPort } from './port';
import type { ReviewInput } from './native';
import { RecoveryReview, RecoveryResult, Evidence } from './review';

export const action =
  'min-h-11 min-w-11 max-w-full rounded-md border px-3 py-2 whitespace-normal [overflow-wrap:anywhere] disabled:opacity-50';
type Journey = ProgressRecoveryJourney<ProgressChoices>;
type View = Snapshot<ProgressChoices>;
const uuid = '[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';

export function ArchiveProgressRecoveryPage() {
  const client = useContext(QueryClientContext);
  const location = useLocation();
  const routeAddress = location.pathname + location.searchStr;
  const [, update] = useReducer((n) => n + 1, 0);
  const [journey, setJourney] = useState<Journey | null>(null);
  const identity = () =>
    JSON.stringify([
      client?.getQueryData(sessionQuery.queryKey),
      client?.getQueryData(exposureQuery.queryKey),
      getLocale(),
    ]);
  const binding = useSyncExternalStore(
    (listener) => client?.getQueryCache().subscribe(listener) ?? (() => {}),
    identity,
    () => '',
  );
  useEffect(() => {
    const session = client?.getQueryData<{ state: string; subject?: string; csrfToken?: string }>(
      sessionQuery.queryKey,
    );
    if (session?.state !== 'signed-in' || !session.subject || !session.csrfToken) return;
    let active = true,
      mounted: Journey | undefined;
    const address = window.location.pathname + window.location.search;
    const current = () =>
      active && binding === identity() && address === window.location.pathname + window.location.search;
    void browserProgressRecoveryPort({ expectedReader: session.subject, expectedCredential: session.csrfToken }).then(
      (port) => {
        if (!current()) return;
        mounted = new ProgressRecoveryJourney(port, JSON.stringify([binding, address]), current, update);
        setJourney(mounted);
      },
    );
    return () => {
      active = false;
      mounted?.retire();
    };
  }, [client, binding, routeAddress]);
  const snap = journey?.snapshot();
  if (!journey || !snap)
    return (
      <main className="p-6">
        <p role="status">{m.library_archive_progress_preparing()}</p>
      </main>
    );
  return <RecoveryJourney key={binding + routeAddress} journey={journey} snap={snap} />;
}

function RecoveryJourney({ journey, snap }: { journey: Journey; snap: View }) {
  const client = useContext(QueryClientContext);
  const session = client?.getQueryData<{ subject?: string }>(sessionQuery.queryKey);
  const owner = session?.subject;
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
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 [overflow-wrap:anywhere]">
      <PageHeading>{m.library_archive_progress_title()}</PageHeading>
      <p>{m.library_archive_progress_intro()}</p>
      <ArchiveRecoveryDestinations current="progress" />
      <p role="status" aria-live="polite">
        {notices[snap.notice]()}
        {snap.refusal ? ` (${snap.refusal})` : ''}
      </p>
      {snap.pending || snap.notice === 'uncertain' || snap.notice === 'recoverable' ? (
        <button className={action} disabled={snap.busy} onClick={() => void journey.retry()}>
          {m.library_archive_progress_retry()}
        </button>
      ) : null}
      {!snap.upload ? (
        <div className="space-y-3">
          <label className="block space-y-2">
            <span>{m.library_archive_progress_file()}</span>
            <input
              className={action}
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
            <button className={action} disabled={locked} onClick={() => void journey.adoptOriginal()}>
              {m.library_archive_recovery_restart_original()}
            </button>
          ) : completed ? (
            <button
              className={action}
              disabled={locked}
              onClick={() => void journey.upload(archiveFileFromCustody(completed))}
            >
              {m.library_archive_use_completed_export()}
            </button>
          ) : null}
          {completed || snap.hasOriginalArchive ? <p>{m.library_archive_completed_export_help()}</p> : null}
        </div>
      ) : (
        <>
          <p>{m.library_archive_progress_expiry({ at: snap.upload.expiresAt })}</p>
          <details>
            <summary className={action}>{m.library_archive_recovery_coverage_title()}</summary>
            <Evidence
              value={snap.holdings ? { manifest: snap.holdings.manifest, coverage: snap.holdings.coverage } : null}
            />
            <p>{m.library_archive_progress_holdings()}</p>
            <Evidence value={snap.holdings} />
            <Pager
              next={snap.holdings?.next}
              disabled={locked}
              onFirst={() => void journey.page('holdings')}
              onNext={(after) => void journey.page('holdings', after)}
            />
          </details>
          {!snap.occurrences ? (
            <button className={action} disabled={locked} onClick={() => void journey.inspect()}>
              {m.library_archive_progress_inspect()}
            </button>
          ) : (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold">{m.library_archive_progress_occurrences()}</h2>
              {!snap.occurrences.occurrences.length ? (
                <p>{m.library_archive_progress_empty()}</p>
              ) : (
                <ul className="space-y-3">
                  {snap.occurrences.occurrences.map(({ ordinal, evidence }) => (
                    <li className="rounded-md border p-3" key={evidence.session_id}>
                      <p>
                        {evidence.subject_id} · {evidence.state} ·{' '}
                        {evidence.amount ?? m.library_progress_measure_absent()} {evidence.unit}
                      </p>
                      <p className="text-sm">
                        {ordinal + 1} · {evidence.session_id}
                      </p>
                      <button
                        className={action}
                        disabled={locked || snap.cancelled}
                        aria-pressed={snap.selected?.session_id === evidence.session_id}
                        onClick={() => {
                          setConsent('');
                          void journey.select(evidence);
                        }}
                      >
                        {m.library_archive_progress_select()}
                      </button>
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
            </section>
          )}
          {snap.selected && !snap.cancelled ? (
            <Mapping key={snap.selected.session_id} journey={journey} snap={snap} />
          ) : null}
          {snap.review ? <RecoveryReview review={snap.review} operands={snap.operands!} /> : null}
          {snap.review?.applicable && !snap.application && !snap.cancelled ? (
            <div className="space-y-3">
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={consent === snap.review.reviewId}
                  disabled={locked}
                  onChange={(event) => setConsent(event.target.checked ? snap.review!.reviewId : '')}
                />
                {m.library_archive_progress_consent()}
              </label>
              <button
                className={action}
                disabled={locked || consent !== snap.review.reviewId}
                onClick={() => {
                  setConsent('');
                  void journey.confirm(snap.review!.reviewId);
                }}
              >
                {m.library_archive_progress_confirm()}
              </button>
            </div>
          ) : null}
          <RecoveryResult application={snap.application} result={snap.result} pending={snap.pending} />
          {snap.application && !snap.pending ? (
            <button className={action} disabled={locked} onClick={() => void journey.readResult()}>
              {m.library_archive_progress_readback()}
            </button>
          ) : null}
          {snap.result?.progressSession?.id ? (
            <a className={action} href={localizeHref(`/library/progress/${snap.result.progressSession.id}`)}>
              {m.library_archive_progress_open_session()}
            </a>
          ) : null}
          <button className={action} disabled={locked} onClick={() => void journey.remove()}>
            {m.library_archive_progress_remove()}
          </button>
          {snap.removed ? <p>{snap.removed}</p> : null}
        </>
      )}
      {snap.upload && !snap.cancelled ? (
        <button className={action} onClick={() => void journey.cancel()}>
          {m.library_archive_recovery_confirm_cancel()}
        </button>
      ) : null}
      {snap.cancelled || snap.notice === 'removed' ? (
        <button className={action} disabled={locked} onClick={() => journey.restart()}>
          {m.library_archive_progress_restart()}
        </button>
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

export function Pager({
  next,
  disabled,
  onFirst,
  onNext,
}: {
  next: number | null | undefined;
  disabled: boolean;
  onFirst: () => void;
  onNext: (after: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <button className={action} disabled={disabled} onClick={onFirst}>
        {m.buyer_history_first()}
      </button>
      {next !== null && next !== undefined ? (
        <button className={action} disabled={disabled} onClick={() => onNext(next)}>
          {m.buyer_history_next()}
        </button>
      ) : null}
    </div>
  );
}

function Mapping({ journey, snap }: { journey: Journey; snap: View }) {
  const source = snap.selected!;
  const [subject, setSubject] = useState('');
  const [pair, setPair] = useState('');
  const [additional, setAdditional] = useState<Record<string, string>>({});
  const [ids, setIds] = useState<string[]>([]);
  const locked = snap.busy || snap.pending;
  const pairs = snap.choices?.flatMap((choice) => choice.units.map((unit) => ({ mode: choice.mode, ...unit }))) ?? [];
  const choice = pairs.find((item) => `${item.mode}:${item.id}` === pair);
  const body: ReviewInput | null =
    choice && snap.mappedSubject
      ? {
          sessionId: source.session_id,
          subjectId: snap.mappedSubject,
          mode: choice.mode,
          unit: choice.id,
          additionalMeasures:
            choice.mode === 'scalar_amount'
              ? Object.entries(additional)
                  .filter(([, unit]) => unit)
                  .map(([sourceUnit, unit]) => ({ sourceUnit, unit }))
              : [],
          unitIds: choice.mode === 'completed_units' ? ids : [],
        }
      : null;
  const visit = preparingVisit(null);
  visit.kind = 'ready';
  visit.membership = 'admitted';
  visit.rows = (snap.units?.units ?? []).map(({ evidence }) => {
    const admission = snap.unitSupport.find((unit) => unit.unitId === evidence.unit_id)?.admission;
    return {
      episodeSubjectId: evidence.unit_id,
      completed: false,
      membership: admission ?? 'unavailable',
      ordinal: null,
      label: evidence.unit_id,
      source: 'inspect',
    };
  });
  visit.selection = { add: ids, remove: [] };
  const changed = () => journey.invalidateReview();
  const measures = [
    { unit: source.unit, amount: source.amount, total: source.total },
    ...(source.additional_measures ?? []),
  ];
  return (
    <section className="space-y-4 rounded-md border p-4">
      <h2 className="text-xl font-semibold">{m.library_archive_progress_mapping()}</h2>
      <details>
        <summary className={action}>{m.library_archive_progress_source()}</summary>
        <Evidence value={source} />
      </details>
      <IndependentMeasuresReadout
        revision={source.revision}
        measures={measures.map((item, index) => ({
          ...item,
          primary: index === 0,
          label: item.unit,
          kind: measureValueKind(item.amount),
          meaning: 'unknown',
          recording: 'historical',
        }))}
      />
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPair('');
          setAdditional({});
          setIds([]);
          void journey.mapSubject(subject);
        }}
      >
        <label className="block space-y-2">
          <span>{m.library_archive_progress_subject()}</span>
          <input
            className={`${action} w-full`}
            required
            pattern={uuid}
            value={subject}
            disabled={locked}
            onChange={(event) => {
              setSubject(event.target.value);
              changed();
            }}
          />
        </label>
        <button className={action} disabled={locked}>
          {m.library_archive_progress_profile()}
        </button>
      </form>
      {snap.mappedSubject ? (
        <>
          <p>{snap.mappedSubject}</p>
          {!pairs.length ? (
            <p>{m.library_archive_progress_unsupported()}</p>
          ) : (
            <label className="block space-y-2">
              <span>{m.library_archive_progress_pair()}</span>
              <select
                className={`${action} w-full`}
                value={pair}
                disabled={locked}
                onChange={(event) => {
                  setPair(event.target.value);
                  setAdditional({});
                  setIds([]);
                  changed();
                }}
              >
                <option value="">{m.library_archive_progress_choose()}</option>
                {pairs.map((item) => (
                  <option key={`${item.mode}:${item.id}`} value={`${item.mode}:${item.id}`}>
                    {item.mode} · {item.label || item.id}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      ) : null}
      {choice?.mode === 'scalar_amount'
        ? (source.additional_measures ?? []).map((measure) => (
            <label className="block space-y-2" key={measure.unit}>
              <span>
                {measure.unit} · {measure.amount ?? m.library_progress_measure_absent()} /{' '}
                {measure.total ?? m.library_progress_measure_absent()}
              </span>
              <select
                className={`${action} w-full`}
                disabled={locked}
                value={additional[measure.unit] ?? ''}
                onChange={(event) => {
                  setAdditional({ ...additional, [measure.unit]: event.target.value });
                  changed();
                }}
              >
                <option value="">{m.library_archive_progress_omit()}</option>
                {pairs
                  .filter(
                    (item) =>
                      item.mode === 'scalar_amount' &&
                      item.id !== choice.id &&
                      !Object.entries(additional).some(
                        ([sourceUnit, unit]) => sourceUnit !== measure.unit && unit === item.id,
                      ),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label || item.id}
                    </option>
                  ))}
              </select>
            </label>
          ))
        : null}
      <details open={choice?.mode === 'completed_units'}>
        <summary className={action}>{m.library_archive_progress_units()}</summary>
        <p>{m.library_archive_progress_unit_help({ count: source.completed_unit_count })}</p>
        <Evidence value={snap.units} />
        {choice?.mode === 'completed_units' && body ? (
          <>
            <button
              className={action}
              disabled={locked}
              onClick={() =>
                void journey.review(
                  { ...body, unitIds: snap.units!.units.map(({ evidence }) => evidence.unit_id) },
                  true,
                )
              }
            >
              {m.library_archive_progress_membership()}
            </button>
            <EpisodeChecklistEditor
              visit={visit}
              busy={locked}
              onToggle={(id) => {
                if (ids.includes(id)) setIds(ids.filter((value) => value !== id));
                else if (ids.length < 20) setIds([...ids, id]);
                changed();
              }}
              onClear={() => {
                setIds([]);
                changed();
              }}
              onReview={() => body && void journey.review(body)}
            />
            <p>{m.library_archive_progress_selected({ count: ids.length })}</p>
          </>
        ) : null}
        <Pager
          next={snap.units?.next}
          disabled={locked}
          onFirst={() => void journey.page('units')}
          onNext={(after) => void journey.page('units', after)}
        />
      </details>
      <button className={action} disabled={locked || !body} onClick={() => body && void journey.review(body)}>
        {m.library_archive_progress_review()}
      </button>
    </section>
  );
}
