import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { SelectionBar } from '@rezics/ui/selection-bar';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { m } from '../../paraglide/messages.js';
import { readSubjectLabelPage } from '../labels-actions';
import type { LabelShelfEntry, LabelShelfPageData } from '../label-shelf-read';
import type { LibraryLabelSummary } from '../subject-labels.ts';
import { useLibraryWorkspaceAdmission } from '../library-workspace-admission';
import { displayLibraryTitle } from '../title';
import { SelectionReviewList } from '../selection-review-view';
import { SelectionResultView } from '../selection-result-view';
import { shelfHref } from '../shelf-params';
import type { SelectedAssignment, ConsolidationTransport } from './client';
import { ConsolidationReview } from './review';
import { ConsolidationVisit, type ConsolidationEnvelope, type VisitOutcome } from './visit';
import { ConsolidationSelection } from './selection';

const catalogueOperations = ['library_label.list'] as const;
type Loaded = Extract<LabelShelfPageData, { state: 'loaded' }>;
type Picked = { selected: SelectedAssignment; title: string };
type Catalogue = Awaited<ReturnType<typeof readSubjectLabelPage>>;
export type ConsolidationWorkspaceProps = {
  page: Loaded;
  viewer: string;
  locale: string;
  envelope: ConsolidationEnvelope;
  isCurrent(): boolean;
  transport(headers: Record<string, string>): ConsolidationTransport;
  refreshAssignments(sourceId: string, targetId: string): void;
  children: ReactNode;
  catalogue?: typeof readSubjectLabelPage;
  canUndo(): boolean;
  csrfToken(): string;
};

/** One shelf visit owns selection, bounded catalogue pages, exact evidence and native recovery. */
export function ConsolidationWorkspace({
  page,
  viewer,
  locale,
  envelope,
  isCurrent,
  transport,
  refreshAssignments,
  children,
  catalogue = readSubjectLabelPage,
  canUndo,
  csrfToken,
}: ConsolidationWorkspaceProps) {
  const { store: admission } = useLibraryWorkspaceAdmission(catalogueOperations);
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cataloguePage, setCataloguePage] = useState<Catalogue | null>(null);
  const [catalogueRequest, setCatalogueRequest] = useState<{ query: string; cursor?: string } | null>(null);
  const [target, setTarget] = useState<LibraryLabelSummary | null>(null);
  const [visit, setVisit] = useState<ConsolidationVisit | null>(null);
  const [outcome, setOutcome] = useState<VisitOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [, render] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const locking = useRef(false);
  const sequence = useRef(0);
  const visitRef = useRef<ConsolidationVisit | null>(null);
  const undoKeys = useRef(new Map<string, string>());
  const latest = useRef({ isCurrent, refreshAssignments });
  latest.current = { isCurrent, refreshAssignments };
  useEffect(() => {
    alive.current = true;
    const release = envelope.subscribeRetirement(() => {
      visitRef.current?.retire();
      setPicked([]);
      setCataloguePage(null);
      setTarget(null);
      setOpen(false);
      setOutcome('retired');
    });
    return () => {
      alive.current = false;
      sequence.current++;
      visitRef.current?.retire();
      release();
    };
  }, [envelope]);
  const current = () => alive.current && latest.current.isCurrent();
  const title = (entry: LabelShelfEntry) =>
    entry.subject ? displayLibraryTitle(entry.subject.label, locale).text : m.library_subject_unavailable();
  const select = (entry: LabelShelfEntry, checked: boolean) => {
    if (!current() || !envelope.capture('review') || visitRef.current || locking.current) return;
    setPicked((values) =>
      checked
        ? values.some((item) => item.selected.subjectId === entry.subjectId) || values.length >= 16
          ? values
          : [
              ...values,
              {
                title: title(entry),
                selected: { subjectId: entry.subjectId, assignmentId: entry.id, revision: entry.revision },
              },
            ]
        : values.filter((item) => item.selected.assignmentId !== entry.id),
    );
  };
  const reset = () => {
    if (!current() || locking.current) return;
    sequence.current++;
    visitRef.current?.retire();
    visitRef.current = null;
    setVisit(null);
    setPicked([]);
    setTarget(null);
    setOutcome(null);
    setOpen(false);
    launcher.current?.focus();
  };
  async function loadTargets(request: { query: string; cursor?: string }) {
    if (!current() || locking.current || visitRef.current || !admission.allowed('library_label.list')) return;
    const captured = envelope.capture('review');
    if (!captured) return;
    const version = admission.dispatchVersion('library_label.list');
    const ticket = ++sequence.current;
    locking.current = true;
    setBusy(true);
    setCatalogueRequest(request);
    try {
      const response = await catalogue({ data: request });
      if (
        !current() ||
        !captured.isCurrent() ||
        ticket !== sequence.current ||
        version !== admission.dispatchVersion('library_label.list') ||
        !admission.allowed('library_label.list')
      )
        return;
      if (
        response.provenance?.viewer !== viewer ||
        response.provenance.query !== request.query ||
        (response.provenance.cursor ?? null) !== (request.cursor ?? null)
      ) {
        setCataloguePage({ state: 'unavailable', labels: [] });
        return;
      }
      setCataloguePage(response);
    } catch {
      if (current() && ticket === sequence.current) setCataloguePage({ state: 'unavailable', labels: [] });
    } finally {
      locking.current = false;
      if (current()) setBusy(false);
    }
  }
  async function perform(action: () => Promise<VisitOutcome>) {
    if (!current() || locking.current) return;
    locking.current = true;
    setBusy(true);
    try {
      const value = await action();
      if (current()) {
        setOutcome(value);
        render((value) => value + 1);
      }
    } finally {
      locking.current = false;
      if (current()) setBusy(false);
    }
  }
  function start() {
    if (!target || !picked.length || !current() || locking.current || visitRef.current) return;
    const next = new ConsolidationVisit(
      new ConsolidationReview(
        page.label.id,
        target.id,
        picked.map((item) => item.selected),
      ),
      envelope,
      transport,
      (source, target) => latest.current.refreshAssignments(source, target),
    );
    visitRef.current = next;
    setVisit(next);
    void perform(() => next.nextPage());
  }
  const result = visit?.result;
  const confirmation = visit?.confirmation;
  const reviewItems = visit?.review.evidence.flatMap((page) => page.items) ?? [];
  const reviewTitle = (id: string) => picked.find((item) => item.selected.subjectId === id)?.title ?? id;
  const ready = !!visit?.review.confirmation();
  const selected = (entry: LabelShelfEntry) =>
    picked.some(
      (item) =>
        item.selected.assignmentId === entry.id &&
        item.selected.revision === entry.revision &&
        item.selected.subjectId === entry.subjectId,
    );
  const controls = current() && !!envelope.capture('review');
  return (
    <ConsolidationSelection.Provider
      value={
        active && controls && !visit
          ? (entry) => ({
              selectable: !!entry.subject && (picked.length < 16 || selected(entry)),
              selected: selected(entry),
              onSelectedChange: (checked) => select(entry, checked),
            })
          : null
      }
    >
      <div className={active ? 'space-y-4 pb-28' : 'space-y-4'}>
        <section aria-label={m.library_consolidation_heading()} className="space-y-2">
          <p className="text-sm text-muted-foreground">{m.library_consolidation_hint()}</p>
          <Button
            ref={launcher}
            variant="outline"
            disabled={!controls || busy}
            onClick={() => {
              if (!current()) return;
              if (picked.length || visit) setOpen(true);
              else setActive((value) => !value);
            }}
          >
            {picked.length || visit ? m.library_consolidation_open() : m.library_consolidation_select()}
          </Button>
          {active ? <p role="status">{m.library_consolidation_limit()}</p> : null}
        </section>
        {children}
      </div>
      {active && picked.length > 0 && !open && controls ? (
        <SelectionBar
          count={picked.length}
          label={(count) => m.library_selection_count({ count })}
          actions={null}
          primaryAction={<Button onClick={() => setOpen(true)}>{m.library_consolidation_open()}</Button>}
          onCancel={reset}
          cancelLabel={m.library_selection_review_close()}
          moreLabel={m.library_entry_actions({ title: page.label.name })}
          ariaLabel={m.library_consolidation_heading()}
        />
      ) : null}
      {open && controls ? (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!locking.current && current()) setOpen(value);
          }}
        >
          <DialogContent
            showCloseButton={false}
            finalFocus={() => (current() ? launcher.current : false)}
            className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-xl"
          >
            <DialogTitle>{m.library_consolidation_heading()}</DialogTitle>
            <DialogDescription>{m.library_consolidation_meaning()}</DialogDescription>
            <SelectionReviewList
              labelledBy={m.library_selection_heading()}
              items={picked.map((item) => ({
                subjectId: item.selected.subjectId,
                title: item.title,
                stateLabel: `${item.selected.assignmentId} · ${item.selected.revision}`,
              }))}
            />
            {!visit ? (
              <>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadTargets({ query });
                  }}
                >
                  <label className="min-w-0 flex-1 space-y-1">
                    {m.library_consolidation_target()}
                    <Input
                      value={query}
                      maxLength={4096}
                      disabled={busy}
                      onChange={(event) => {
                        sequence.current++;
                        setQuery(event.target.value);
                        setCataloguePage(null);
                      }}
                    />
                  </label>
                  <Button type="submit" disabled={busy}>
                    {m.library_consolidation_search()}
                  </Button>
                </form>
                {cataloguePage?.state === 'loaded' ? (
                  <>
                    <fieldset className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
                      <legend>{m.library_consolidation_target()}</legend>
                      {cataloguePage.labels
                        .filter((label) => label.id !== page.label.id)
                        .map((label) => (
                          <label key={label.id} className="flex min-h-11 min-w-0 items-center gap-2 break-all">
                            <input
                              type="radio"
                              name="consolidation-target"
                              checked={target?.id === label.id}
                              onChange={() => {
                                if (current() && !busy) setTarget(label);
                              }}
                            />
                            <span>
                              {label.name}
                              <code className="block text-xs">{label.id}</code>
                            </span>
                          </label>
                        ))}
                    </fieldset>
                    {!cataloguePage.labels.some((label) => label.id !== page.label.id) ? (
                      <p role="status">{m.library_consolidation_no_targets()}</p>
                    ) : null}
                    {cataloguePage.next ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (catalogueRequest)
                            void loadTargets({ query: catalogueRequest.query, cursor: cataloguePage.next! });
                        }}
                      >
                        {m.library_more()}
                      </Button>
                    ) : null}
                  </>
                ) : cataloguePage ? (
                  <div role="alert">
                    <p>
                      {cataloguePage.state === 'closed'
                        ? m.library_subject_label_closed()
                        : m.library_labels_unavailable()}
                    </p>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (catalogueRequest) void loadTargets(catalogueRequest);
                      }}
                    >
                      {m.subject_view_retry()}
                    </Button>
                    <Button disabled={busy} onClick={() => void loadTargets({ query })}>
                      {m.library_consolidation_restart_prefix()}
                    </Button>
                  </div>
                ) : null}
                {target ? (
                  <p>
                    {m.library_consolidation_destination({ name: target.name })}
                    <code className="block break-all text-xs">{target.id}</code>
                  </p>
                ) : null}
                <Button disabled={!target || !picked.length || busy} onClick={start}>
                  {m.library_consolidation_review()}
                </Button>
              </>
            ) : (
              <>
                <p role="status">
                  {m.library_consolidation_reviewed({ count: visit.review.reviewed, total: visit.review.total })}
                </p>
                {visit.review.evidence[0] ? (
                  <p className="break-words">
                    {visit.review.evidence[0].sourceLabel.name} → {visit.review.evidence[0].targetLabel.name}
                    <code className="block break-all text-xs">
                      {visit.review.evidence[0].sourceLabel.id} · {visit.review.evidence[0].sourceLabel.revision}
                      {' → '}
                      {visit.review.evidence[0].targetLabel.id} · {visit.review.evidence[0].targetLabel.revision}
                    </code>
                  </p>
                ) : null}
                <SelectionReviewList
                  labelledBy={m.library_consolidation_review()}
                  items={reviewItems.map((item) => ({
                    subjectId: item.selected.subjectId,
                    title: reviewTitle(item.selected.subjectId),
                    stateLabel: consolidationState(item.outcome),
                  }))}
                />
                {!visit.review.complete && !confirmation ? (
                  <Button disabled={busy} onClick={() => void perform(() => visit.nextPage())}>
                    {m.library_consolidation_next_review()}
                  </Button>
                ) : null}
                {!confirmation ? (
                  <Button
                    disabled={!ready || busy || visit.hasRetainedCommand}
                    onClick={() => void perform(() => visit.confirm())}
                  >
                    {m.library_consolidation_confirm()}
                  </Button>
                ) : (
                  <>
                    <p role="status">{m.library_consolidation_expiry({ time: confirmation.expiresAt })}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={
                          busy ||
                          visit.hasRetainedCommand ||
                          (result?.status !== undefined && result.status !== 'active')
                        }
                        onClick={() => void perform(() => visit.apply())}
                      >
                        {m.library_consolidation_apply()}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          busy ||
                          visit.hasRetainedCommand ||
                          (result?.status !== undefined && result.status !== 'active')
                        }
                        onClick={() => void perform(() => visit.cancel())}
                      >
                        {m.library_consolidation_cancel()}
                      </Button>
                      <Button variant="outline" disabled={busy} onClick={() => void perform(() => visit.readResult())}>
                        {m.library_consolidation_result()}
                      </Button>
                    </div>
                  </>
                )}
                {outcome === 'unknown' ? <p role="alert">{m.library_consolidation_unknown()}</p> : null}
                {outcome === 'rejected' ? (
                  <p role="alert">
                    {m.library_consolidation_rejected()}{' '}
                    {visit.rejection?.code ? <code>{visit.rejection.code}</code> : null}
                  </p>
                ) : null}
                {visit.hasRetainedCommand ? (
                  <Button disabled={busy} onClick={() => void perform(() => visit.recover())}>
                    {m.library_consolidation_replay()}
                  </Button>
                ) : null}
                {result ? (
                  <>
                    <p role="status">{consolidationState(result.status)}</p>
                    <SelectionResultView
                      results={result.items.map((item) => ({
                        key: String(item.item),
                        subjectId: item.selected?.subjectId ?? '',
                        title: item.selected ? reviewTitle(item.selected.subjectId) : m.library_subject_unavailable(),
                        state:
                          item.status === 'moved'
                            ? 'applied'
                            : item.status === 'processing'
                              ? 'uncertain'
                              : item.status === 'pending'
                                ? 'pending'
                                : item.status === 'inaccessible'
                                  ? 'denied'
                                  : 'conflict',
                        source: 'label',
                        sourceState: item.status,
                        detail: consolidationState(item.status),
                      }))}
                    />
                    <ol className="space-y-3">
                      {result.items.map((item) => {
                        const key = `${item.item}:${item.sourceUnassignRevision}`;
                        if (!undoKeys.current.has(key)) undoKeys.current.set(key, crypto.randomUUID());
                        return (
                          <li key={item.item} data-consolidation-result={item.status} className="break-all">
                            <p>
                              {item.item + 1}: {consolidationState(item.status)}
                            </p>
                            {item.targetAssignment ? (
                              <p>
                                {m.library_consolidation_target()}:{' '}
                                <code>
                                  {item.targetAssignment.id} · {item.targetAssignment.revision}
                                </code>
                              </p>
                            ) : null}
                            {item.targetUnchanged ? <p>{m.library_consolidation_target_unchanged()}</p> : null}
                            {item.status === 'processing' ? (
                              <Button
                                disabled={busy || visit.hasRetainedCommand}
                                onClick={() => void perform(() => visit.retry(item.item))}
                              >
                                {m.library_consolidation_retry()}
                              </Button>
                            ) : null}
                            {item.selected && item.sourceUnassignRevision !== undefined ? (
                              <form
                                method="post"
                                action={shelfHref(locale, { label: page.label.id })}
                                onSubmit={(event) => {
                                  if (!current() || !canUndo() || busy) event.preventDefault();
                                }}
                              >
                                <p>{m.library_consolidation_undo_hint()}</p>
                                <input type="hidden" name="intent" value="restore" />
                                <input type="hidden" name="subjectId" value={item.selected.subjectId} />
                                <input type="hidden" name="labelId" value={result.sourceLabelId} />
                                <input type="hidden" name="assignmentId" value={item.selected.assignmentId} />
                                <input type="hidden" name="revision" value={item.sourceUnassignRevision} />
                                <input type="hidden" name="idempotencyKey" value={undoKeys.current.get(key)} />
                                <input type="hidden" name="csrf_token" value={csrfToken()} />
                                <Button type="submit" variant="outline" disabled={busy || !canUndo()}>
                                  {m.library_subject_label_undo()}
                                </Button>
                              </form>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  </>
                ) : null}
                <Button variant="outline" disabled={busy} onClick={reset}>
                  {m.library_consolidation_new_review()}
                </Button>
              </>
            )}
            {busy ? <p role="status">{m.library_consolidation_working()}</p> : null}
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {m.library_selection_review_close()}
            </Button>
          </DialogContent>
        </Dialog>
      ) : null}
    </ConsolidationSelection.Provider>
  );
}

/** Exhaustive native outcome labels, without turning a partial result into batch success. */
export function consolidationState(state: string): string {
  const labels: Record<string, () => string> = {
    movable: m.library_consolidation_movable,
    already_on_target: m.library_consolidation_already_on_target,
    missing: m.library_consolidation_missing,
    changed: m.library_consolidation_changed,
    inaccessible: m.library_consolidation_inaccessible,
    capacity_limited: m.library_consolidation_capacity,
    pending: m.library_consolidation_pending,
    processing: m.library_consolidation_processing,
    moved: m.library_consolidation_moved,
    target_applied_source_retained: m.library_consolidation_source_retained,
    active: m.library_consolidation_active,
    completed: m.library_consolidation_completed,
    cancelled: m.library_consolidation_cancelled,
  };
  return labels[state]?.() ?? state;
}
