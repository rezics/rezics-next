import { useLocation } from '@tanstack/react-router';
import { useRecoveryLifetime } from '../recovery-lifetime';
import { useEffect, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale, localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { ArchiveEntryRecoveryJourney, supportedRecoverySection } from './controller';
import { type ArchiveReviewItem, type ArchiveRow } from './native';
import { browserArchiveRecoveryPort } from './port';
import { type RecoveryBinding } from './visit';
import { archiveFileFromCustody, bindArchiveCustodyOwner, completedArchiveFor } from '../private-export/custody';
import { ArchiveRecoveryDestinations } from '../private-export/destinations';

const control = 'min-h-11 min-w-11 rounded-md border px-3 py-2 disabled:opacity-50';
const uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const json = (value: unknown) => (
  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm [overflow-wrap:anywhere]">
    {JSON.stringify(value, null, 2)}
  </pre>
);

/** Every callback consults the current query cache and address, including before React effects run. */
export function ArchiveEntryRecoveryPage() {
  const location = useLocation();
  const scope = useRecoveryLifetime(location.pathname + location.searchStr, getLocale());
  const [owned, setJourney] = useState<{ scope: typeof scope; journey: ArchiveEntryRecoveryJourney } | null>(null);
  const journey = owned?.scope === scope ? owned.journey : null;
  useEffect(() => {
    if (!scope.subject || !scope.csrfToken || !scope.current()) return;
    let active = true;
    let mounted: ArchiveEntryRecoveryJourney | undefined;
    const binding: RecoveryBinding = {
      viewer: scope.subject,
      credentialEpoch: scope.csrfToken,
      csrfEpoch: scope.csrfToken,
      admission: crypto.randomUUID(),
      source: 'native-archive-upload',
      route: scope.address,
      locale: scope.locale,
      exposure: crypto.randomUUID(),
    };
    const current = () =>
      active && scope.current() && scope.address === window.location.pathname + window.location.search ? binding : null;
    const stop = scope.onRetire(() => mounted?.retire());
    void browserArchiveRecoveryPort({ expectedReader: scope.subject, expectedCredential: scope.csrfToken }).then(
      (port) => {
        if (!current()) return;
        mounted = new ArchiveEntryRecoveryJourney(port, current, Date.now() + 7 * 86_400_000);
        setJourney({ scope, journey: mounted });
      },
    );
    return () => {
      active = false;
      stop();
      mounted?.retire();
    };
  }, [scope]);
  return <ArchiveEntryRecoveryView journey={scope.current() ? journey : null} />;
}

export function ArchiveEntryRecoveryView({ journey }: { journey: ArchiveEntryRecoveryJourney | null }) {
  const [, render] = useState(0);
  const [confirmation, setConfirmation] = useState<unknown>(null);
  useEffect(() => journey?.subscribe(() => render((value) => value + 1)), [journey]);
  const snapshot = journey?.snapshot();
  const state = snapshot?.state;
  const review = state?.review;
  const confirmed = !!review && confirmation === review;
  const phase = state?.phase ?? 'idle';
  const locked = ['applying', 'uncertain', 'recoverable', 'cancelling'].includes(phase);
  const terminal = ['cancelled', 'expired'].includes(phase);
  const busy = snapshot?.busy ?? false;
  const previewBusy = busy || phase === 'cancelling';
  const uploadLocked = busy || locked || snapshot?.uploadUncertain;
  const hasUpload = !!state?.upload;
  const live = state !== null && journey !== null;
  const owner = journey?.visit.viewer ?? null;
  if (owner) bindArchiveCustodyOwner(owner);
  const completed = owner ? completedArchiveFor(owner) : null;
  const act = (action: Promise<void>) => {
    void action;
  };

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 [overflow-wrap:anywhere]">
      <header className="space-y-3">
        <PageHeading>{m.library_archive_title()}</PageHeading>
        <p>{m.library_archive_intro()}</p>
        <ArchiveRecoveryDestinations current="entries" />
      </header>
      <ol aria-label={m.library_archive_steps()} className="flex flex-wrap gap-4 text-sm">
        <li aria-current={!hasUpload ? 'step' : undefined}>1. {m.library_archive_upload_step()}</li>
        <li aria-current={hasUpload && !state?.results ? 'step' : undefined}>2. {m.library_archive_review_step()}</li>
        <li aria-current={state?.results ? 'step' : undefined}>3. {m.library_archive_results_step()}</li>
      </ol>
      <p role="status" aria-live="polite">
        {snapshot?.notice
          ? notice(snapshot.notice)
          : terminal
            ? phase
            : !live
              ? m.library_archive_entry_preparing()
              : busy
                ? m.library_archive_entry_working()
                : ''}
      </p>
      <section aria-labelledby="archive-upload" className="space-y-3 rounded-lg border p-4">
        <h2 id="archive-upload" className="text-xl font-semibold">
          {m.library_archive_upload_step()}
        </h2>
        <p id="archive-file-help">{m.library_archive_entry_upload_help()}</p>
        <label htmlFor="archive-file" className="block font-medium">
          {m.library_archive_choose_file()}
        </label>
        <input
          id="archive-file"
          type="file"
          accept="application/json,.json"
          disabled={!live || uploadLocked}
          aria-describedby="archive-file-help"
          className={`${control} block w-full max-w-full`}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) act(journey!.upload(file));
          }}
        />
        {snapshot?.uploadUncertain && (
          <button type="button" className={control} disabled={busy} onClick={() => act(journey!.retryUpload())}>
            {m.library_archive_recovery_retry_original()}
          </button>
        )}
        {!hasUpload && snapshot?.hasOriginalArchive ? (
          <button
            type="button"
            className={control}
            disabled={!live || uploadLocked}
            onClick={() => act(journey!.adoptOriginal())}
          >
            {m.library_archive_recovery_restart_original()}
          </button>
        ) : null}
        {!hasUpload && completed && !snapshot?.hasOriginalArchive ? (
          <button
            type="button"
            className={control}
            disabled={!live || uploadLocked}
            onClick={() => act(journey!.upload(archiveFileFromCustody(completed)))}
          >
            {m.library_archive_use_completed_export()}
          </button>
        ) : null}
        {completed || snapshot?.hasOriginalArchive ? <p>{m.library_archive_completed_export_help()}</p> : null}
      </section>
      <section aria-labelledby="archive-scope" className="space-y-3">
        <h2 id="archive-scope" className="text-xl font-semibold">
          {m.library_archive_scope_title()}
        </h2>
        <p>{m.library_archive_entry_scope()}</p>
        <p>{m.library_archive_personal_help()}</p>
        <p>{m.library_archive_deliberate()}</p>
        <p>{m.library_archive_history()}</p>
      </section>
      {(hasUpload || state?.results) && (
        <>
          {hasUpload && (
            <section aria-labelledby="archive-inventory" className="space-y-3">
              <h2 id="archive-inventory" className="text-xl font-semibold">
                {m.library_archive_entry_inventory()}
              </h2>
              <p>
                {m.library_archive_entry_counts({
                  rows: state.upload!.metadata.rows,
                  bytes: state.upload!.metadata.recordBytes,
                })}
              </p>
              <p>{m.library_archive_entry_count_help()}</p>
              <p>{m.library_archive_entry_expiry({ date: state.upload!.metadata.expiresAt })}</p>
              <dl className="grid gap-2 sm:grid-cols-2">
                {state.upload!.metadata.coverage.map((item) => (
                  <div key={item.section} className="rounded border p-3">
                    <dt className="font-semibold">{item.section}</dt>
                    <dd>
                      {item.rows} · {item.capture} ·{' '}
                      {supportedRecoverySection(item.section) ? item.treatment : m.library_archive_entry_retained()}
                    </dd>
                  </div>
                ))}
              </dl>
              <button type="button" className={control} disabled={busy} onClick={() => act(journey!.status())}>
                {m.library_archive_entry_status()}
              </button>
            </section>
          )}
          {!terminal && (
            <section aria-labelledby="archive-rows" className="space-y-4">
              <h2 id="archive-rows" className="text-xl font-semibold">
                {m.library_archive_entry_records()}
              </h2>
              <p>{m.library_archive_entry_mapping_help()}</p>
              {state.page?.rows.length === 0 && <p>{m.library_archive_entry_empty()}</p>}
              {state.page?.rows.map((row) => (
                <article key={row.ordinal} className="space-y-3 rounded-lg border p-4">
                  <h3 className="font-semibold">
                    #{row.ordinal} · {row.section} · {row.status}
                  </h3>
                  <details>
                    <summary className={control}>{m.library_archive_entry_evidence()}</summary>
                    {json(row.evidence)}
                  </details>
                  {row.review !== null && (
                    <>
                      <p>{m.library_archive_entry_revision({ ordinal: row.ordinal, revision: row.reviewRevision })}</p>
                      {json(row.review)}
                    </>
                  )}
                  {supportedRecoverySection(row.section) &&
                  !['unsupported', 'applying', 'acknowledged'].includes(row.status) ? (
                    row.section === 'annotations' ? (
                      <AnnotationMappingForm
                        key={`${row.ordinal}:${state.upload!.id}`}
                        row={row}
                        disabled={
                          busy ||
                          locked ||
                          (state.choices.length >= 20 && !state.choices.some((c) => c.ordinal === row.ordinal))
                        }
                        onChoose={(choice) => journey!.choose(choice)}
                      />
                    ) : row.section === 'journals' ? (
                      <JournalMappingForm
                        key={`${row.ordinal}:${state.upload!.id}`}
                        row={row}
                        disabled={
                          busy ||
                          locked ||
                          (state.choices.length >= 20 && !state.choices.some((c) => c.ordinal === row.ordinal))
                        }
                        onChoose={(choice) => journey!.choose(choice)}
                      />
                    ) : row.section === 'provenance' ? (
                      <ObservationMappingForm
                        key={`${row.ordinal}:${state.upload!.id}`}
                        row={row}
                        disabled={
                          busy ||
                          locked ||
                          (state.choices.length >= 20 && !state.choices.some((c) => c.ordinal === row.ordinal))
                        }
                        onChoose={(choice) => journey!.choose(choice)}
                      />
                    ) : (
                      <MappingForm
                        key={`${row.ordinal}:${state.upload!.id}`}
                        row={row}
                        disabled={
                          busy ||
                          locked ||
                          (state.choices.length >= 20 &&
                            !state.choices.some((choice) => choice.ordinal === row.ordinal))
                        }
                        onChoose={(choice) => journey!.choose(choice)}
                      />
                    )
                  ) : (
                    <p>
                      {row.section === 'provenance'
                        ? m.library_archive_personal_observation_evidence()
                        : m.library_archive_entry_retained()}
                    </p>
                  )}
                </article>
              ))}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className={control}
                  disabled={previewBusy || state.pageNavigation.previous.length === 0}
                  onClick={() => act(journey!.page('previous'))}
                >
                  {m.library_window_previous()}
                </button>
                <button
                  type="button"
                  className={control}
                  disabled={previewBusy}
                  onClick={() => act(journey!.page('first'))}
                >
                  {m.library_archive_entry_first()}
                </button>
                <button
                  type="button"
                  className={control}
                  disabled={previewBusy || state.page?.context.next == null}
                  onClick={() => act(journey!.page('next'))}
                >
                  {m.library_archive_entry_next()}
                </button>
                <button
                  type="button"
                  className={control}
                  disabled={previewBusy || state.pageNavigation.current === null}
                  onClick={() => act(journey!.page('refresh'))}
                >
                  {m.library_archive_entry_results_refresh()}
                </button>
                {state.pageNavigation.staged?.failed && (
                  <button
                    type="button"
                    className={control}
                    disabled={previewBusy}
                    onClick={() => act(journey!.page('retry'))}
                  >
                    {m.library_window_retry()}
                  </button>
                )}
              </div>
            </section>
          )}
          {!terminal && (
            <section aria-labelledby="archive-selected" className="space-y-3">
              <h2 id="archive-selected" className="text-xl font-semibold">
                {m.library_archive_entry_selected({ count: state.choices.length })}
              </h2>
              <p>{m.library_archive_entry_assignment_help()}</p>
              {state.choices.map((choice) => (
                <div key={choice.ordinal} className="space-y-2 rounded border p-3">
                  {json(choice.choice)}
                  <button
                    type="button"
                    className={control}
                    disabled={busy || locked}
                    onClick={() => journey!.unselect(choice.ordinal)}
                  >
                    {m.library_archive_entry_unselect({ ordinal: choice.ordinal })}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={control}
                disabled={busy || locked || state.choices.length === 0}
                onClick={() => act(journey!.review())}
              >
                {m.library_archive_entry_review()}
              </button>
              {review && (
                <div className="space-y-3 rounded border p-4">
                  {snapshot!.reviewed.map((item) => (
                    <p key={item.ordinal}>
                      {m.library_archive_entry_revision({ ordinal: item.ordinal, revision: item.reviewRevision })} ·{' '}
                      {item.status}
                    </p>
                  ))}
                  {json(review.body)}
                  <label className="flex min-h-11 items-center gap-3">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy || locked}
                      onChange={(event) => setConfirmation(event.currentTarget.checked ? review : null)}
                    />
                    {m.library_archive_entry_confirm()}
                  </label>
                  <button
                    type="button"
                    className={control}
                    disabled={busy || locked || !confirmed}
                    onClick={() => {
                      setConfirmation(null);
                      act(journey!.apply());
                    }}
                  >
                    {m.library_archive_entry_apply()}
                  </button>
                </div>
              )}
              {locked && (
                <>
                  <p>{m.library_archive_recovery_uncertain()}</p>
                  {snapshot?.retryOriginal && (
                    <button type="button" className={control} disabled={busy} onClick={() => act(journey!.apply())}>
                      {m.library_archive_recovery_retry_original()}
                    </button>
                  )}
                  {!state.results && (
                    <button
                      type="button"
                      className={control}
                      disabled={busy}
                      onClick={() => act(journey!.results('refresh'))}
                    >
                      {m.library_archive_entry_results_refresh()}
                    </button>
                  )}
                </>
              )}
            </section>
          )}
          {state.results && (
            <section aria-labelledby="archive-results" className="space-y-3">
              <h2 id="archive-results" className="text-xl font-semibold">
                {m.library_archive_results_step()}
              </h2>
              <p>{m.library_archive_entry_result_help()}</p>
              {state.results.rows.map((row) => (
                <div key={row.ordinal} className="space-y-2 rounded border p-3">
                  <p>
                    #{row.ordinal} · {row.section} · {row.status}
                  </p>
                  {row.subjectId && (
                    <>
                      <a
                        className={`${control} inline-flex items-center underline`}
                        href={localizeHref(`/subjects/${row.subjectId}`)}
                      >
                        {m.library_archive_entry_subject()}
                      </a>
                      <a className={`${control} inline-flex items-center underline`} href={localizeHref('/library')}>
                        {m.library_archive_entry_open_library()}
                      </a>
                    </>
                  )}
                  {row.sessionId ? (
                    <a
                      className={`${control} inline-flex items-center underline`}
                      href={localizeHref(`/library/progress/${row.sessionId}`)}
                    >
                      {m.library_archive_progress_open_session()}
                    </a>
                  ) : null}
                  {(row.subjectId || row.labelId) && (
                    <button
                      type="button"
                      className={control}
                      disabled={busy || phase === 'expired'}
                      onClick={() => act(journey!.readCurrent(row.ordinal))}
                    >
                      {m.library_archive_entry_read_current()}
                    </button>
                  )}
                </div>
              ))}
              {snapshot?.readback && (
                <div>
                  <h3>{m.library_archive_entry_current()}</h3>
                  {json(snapshot.readback.value)}
                </div>
              )}
              {phase !== 'expired' && (
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={control}
                    disabled={busy || state.resultsNavigation.previous.length === 0}
                    onClick={() => act(journey!.results('previous'))}
                  >
                    {m.library_window_previous()}
                  </button>
                  <button
                    type="button"
                    className={control}
                    disabled={busy}
                    onClick={() => act(journey!.results('first'))}
                  >
                    {m.library_archive_entry_first()}
                  </button>
                  <button
                    type="button"
                    className={control}
                    disabled={busy || state.results.context.next == null}
                    onClick={() => act(journey!.results('next'))}
                  >
                    {m.library_archive_entry_next()}
                  </button>
                  <button
                    type="button"
                    className={control}
                    disabled={busy || state.resultsNavigation.current === null}
                    onClick={() => act(journey!.results('refresh'))}
                  >
                    {m.library_archive_entry_results_refresh()}
                  </button>
                  {state.resultsNavigation.staged?.failed && (
                    <button
                      type="button"
                      className={control}
                      disabled={busy}
                      onClick={() => act(journey!.results('retry'))}
                    >
                      {m.library_window_retry()}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}
          {!terminal && (
            <button
              type="button"
              className={control}
              disabled={phase === 'cancelling' && busy}
              onClick={() => act(journey!.cancel())}
            >
              {m.library_archive_entry_cancel()}
            </button>
          )}
        </>
      )}
      {phase === 'expired' && (
        <>
          <p>{m.library_archive_entry_expired()}</p>
          <button type="button" className={control} disabled={busy} onClick={() => act(journey!.prune())}>
            {m.library_archive_entry_prune()}
          </button>
        </>
      )}
      {(phase === 'complete' || phase === 'cancelled' || phase === 'expired') && live ? (
        <button type="button" className={control} disabled={busy || locked} onClick={() => journey!.restart()}>
          {m.library_archive_recovery_restart()}
        </button>
      ) : null}
      <nav aria-label={m.library_archive_destinations()} className="flex flex-wrap gap-3">
        <a href={localizeHref('/library')} className={`${control} inline-flex items-center underline`}>
          {m.library_archive_return()}
        </a>
      </nav>
    </main>
  );
}

function notice(value: string) {
  if (value === 'uncertain') return m.library_archive_recovery_uncertain();
  if (value === 'file_too_large') return m.library_archive_recovery_upload_too_large();
  return m.library_archive_entry_native_status({ status: value });
}

function MappingForm({
  row,
  disabled,
  onChoose,
}: {
  row: ArchiveRow;
  disabled: boolean;
  onChoose: (choice: ArchiveReviewItem) => void;
}) {
  const [action, setAction] = useState('preserve');
  const [mode, setMode] = useState('existing');
  const prefix = `archive-map-${row.ordinal}`;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const subjectId = String(values.get('subjectId'));
        if (row.section === 'entries')
          onChoose(
            action === 'preserve'
              ? { ordinal: row.ordinal, kind: 'entry', subjectId, action: 'preserve' }
              : {
                  ordinal: row.ordinal,
                  kind: 'entry',
                  subjectId,
                  action: action as 'create' | 'update',
                  stateId: String(values.get('stateId')),
                },
          );
        else if (row.section === 'labels')
          onChoose({
            ordinal: row.ordinal,
            kind: 'label',
            target:
              mode === 'create' ? { mode: 'create' } : { mode: 'existing', labelId: String(values.get('labelId')) },
          });
        else
          onChoose({
            ordinal: row.ordinal,
            kind: 'assignment',
            subjectId,
            action: action === 'assign' ? 'assign' : 'preserve',
          });
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        {row.section !== 'labels' && (
          <>
            <label htmlFor={`${prefix}-subject`}>{m.library_archive_entry_subject_id()}</label>
            <input
              id={`${prefix}-subject`}
              className={`${control} block w-full`}
              name="subjectId"
              required
              pattern={uuidPattern}
              autoComplete="off"
            />
          </>
        )}
        {row.section === 'labels' ? (
          <>
            <label htmlFor={`${prefix}-mode`}>{m.library_archive_entry_label_choice()}</label>
            <select
              id={`${prefix}-mode`}
              className={`${control} block w-full`}
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value)}
            >
              <option value="existing">{m.library_archive_entry_existing_label()}</option>
              <option value="create">{m.library_archive_entry_create_label()}</option>
            </select>
            {mode === 'existing' && (
              <>
                <label htmlFor={`${prefix}-label`}>{m.library_archive_entry_label_id()}</label>
                <input
                  id={`${prefix}-label`}
                  className={`${control} block w-full`}
                  name="labelId"
                  pattern={uuidPattern}
                  required
                  autoComplete="off"
                />
              </>
            )}
          </>
        ) : (
          <>
            <label htmlFor={`${prefix}-action`}>{m.library_archive_entry_action()}</label>
            <select
              id={`${prefix}-action`}
              className={`${control} block w-full`}
              value={action}
              onChange={(event) => setAction(event.currentTarget.value)}
            >
              <option value="preserve">{m.library_archive_entry_preserve()}</option>
              {row.section === 'entries' ? (
                <>
                  <option value="create">{m.library_archive_entry_create()}</option>
                  <option value="update">{m.library_archive_entry_update()}</option>
                </>
              ) : (
                <option value="assign">{m.library_archive_entry_assign()}</option>
              )}
            </select>
            {row.section === 'entries' && action !== 'preserve' && (
              <>
                <label htmlFor={`${prefix}-state`}>{m.library_archive_entry_state_id()}</label>
                <input
                  id={`${prefix}-state`}
                  className={`${control} block w-full`}
                  name="stateId"
                  required
                  maxLength={64}
                  autoComplete="off"
                />
              </>
            )}
          </>
        )}
        <button type="submit" className={control}>
          {m.library_archive_entry_select({ ordinal: row.ordinal })}
        </button>
      </fieldset>
    </form>
  );
}

function FieldChoiceSelect({
  id,
  name,
  label,
  disabled,
}: {
  id: string;
  name: string;
  label: string;
  disabled: boolean;
}) {
  return (
    <label htmlFor={id} className="block space-y-1">
      <span className="font-medium">{label}</span>
      <select id={id} className={`${control} block w-full`} name={name} defaultValue="preserve" disabled={disabled}>
        <option value="preserve">{m.library_archive_entry_preserve()}</option>
        <option value="set">{m.library_archive_personal_set()}</option>
        <option value="clear">{m.library_archive_personal_clear()}</option>
      </select>
    </label>
  );
}

function fieldChoice(values: FormData, name: string): 'preserve' | 'set' | 'clear' {
  const value = values.get(name);
  if (value === 'preserve' || value === 'set' || value === 'clear') return value;
  throw new Error('invalid_archive_field_choice');
}

function AnnotationMappingForm({
  row,
  disabled,
  onChoose,
}: {
  row: ArchiveRow;
  disabled: boolean;
  onChoose: (choice: ArchiveReviewItem) => void;
}) {
  const prefix = `archive-annotation-${row.ordinal}`;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onChoose({
          ordinal: row.ordinal,
          kind: 'annotation',
          subjectId: String(values.get('subjectId')),
          incarnationId: String(values.get('incarnationId')),
          fields: {
            note: fieldChoice(values, 'note'),
            priority: fieldChoice(values, 'priority'),
          },
        });
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        <label htmlFor={`${prefix}-subject`}>{m.library_archive_entry_subject_id()}</label>
        <input
          id={`${prefix}-subject`}
          className={`${control} block w-full`}
          name="subjectId"
          required
          pattern={uuidPattern}
          autoComplete="off"
        />
        <label htmlFor={`${prefix}-incarnation`}>{m.library_archive_personal_incarnation()}</label>
        <input
          id={`${prefix}-incarnation`}
          className={`${control} block w-full`}
          name="incarnationId"
          required
          pattern={uuidPattern}
          autoComplete="off"
        />
        <FieldChoiceSelect
          id={`${prefix}-note`}
          name="note"
          label={m.library_archive_personal_note()}
          disabled={disabled}
        />
        <FieldChoiceSelect
          id={`${prefix}-priority`}
          name="priority"
          label={m.library_archive_personal_priority()}
          disabled={disabled}
        />
        <button type="submit" className={control}>
          {m.library_archive_entry_select({ ordinal: row.ordinal })}
        </button>
      </fieldset>
    </form>
  );
}

function JournalMappingForm({
  row,
  disabled,
  onChoose,
}: {
  row: ArchiveRow;
  disabled: boolean;
  onChoose: (choice: ArchiveReviewItem) => void;
}) {
  const prefix = `archive-journal-${row.ordinal}`;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        onChoose({
          ordinal: row.ordinal,
          kind: 'journal',
          subjectId: String(values.get('subjectId')),
          sessionId: String(values.get('sessionId')),
          fields: {
            startDate: fieldChoice(values, 'startDate'),
            finishDate: fieldChoice(values, 'finishDate'),
            reflection: fieldChoice(values, 'reflection'),
            ...(Object.hasOwn((row.evidence.journal ?? {}) as object, 'assessment')
              ? { assessment: fieldChoice(values, 'assessment') }
              : {}),
          },
        });
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        <label htmlFor={`${prefix}-subject`}>{m.library_archive_entry_subject_id()}</label>
        <input
          id={`${prefix}-subject`}
          className={`${control} block w-full`}
          name="subjectId"
          required
          pattern={uuidPattern}
          autoComplete="off"
        />
        <label htmlFor={`${prefix}-session`}>{m.library_archive_personal_session()}</label>
        <input
          id={`${prefix}-session`}
          className={`${control} block w-full`}
          name="sessionId"
          required
          pattern={uuidPattern}
          autoComplete="off"
        />
        <FieldChoiceSelect
          id={`${prefix}-start`}
          name="startDate"
          label={m.library_archive_personal_start_date()}
          disabled={disabled}
        />
        <FieldChoiceSelect
          id={`${prefix}-finish`}
          name="finishDate"
          label={m.library_archive_personal_finish_date()}
          disabled={disabled}
        />
        <FieldChoiceSelect
          id={`${prefix}-reflection`}
          name="reflection"
          label={m.library_archive_personal_reflection()}
          disabled={disabled}
        />
        {Object.hasOwn((row.evidence.journal ?? {}) as object, 'assessment') ? (
          <FieldChoiceSelect
            id={`${prefix}-assessment`}
            name="assessment"
            label={m.library_occurrence_assessment()}
            disabled={disabled}
          />
        ) : (
          <p>{m.library_archive_personal_assessment_evidence()}</p>
        )}
        <button type="submit" className={control}>
          {m.library_archive_entry_select({ ordinal: row.ordinal })}
        </button>
      </fieldset>
    </form>
  );
}

/** Source identity stays bound to the archived observation; native review supplies current admission and CAS. */
function ObservationMappingForm({
  row,
  disabled,
  onChoose,
}: {
  row: ArchiveRow;
  disabled: boolean;
  onChoose: (choice: ArchiveReviewItem) => void;
}) {
  const prefix = `archive-observation-${row.ordinal}`;
  const [action, setAction] = useState<'admit' | 'correct'>('correct');
  const observation = row.evidence.observation as {
    provider: string;
    recordId: string;
    privacy: { status: string };
    sourceCreated: { status: string };
    sourceUpdated: { status: string };
  };
  const fields = [
    ['privacy', m.library_rich_entry_privacy()],
    ['sourceCreated', m.library_rich_entry_source_created()],
    ['sourceUpdated', m.library_rich_entry_source_updated()],
  ] as const;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const common = {
          ordinal: row.ordinal,
          kind: 'observation' as const,
          subjectId: String(values.get('subjectId')),
          provider: observation.provider,
          recordId: observation.recordId,
        };
        onChoose(
          action === 'admit'
            ? {
                ...common,
                action,
                fields: {
                  privacy: observation.privacy?.status === 'cleared' ? 'clear' : 'set',
                  sourceCreated: observation.sourceCreated?.status === 'cleared' ? 'clear' : 'set',
                  sourceUpdated: observation.sourceUpdated?.status === 'cleared' ? 'clear' : 'set',
                },
              }
            : {
                ...common,
                action,
                revision: Number(values.get('revision')),
                fields: {
                  privacy: fieldChoice(values, 'privacy'),
                  sourceCreated: fieldChoice(values, 'sourceCreated'),
                  sourceUpdated: fieldChoice(values, 'sourceUpdated'),
                },
              },
        );
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        <p>{m.library_archive_personal_help()}</p>
        <dl className="space-y-2 [overflow-wrap:anywhere]">
          <div>
            <dt>{m.source_observation_provider()}</dt>
            <dd>{observation.provider}</dd>
          </div>
          <div>
            <dt>{m.source_observation_record()}</dt>
            <dd>{observation.recordId}</dd>
          </div>
        </dl>
        <label htmlFor={`${prefix}-subject`} className="block space-y-1">
          <span>{m.library_archive_entry_subject_id()}</span>
          <input
            id={`${prefix}-subject`}
            className={`${control} block w-full`}
            name="subjectId"
            required
            pattern={uuidPattern}
            autoComplete="off"
          />
        </label>
        <label htmlFor={`${prefix}-action`} className="block space-y-1">
          <span>{m.library_archive_entry_action()}</span>
          <select
            id={`${prefix}-action`}
            className={`${control} block w-full`}
            name="action"
            value={action}
            onChange={(event) => setAction(event.target.value as 'admit' | 'correct')}
          >
            <option value="correct">{m.library_archive_observation_correct()}</option>
            <option value="admit">{m.library_archive_observation_admit()}</option>
          </select>
        </label>
        {action === 'correct' ? (
          <>
            <label htmlFor={`${prefix}-revision`} className="block space-y-1">
              <span>{m.library_archive_observation_revision()}</span>
              <input
                id={`${prefix}-revision`}
                className={`${control} block w-full`}
                name="revision"
                type="number"
                min="1"
                max="2147483647"
                step="1"
                required
                inputMode="numeric"
              />
            </label>
            {fields.map(([name, label]) => (
              <FieldChoiceSelect key={name} id={`${prefix}-${name}`} name={name} label={label} disabled={disabled} />
            ))}
          </>
        ) : (
          <p>{m.library_archive_observation_admit_help()}</p>
        )}
        <button type="submit" className={control}>
          {m.library_archive_entry_select({ ordinal: row.ordinal })}
        </button>
      </fieldset>
    </form>
  );
}
