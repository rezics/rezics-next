import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { SlotLifetime } from '../subject-library-current-origin';
import type { LibraryStateChoice } from '../profiles';
import type { SubjectLibraryReadProvenance, SubjectSlotEntry } from '../subject-slot';
import type { CurrentEntry, EntryStateChange, EntryStatePage, EntryStateReview } from './contract';
import { readEntryAfterRestore, readEntryHistoryPage, readEntryHistoryReview, sendEntryStateRestore } from './server';
import type { RestoreCommand } from './native';
import { Button } from '@rezics/ui/shadcn/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';

const button = 'h-auto min-h-7 max-w-full whitespace-normal text-start';
type ReadNotice = 'missing' | 'stale' | 'retired' | 'denied' | 'unavailable' | 'changed';
type RestoreNotice = 'stale' | 'state_unavailable' | 'unchanged' | 'missing' | 'retired' | 'denied' | 'rejected';
type Attempt = {
  command: RestoreCommand;
  credential: string;
  expectedReader: string;
  expectedCredential: string;
  reviewedBasis: string;
};
type Receipt = {
  entry: CurrentEntry;
  readback: { kind: 'pending' | 'unavailable' | 'different' } | { kind: 'ready'; entry: CurrentEntry };
};

function basisOf(entry: SubjectSlotEntry) {
  return JSON.stringify([entry.subjectId, entry.incarnationId ?? null, entry.revision, entry.state]);
}

export function EntryStateHistory({
  entry,
  stateOptions,
  provenance,
  lifetime,
  canReview,
  canRestore,
  onReadback,
  onRefresh,
}: {
  entry: SubjectSlotEntry;
  stateOptions: readonly LibraryStateChoice[];
  provenance: SubjectLibraryReadProvenance;
  lifetime: SlotLifetime;
  canReview: boolean;
  canRestore: boolean;
  onReadback: (entry: CurrentEntry) => void;
  onRefresh: () => void;
}) {
  const basis = basisOf(entry);
  const latest = useRef({ basis, entry, lifetime });
  latest.current = { basis, entry, lifetime };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const [epoch, setEpoch] = useState(0);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const running = useRef(false);
  const [attemptStatus, setAttemptStatus] = useState<'sending' | 'uncertain' | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<RestoreNotice | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  useEffect(() => {
    if (attemptRef.current && attemptRef.current.command.incarnationId !== entry.incarnationId) {
      attemptRef.current = null;
      setAttempt(null);
      setAttemptStatus(null);
      setRestoreNotice('stale');
    }
    if (receipt && receipt.entry.incarnationId !== entry.incarnationId) setReceipt(null);
  }, [entry.incarnationId, receipt]);

  const current = (...operations: Parameters<SlotLifetime['current']>) =>
    alive.current && latest.current.lifetime.current('library_entry.get', ...operations);
  const readable = (capturedBasis: string, ...operations: Parameters<SlotLifetime['current']>) =>
    current(...operations) && latest.current.basis === capturedBasis;

  async function dispatch(original: Attempt, replay: boolean) {
    if (running.current || !current('library_entry_state_history.restore') || !canRestore) return;
    if (attemptRef.current !== original) return;
    if (
      latest.current.entry.incarnationId !== original.command.incarnationId ||
      (!replay && latest.current.basis !== original.reviewedBasis)
    ) return;
    const dispatchBasis = latest.current.basis;
    running.current = true;
    setAttemptStatus('sending');
    setRestoreNotice(null);
    try {
      const response = await sendEntryStateRestore({
        data: {
          expectedReader: original.expectedReader,
          expectedCredential: original.expectedCredential,
          credential: original.credential,
          ...original.command,
        },
        headers: { 'X-CSRF-Token': original.expectedCredential },
      });
      if (!readable(dispatchBasis, 'library_entry_state_history.restore') || attemptRef.current !== original) {
        if (current('library_entry_state_history.restore') && attemptRef.current === original)
          setAttemptStatus('uncertain');
        return;
      }
      if (response.viewer !== original.expectedReader || response.subjectId !== original.command.subjectId) {
        setAttemptStatus('uncertain');
        return;
      }
      const result = response.result;
      if (result.kind === 'uncertain') {
        setAttemptStatus('uncertain');
        return;
      }
      attemptRef.current = null;
      setAttempt(null);
      setAttemptStatus(null);
      setEpoch((value) => value + 1);
      if (result.kind !== 'recorded') {
        setRestoreNotice(result.kind);
        return;
      }
      const recorded = result.entry;
      setReceipt({ entry: recorded, readback: { kind: 'pending' } });
      let readback: Awaited<ReturnType<typeof readEntryAfterRestore>>;
      try {
        readback = await readEntryAfterRestore({
          data: {
            subjectId: original.command.subjectId,
            expectedReader: original.expectedReader,
            expectedCredential: original.expectedCredential,
          },
          headers: { 'X-CSRF-Token': original.expectedCredential },
        });
      } catch {
        if (current('library_entry_state_history.list'))
          setReceipt({ entry: recorded, readback: { kind: 'unavailable' } });
        return;
      }
      if (!current('library_entry_state_history.list')) return;
      if (latest.current.entry.incarnationId !== recorded.incarnationId) {
        setReceipt({ entry: recorded, readback: { kind: 'different' } });
        return;
      }
      if (
        readback.viewer !== original.expectedReader ||
        readback.subjectId !== original.command.subjectId ||
        readback.result.kind !== 'ready'
      ) {
        setReceipt({ entry: recorded, readback: { kind: 'unavailable' } });
        return;
      }
      const observed = readback.result.value;
      if (
        observed.incarnationId !== recorded.incarnationId ||
        observed.revision < recorded.revision ||
        (observed.revision === recorded.revision && observed.state !== recorded.state) ||
        observed.revision < latest.current.entry.revision
      ) {
        setReceipt({ entry: recorded, readback: { kind: 'different' } });
        return;
      }
      setReceipt({ entry: recorded, readback: { kind: 'ready', entry: observed } });
      onReadback(observed);
    } catch {
      if (current('library_entry_state_history.restore') && attemptRef.current === original)
        setAttemptStatus('uncertain');
    } finally {
      running.current = false;
    }
  }

  function startRestore(review: EntryStateReview, credential: string, reviewedBasis: string) {
    if (
      (attemptRef.current?.command.incarnationId === entry.incarnationId) ||
      running.current ||
      !canRestore ||
      !readable(reviewedBasis, 'library_entry_state_history.review', 'library_entry_state_history.restore') ||
      review.availability !== 'available' ||
      !review.current.incarnationId ||
      review.current.incarnationId !== (entry.incarnationId ?? null) ||
      review.current.revision !== entry.revision
    ) return;
    const original: Attempt = {
      command: {
        subjectId: entry.subjectId,
        changeRevision: review.change.revision,
        incarnationId: review.current.incarnationId,
        currentRevision: review.current.revision,
        key: crypto.randomUUID(),
      },
      credential,
      expectedReader: provenance.viewer,
      expectedCredential: provenance.csrfToken!,
      reviewedBasis,
    };
    attemptRef.current = original;
    setAttempt(original);
    void dispatch(original, false);
  }

  const visibleReceipt = receipt?.entry.incarnationId === (entry.incarnationId ?? null) ? receipt : null;
  const activeAttempt = attempt?.command.incarnationId === entry.incarnationId ? attempt : null;
  const visibleReadback = visibleReceipt?.readback.kind === 'ready' &&
    (entry.revision > visibleReceipt.readback.entry.revision ||
      (entry.revision === visibleReceipt.readback.entry.revision && entry.state !== visibleReceipt.readback.entry.state))
    ? { kind: 'different' as const }
    : visibleReceipt?.readback;
  const retryCurrent =
    !!activeAttempt &&
    attemptStatus === 'uncertain' &&
    current('library_entry_state_history.restore') &&
    canRestore;
  return (
    <section aria-label={m.library_entry_history_title()} className="h-auto basis-full min-w-0 space-y-3 rounded-md border p-3 [overflow-wrap:anywhere]">
      <h3 className="font-semibold">{m.library_entry_history_title()}</h3>
      <p className="text-sm text-muted-foreground">{m.library_entry_history_intro()}</p>
      <HistoryPage
        key={`${basis}:${epoch}`}
        basis={basis}
        entry={entry}
        stateOptions={stateOptions}
        provenance={provenance}
        canReview={canReview}
        canRestore={canRestore}
        commandPending={
          !!activeAttempt ||
          (visibleReceipt?.readback.kind === 'pending')
        }
        isCurrent={readable}
        onRestore={startRestore}
        onRefresh={onRefresh}
      />
      {activeAttempt && attemptStatus === 'sending' ? <p role="status">{m.library_entry_history_restoring()}</p> : null}
      {activeAttempt && attemptStatus === 'uncertain' ? (
        <div className="space-y-2" role="status">
          <p>{m.library_entry_history_uncertain()}</p>
          {retryCurrent ? (
            <Button variant="outline" className={button} onClick={() => void dispatch(activeAttempt, true)}>
              {m.library_entry_history_retry_original()}
            </Button>
          ) : <p>{m.library_entry_history_fresh_review()}</p>}
        </div>
      ) : null}
      {restoreNotice ? (
        <div className="space-y-2" role="alert">
          <p>{restoreMessage(restoreNotice)}</p>
          {restoreNotice === 'stale' ? (
            <Button variant="outline" className={button} onClick={onRefresh}>{m.library_entry_history_refresh_entry()}</Button>
          ) : null}
        </div>
      ) : null}
      {visibleReceipt ? (
        <div className="space-y-2" role="status">
          <p>{m.library_entry_history_recorded_success()}</p>
          <p>{m.library_entry_history_receipt_revision({ revision: visibleReceipt.entry.revision })}</p>
          <StateEvidence state={visibleReceipt.entry.state} options={stateOptions} />
          {visibleReadback?.kind === 'pending' ? <p>{m.library_entry_history_readback_loading()}</p> : null}
          {visibleReadback?.kind === 'unavailable' ? <p>{m.library_entry_history_readback_unavailable()}</p> : null}
          {visibleReadback?.kind === 'different' ? <p>{m.library_entry_history_readback_different()}</p> : null}
          {visibleReadback?.kind === 'ready' ? (
            <div>
              <p>{m.library_entry_history_readback_current({ revision: visibleReadback.entry.revision })}</p>
              <StateEvidence state={visibleReadback.entry.state} options={stateOptions} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function HistoryPage({
  basis,
  entry,
  stateOptions,
  provenance,
  canReview,
  canRestore,
  commandPending,
  isCurrent,
  onRestore,
  onRefresh,
}: {
  basis: string;
  entry: SubjectSlotEntry;
  stateOptions: readonly LibraryStateChoice[];
  provenance: SubjectLibraryReadProvenance;
  canReview: boolean;
  canRestore: boolean;
  commandPending: boolean;
  isCurrent: (basis: string, ...operations: Parameters<SlotLifetime['current']>) => boolean;
  onRestore: (review: EntryStateReview, credential: string, basis: string) => void;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState<EntryStatePage | null>(null);
  const [review, setReview] = useState<{ value: EntryStateReview; credential: string } | null>(null);
  const [notice, setNotice] = useState<ReadNotice | null>(null);
  const [busy, setBusy] = useState<'page' | 'review' | null>(null);
  const [limit, setLimit] = useState(20);
  const flight = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; flight.current++; };
  }, []);
  const current = (id: number, ...operations: Parameters<SlotLifetime['current']>) =>
    mounted.current && flight.current === id && isCurrent(basis, ...operations);

  async function load(cursor?: string) {
    if (busy || commandPending || !isCurrent(basis, 'library_entry_state_history.list')) return;
    const id = ++flight.current;
    setBusy('page');
    setPage(null);
    setReview(null);
    setNotice(null);
    try {
      const response = await readEntryHistoryPage({
        data: {
          subjectId: entry.subjectId,
          expectedReader: provenance.viewer,
          expectedCredential: provenance.csrfToken!,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        },
        headers: { 'X-CSRF-Token': provenance.csrfToken! },
      });
      if (!current(id, 'library_entry_state_history.list')) return;
      if (response.viewer !== provenance.viewer || response.subjectId !== entry.subjectId) {
        setNotice('unavailable');
      } else if (response.result.kind !== 'ready') {
        setNotice(response.result.kind);
      } else if (
        response.result.value.incarnationId !== (entry.incarnationId ?? null) ||
        response.result.value.currentRevision !== entry.revision
      ) {
        setNotice('changed');
      } else {
        setPage(response.result.value);
      }
    } catch {
      if (current(id, 'library_entry_state_history.list')) setNotice('unavailable');
    } finally {
      if (current(id)) setBusy(null);
    }
  }

  async function address(change: EntryStateChange) {
    if (!page || busy || commandPending || !canReview || !isCurrent(basis, 'library_entry_state_history.review')) return;
    const id = ++flight.current;
    setBusy('review');
    setReview(null);
    setNotice(null);
    try {
      const response = await readEntryHistoryReview({
        data: {
          subjectId: entry.subjectId,
          expectedReader: provenance.viewer,
          expectedCredential: provenance.csrfToken!,
          changeRevision: change.revision,
        },
        headers: { 'X-CSRF-Token': provenance.csrfToken! },
      });
      if (!current(id, 'library_entry_state_history.review')) return;
      if (response.viewer !== provenance.viewer || response.subjectId !== entry.subjectId) {
        setNotice('unavailable');
      } else if (response.result.kind !== 'ready') {
        setNotice(response.result.kind);
      } else if (
        !response.credential ||
        JSON.stringify(response.result.value.change) !== JSON.stringify(change) ||
        response.result.value.current.incarnationId !== page.incarnationId ||
        response.result.value.current.revision !== page.currentRevision ||
        response.result.value.current.state !== entry.state
      ) {
        setPage(null);
        setNotice('changed');
      } else {
        setReview({ value: response.result.value, credential: response.credential });
      }
    } catch {
      if (current(id, 'library_entry_state_history.review')) setNotice('unavailable');
    } finally {
      if (current(id)) setBusy(null);
    }
  }

  const coverage = page?.changes.length === 0 && page.coverage === 'complete'
    ? 'unknown'
    : (page?.coverage ?? 'unknown');
  return (
    <div className="space-y-3">
      <label className="flex flex-wrap items-center gap-2">
        {m.library_entry_history_page_size()}
        <Select<string, false>
          items={[
            { value: '20', label: '20' },
            { value: '50', label: '50' },
          ]}
          value={String(limit)}
          disabled={!!busy || commandPending}
          onValueChange={(value) => {
            if (value === null) return;
            setLimit(Number(value));
            setPage(null);
            setReview(null);
            setNotice(null);
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="20">20</SelectItem>
              <SelectItem value="50">50</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      {!page && !busy ? <Button variant="outline" className={button} disabled={commandPending} onClick={() => void load()}>{m.library_entry_history_open()}</Button> : null}
      {busy === 'page' ? <p role="status">{m.library_entry_history_loading()}</p> : null}
      {notice ? (
        <div role="status" className="space-y-2">
          <p>{readMessage(notice)}</p>
          {notice === 'changed' || notice === 'stale' ? (
            <Button variant="outline" className={button} onClick={onRefresh}>{m.library_entry_history_refresh_entry()}</Button>
          ) : null}
        </div>
      ) : null}
      {page ? (
        <>
          {page.incarnationId ? (
            <p>{m.library_entry_history_incarnation_id()} <code className="break-all">{page.incarnationId}</code></p>
          ) : null}
          <p>{m.library_entry_history_current_revision({ revision: page.currentRevision })}</p>
          <p>{coverageMessage(coverage)}</p>
          {page.changes.length === 0 ? <p>{m.library_entry_history_empty()}</p> : null}
          <p className="text-sm text-muted-foreground">{m.library_entry_history_profile_note()}</p>
          <ol className="space-y-3">
            {page.changes.map((change) => (
              <li key={change.revision} className="space-y-2 rounded-md border p-3">
                <p className="font-medium">{m.library_entry_history_change_revision({ revision: change.revision })}</p>
                <ChangeEvidence change={change} options={stateOptions} />
                {canReview ? (
                  <Button
                    variant="outline" className={button}
                    disabled={!!busy || commandPending}
                    onClick={() => void address(change)}
                  >
                    {m.library_entry_history_review()}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {page.next ? (
              <Button variant="outline" className={button} disabled={!!busy || commandPending} onClick={() => void load(page.next!)}>
                {m.library_entry_history_next()}
              </Button>
            ) : null}
            <Button variant="outline" className={button} disabled={!!busy || commandPending} onClick={() => void load()}>
              {m.library_entry_history_restart()}
            </Button>
          </div>
        </>
      ) : null}
      {busy === 'review' ? <p role="status">{m.library_entry_history_review_loading()}</p> : null}
      {review ? (
        <article className="space-y-3 rounded-md border p-3">
          <h4 className="font-semibold">{m.library_entry_history_review_title()}</h4>
          <p>{m.library_entry_history_reviewed_revision({ revision: review.value.change.revision })}</p>
          <div>
            <p>{m.library_entry_history_current_state()}</p>
            <StateEvidence state={review.value.current.state} options={stateOptions} />
          </div>
          <ChangeEvidence change={review.value.change} options={stateOptions} beforeLabel={m.library_entry_history_restore_target()} />
          <p>{availabilityMessage(review.value.availability)}</p>
          {review.value.availability === 'available' && canRestore ? (
            <Button
              variant="outline" className={button}
              disabled={!!busy || commandPending}
              onClick={() => onRestore(review.value, review.credential, basis)}
            >
              {m.library_entry_history_restore()}
            </Button>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}

function StateEvidence({ state, options }: { state: string | null; options: readonly LibraryStateChoice[] }) {
  if (state === null) return <span>{m.library_entry_history_absent()}</span>;
  const label = options.find((option) => option.id === state)?.label;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-2">
      <code className="break-all">{state}</code>
      {label ? <span lang={label.lang}>({m.library_entry_history_released_label()}: {label.text})</span> : null}
    </span>
  );
}

function ProfilePinEvidence({
  pin,
  missing,
}: {
  pin: EntryStateChange['beforeProfilePin'];
  missing: 'no_prior' | 'unavailable';
}) {
  if (pin === null) return <p>{missing === 'no_prior' ? m.library_entry_history_pin_no_prior() : m.library_entry_history_pin_unavailable()}</p>;
  const field = (label: string, value: string | null) => (
    <div>
      <dt>{label}</dt>
      <dd>{value === null
        ? m.library_entry_history_pin_not_applicable()
        : <code className="block max-h-24 overflow-auto break-all whitespace-pre-wrap">{value}</code>}</dd>
    </div>
  );
  return (
    <div className="min-w-0 rounded-md border p-2">
      <p className="font-medium">{m.library_entry_history_pin_recorded()}</p>
      <dl className="min-w-0 space-y-1">
        {field(m.library_entry_history_pin_provenance(), pin.provenance)}
        {field(m.library_entry_history_pin_release_digest(), pin.releaseDigest)}
        {field(m.library_entry_history_pin_accepting_type(), pin.acceptingType)}
        {field(m.library_entry_history_pin_profile_id(), pin.profileId)}
      </dl>
    </div>
  );
}

function ChangeEvidence({
  change,
  options,
  beforeLabel,
}: {
  change: EntryStateChange;
  options: readonly LibraryStateChoice[];
  beforeLabel?: string;
}) {
  return (
    <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
      <div><dt>{beforeLabel ?? m.library_entry_history_before()}</dt><dd className="space-y-2"><StateEvidence state={change.beforeState} options={options} /><ProfilePinEvidence pin={change.beforeProfilePin} missing={change.beforeState === null ? 'no_prior' : 'unavailable'} /></dd></div>
      <div><dt>{m.library_entry_history_after()}</dt><dd className="space-y-2"><StateEvidence state={change.afterState} options={options} /><ProfilePinEvidence pin={change.afterProfilePin} missing="unavailable" /></dd></div>
      <div><dt>{m.library_entry_history_prior_revision()}</dt><dd>{change.priorRevision ?? m.library_entry_history_absent()}</dd></div>
      <div><dt>{m.library_entry_history_changed_at()}</dt><dd><time dateTime={change.changedAt}>{change.changedAt}</time></dd></div>
      <div><dt>{m.library_entry_history_command_kind()}</dt><dd><code className="break-all">{change.commandKind}</code></dd></div>
      <div><dt>{m.library_entry_history_command_id()}</dt><dd><code className="break-all">{change.commandId}</code></dd></div>
    </dl>
  );
}

function coverageMessage(coverage: EntryStatePage['coverage']) {
  if (coverage === 'complete') return m.library_entry_history_coverage_complete();
  if (coverage === 'partial') return m.library_entry_history_coverage_partial();
  return m.library_entry_history_coverage_unknown();
}
function availabilityMessage(availability: EntryStateReview['availability']) {
  if (availability === 'available') return m.library_entry_history_available();
  if (availability === 'no_prior_state') return m.library_entry_history_no_prior();
  return m.library_entry_history_state_unavailable();
}
function readMessage(notice: ReadNotice) {
  if (notice === 'missing') return m.library_entry_history_missing();
  if (notice === 'stale') return m.library_entry_history_stale_page();
  if (notice === 'changed') return m.library_entry_history_changed();
  if (notice === 'retired' || notice === 'denied') return m.library_entry_history_denied();
  return m.library_entry_history_unavailable();
}
function restoreMessage(notice: RestoreNotice) {
  if (notice === 'stale') return m.library_entry_history_stale_restore();
  if (notice === 'state_unavailable') return m.library_entry_history_state_unavailable();
  if (notice === 'unchanged') return m.library_entry_history_unchanged();
  if (notice === 'missing') return m.library_entry_history_missing();
  if (notice === 'retired' || notice === 'denied') return m.library_entry_history_denied();
  return m.library_entry_history_rejected();
}
