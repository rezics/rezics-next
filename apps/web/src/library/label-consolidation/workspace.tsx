import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { SelectionBar } from '@rezics/ui/selection-bar';
import { m } from '../../paraglide/messages.js';
import { readSubjectLabelPage } from '../labels-actions';
import type { LabelShelfEntry, LabelShelfPageData } from '../label-shelf-read';
import type { LibraryLabelSummary } from '../subject-labels.ts';
import { useLibraryWorkspaceAdmission } from '../library-workspace-admission';
import { displayLibraryTitle } from '../title';
import type { ConsolidationResult, ConsolidationTransport } from './client';
import { ConsolidationReview } from './review';
import { ConsolidationVisit, type ConsolidationEnvelope, type VisitOutcome } from './visit';
import { ConsolidationSelection } from './selection';
import { ConsolidationPanel, type ConsolidationPicked } from './consolidation-panel';

const catalogueOperations = ['library_label.list'] as const;
type Loaded = Extract<LabelShelfPageData, { state: 'loaded' }>;
type Picked = ConsolidationPicked;
type ResultItem = ConsolidationResult['items'][number];
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
  function undoKey(item: ResultItem) {
    const key = `${item.item}:${item.sourceUnassignRevision}`;
    if (!undoKeys.current.has(key)) undoKeys.current.set(key, crypto.randomUUID());
    return undoKeys.current.get(key)!;
  }
  function moreTargets() {
    if (cataloguePage?.state === 'loaded' && cataloguePage.next && catalogueRequest)
      void loadTargets({ query: catalogueRequest.query, cursor: cataloguePage.next });
  }
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
        <ConsolidationPanel
          source={{ id: page.label.id, name: page.label.name }}
          target={target}
          picked={picked}
          query={query}
          cataloguePage={cataloguePage}
          catalogueRequest={catalogueRequest}
          visit={visit}
          outcome={outcome}
          busy={busy}
          locale={locale}
          canUndo={canUndo}
          csrfToken={csrfToken}
          isCurrent={current}
          finalFocus={() => (current() ? launcher.current : false)}
          stateLabel={consolidationState}
          undoKey={undoKey}
          onOpenChange={(value) => {
            if (!locking.current && current()) setOpen(value);
          }}
          onQueryChange={(value) => {
            sequence.current++;
            setQuery(value);
            setCataloguePage(null);
          }}
          onSearch={() => void loadTargets({ query })}
          onMoreTargets={moreTargets}
          onRetryTargets={() => {
            if (catalogueRequest) void loadTargets(catalogueRequest);
          }}
          onRestartPrefix={() => void loadTargets({ query })}
          onTargetSelect={(label) => {
            if (current() && !busy) setTarget(label);
          }}
          onStart={start}
          onNextReview={() => {
            if (visit) void perform(() => visit.nextPage());
          }}
          onConfirm={() => {
            if (visit) void perform(() => visit.confirm());
          }}
          onApply={() => {
            if (visit) void perform(() => visit.apply());
          }}
          onCancel={() => {
            if (visit) void perform(() => visit.cancel());
          }}
          onReadResult={() => {
            if (visit) void perform(() => visit.readResult());
          }}
          onReplay={() => {
            if (visit) void perform(() => visit.recover());
          }}
          onRetryItem={(item) => {
            if (visit) void perform(() => visit.retry(item));
          }}
          onReset={reset}
          onUndoSubmit={(event: FormEvent<HTMLFormElement>) => {
            if (!current() || !canUndo() || busy) event.preventDefault();
          }}
        />
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
