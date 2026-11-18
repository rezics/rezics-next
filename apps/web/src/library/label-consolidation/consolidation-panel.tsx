import type { FormEvent, ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { m } from '../../paraglide/messages.js';
import { readSubjectLabelPage } from '../labels-actions';
import type { LibraryLabelSummary } from '../subject-labels.ts';
import { shelfHref } from '../shelf-params';
import type { ConsolidationResult, ReviewPage, SelectedAssignment } from './client';
import type { ConsolidationVisit, VisitOutcome } from './visit';

type Catalogue = Awaited<ReturnType<typeof readSubjectLabelPage>>;
export type ConsolidationPicked = { selected: SelectedAssignment; title: string };
type LabelContext = { id: string; name: string; revision?: number };
type TargetRequest = { query: string; cursor?: string };
type ReviewItem = ReviewPage['items'][number];
type ResultItem = ConsolidationResult['items'][number];

export type ConsolidationPanelProps = {
  source: LabelContext;
  target: LibraryLabelSummary | null;
  picked: readonly ConsolidationPicked[];
  query: string;
  cataloguePage: Catalogue | null;
  catalogueRequest: TargetRequest | null;
  visit: ConsolidationVisit | null;
  outcome: VisitOutcome | null;
  busy: boolean;
  locale: string;
  canUndo(): boolean;
  csrfToken(): string;
  isCurrent(): boolean;
  finalFocus(): HTMLElement | false | null;
  stateLabel(state: string): string;
  undoKey(item: ResultItem): string;
  onOpenChange(open: boolean): void;
  onQueryChange(query: string): void;
  onSearch(): void;
  onMoreTargets(): void;
  onRetryTargets(): void;
  onRestartPrefix(): void;
  onTargetSelect(label: LibraryLabelSummary): void;
  onStart(): void;
  onNextReview(): void;
  onConfirm(): void;
  onApply(): void;
  onCancel(): void;
  onReadResult(): void;
  onReplay(): void;
  onRetryItem(item: number): void;
  onReset(): void;
  onUndoSubmit(event: FormEvent<HTMLFormElement>): void;
};

/** Stage presentation for the visit-local workspace. All commands and operands stay with its owner. */
export function ConsolidationPanel({
  source,
  target,
  picked,
  query,
  cataloguePage,
  catalogueRequest,
  visit,
  outcome,
  busy,
  locale,
  canUndo,
  csrfToken,
  isCurrent,
  finalFocus,
  stateLabel,
  undoKey,
  onOpenChange,
  onQueryChange,
  onSearch,
  onMoreTargets,
  onRetryTargets,
  onRestartPrefix,
  onTargetSelect,
  onStart,
  onNextReview,
  onConfirm,
  onApply,
  onCancel,
  onReadResult,
  onReplay,
  onRetryItem,
  onReset,
  onUndoSubmit,
}: ConsolidationPanelProps) {
  const result = visit?.result;
  const confirmation = visit?.confirmation;
  const evidence = visit?.review.evidence ?? [];
  const reviewItems = evidence.flatMap((page) => page.items);
  const ready = !!visit?.review.confirmation();
  const stage = !visit ? 'target' : confirmation ? 'result' : 'review';
  const reviewedSource = evidence[0]?.sourceLabel;
  const reviewedTarget = evidence[0]?.targetLabel;
  const sourceName = reviewedSource?.name ?? source.name;
  const targetName = reviewedTarget?.name ?? target?.name ?? m.library_consolidation_target();
  const sourceId = reviewedSource?.id ?? source.id;
  const targetId = reviewedTarget?.id ?? target?.id;
  const sourceRevision = reviewedSource?.revision ?? source.revision;
  const targetRevision = reviewedTarget?.revision;
  const titleFor = (subjectId: string) => picked.find((item) => item.selected.subjectId === subjectId)?.title ?? subjectId;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!busy && isCurrent()) onOpenChange(open);
      }}
    >
      <DialogContent
        showCloseButton={false}
        finalFocus={finalFocus}
        className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] min-w-0 max-w-5xl flex-col overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)]"
      >
        <header className="shrink-0 space-y-3 border-b px-4 py-4 sm:px-6">
          <DialogTitle>{m.library_consolidation_heading()}</DialogTitle>
          <DialogDescription>{m.library_consolidation_meaning()}</DialogDescription>
          <ol aria-label={m.library_consolidation_heading()} className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              [m.library_selection_heading(), 'selection'],
              [m.library_consolidation_target(), 'target'],
              [m.library_consolidation_review(), 'review'],
              [m.library_consolidation_result(), 'result'],
            ].map(([label, name]) => (
              <li
                key={name}
                aria-current={stage === name ? 'step' : undefined}
                className={`rounded-md border px-3 py-2 ${stage === name ? 'border-primary bg-muted font-medium' : 'text-muted-foreground'}`}
              >
                {label}
              </li>
            ))}
          </ol>
          <div role="group" aria-label={m.library_consolidation_heading()} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium">{sourceName}</span>
            <span aria-hidden="true">→</span>
            <span className="font-medium">{targetName}</span>
            <details className="basis-full text-xs text-muted-foreground sm:basis-auto">
              <summary className="min-h-8 cursor-pointer py-1">{m.library_selection_heading()}</summary>
              <code className="block break-all">
                {sourceId}{sourceRevision !== undefined ? ` · ${sourceRevision}` : ''}
                {targetId ? ` → ${targetId}${targetRevision !== undefined ? ` · ${targetRevision}` : ''}` : ''}
              </code>
            </details>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
          {!visit ? (
            <div className="grid gap-5 lg:grid-cols-2 lg:gap-7">
              <SelectedAssignments picked={picked} />
              <section aria-labelledby="consolidation-target-heading" className="min-w-0 space-y-3">
                <h3 id="consolidation-target-heading" className="text-base font-semibold">
                  {m.library_consolidation_target()}
                </h3>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onSearch();
                  }}
                >
                  <label className="min-w-0 flex-1 space-y-1">
                    <span className="text-sm">{m.library_consolidation_target()}</span>
                    <Input
                      value={query}
                      maxLength={4096}
                      disabled={busy}
                      onChange={(event) => onQueryChange(event.target.value)}
                    />
                  </label>
                  <Button type="submit" disabled={busy}>
                    {m.library_consolidation_search()}
                  </Button>
                </form>
                {cataloguePage?.state === 'loaded' ? (
                  <>
                    <fieldset className="max-h-60 space-y-1 overflow-y-auto rounded-md border p-3">
                      <legend className="px-1">{m.library_consolidation_target()}</legend>
                      {cataloguePage.labels
                        .filter((label) => label.id !== source.id)
                        .map((label) => (
                          <label key={label.id} className="flex min-w-0 items-center gap-3 rounded px-2 py-1 hover:bg-muted/50">
                            <input
                              type="radio"
                              name="consolidation-target"
                              checked={target?.id === label.id}
                              disabled={busy}
                              onChange={() => {
                                if (isCurrent() && !busy) onTargetSelect(label);
                              }}
                            />
                            <span className="min-w-0">
                              <span className="h-auto block break-words">{label.name}</span>
                              <code className="block break-all text-xs text-muted-foreground">{label.id}</code>
                            </span>
                          </label>
                        ))}
                    </fieldset>
                    {!cataloguePage.labels.some((label) => label.id !== source.id) ? (
                      <p role="status">{m.library_consolidation_no_targets()}</p>
                    ) : null}
                    {cataloguePage.next ? (
                      <div className="border-t pt-3">
                        <Button variant="outline" disabled={busy || !catalogueRequest} onClick={onMoreTargets}>
                          {m.library_more()}
                        </Button>
                      </div>
                    ) : null}
                  </>
                ) : cataloguePage ? (
                  <div role="alert" className="space-y-2 rounded-md border p-3">
                    <p>
                      {cataloguePage.state === 'closed'
                        ? m.library_subject_label_closed()
                        : m.library_labels_unavailable()}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" disabled={busy || !catalogueRequest} onClick={onRetryTargets}>
                        {m.subject_view_retry()}
                      </Button>
                      <Button variant="outline" disabled={busy} onClick={onRestartPrefix}>
                        {m.library_consolidation_restart_prefix()}
                      </Button>
                    </div>
                  </div>
                ) : null}
                {target ? (
                  <p className="rounded-md bg-muted p-3 text-sm">
                    {m.library_consolidation_destination({ name: target.name })}
                    <code className="mt-1 block break-all text-xs text-muted-foreground">{target.id}</code>
                  </p>
                ) : null}
              </section>
            </div>
          ) : (
            <>
              <section aria-labelledby="consolidation-review-heading" className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 id="consolidation-review-heading" className="text-base font-semibold">
                    {confirmation ? m.library_consolidation_result() : m.library_consolidation_review()}
                  </h3>
                  <span className="text-sm text-muted-foreground">
                    {m.library_selection_count({ count: visit.review.total })}
                  </span>
                </div>
                {!confirmation ? (
                  <p role="status">
                    {m.library_consolidation_reviewed({ count: visit.review.reviewed, total: visit.review.total })}
                  </p>
                ) : (
                  <p role="status">{m.library_consolidation_expiry({ time: confirmation.expiresAt })}</p>
                )}
              </section>

              {!confirmation ? (
                <>
                  <details className="rounded-md border px-3">
                    <summary className="cursor-pointer py-3">
                      {m.library_selection_heading()} · {m.library_selection_count({ count: picked.length })}
                    </summary>
                    <SelectedAssignments picked={picked} compact />
                  </details>
                  <ReviewAssignments
                    items={reviewItems}
                    titleFor={titleFor}
                    sourceName={sourceName}
                    targetName={targetName}
                    stateLabel={stateLabel}
                  />
                </>
              ) : null}

              {result ? (
                <ResultAssignments
                  items={result.items}
                  status={result.status}
                  titleFor={titleFor}
                  sourceName={sourceName}
                  targetName={targetName}
                  stateLabel={stateLabel}
                  busy={busy}
                  hasRetainedCommand={visit.hasRetainedCommand}
                  canUndo={canUndo}
                  csrfToken={csrfToken}
                  isCurrent={isCurrent}
                  locale={locale}
                  sourceLabelId={result.sourceLabelId}
                  undoKey={undoKey}
                  onRetryItem={onRetryItem}
                  onUndoSubmit={onUndoSubmit}
                />
              ) : null}

              {outcome === 'unknown' ? <p role="alert">{m.library_consolidation_unknown()}</p> : null}
              {outcome === 'rejected' ? (
                <p role="alert">
                  {m.library_consolidation_rejected()}{' '}
                  {visit.rejection?.code ? <code>{visit.rejection.code}</code> : null}
                </p>
              ) : null}
            </>
          )}
          {busy ? <p role="status">{m.library_consolidation_working()}</p> : null}
        </div>

        <footer className="shrink-0 border-t px-4 py-3 sm:px-6">
          <div className="flex flex-wrap justify-end gap-2">
            {visit?.hasRetainedCommand ? (
              <Button disabled={busy} onClick={onReplay}>
                {m.library_consolidation_replay()}
              </Button>
            ) : null}
            {!visit ? (
              <Button disabled={!target || !picked.length || busy} onClick={onStart}>
                {m.library_consolidation_review()}
              </Button>
            ) : !confirmation ? (
              visit.hasRetainedCommand ? null : visit.review.complete ? (
                <Button disabled={!ready || busy || visit.hasRetainedCommand} onClick={onConfirm}>
                  {m.library_consolidation_confirm()}
                </Button>
              ) : (
                <Button disabled={busy} onClick={onNextReview}>
                  {m.library_consolidation_next_review()}
                </Button>
              )
            ) : (
              <>
                <Button
                  disabled={busy || visit.hasRetainedCommand || (result?.status !== undefined && result.status !== 'active')}
                  onClick={onApply}
                >
                  {m.library_consolidation_apply()}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || visit.hasRetainedCommand || (result?.status !== undefined && result.status !== 'active')}
                  onClick={onCancel}
                >
                  {m.library_consolidation_cancel()}
                </Button>
                <Button variant="outline" disabled={busy} onClick={onReadResult}>
                  {m.library_consolidation_result()}
                </Button>
              </>
            )}
            {visit ? (
              <Button variant="outline" disabled={busy} onClick={onReset}>
                {m.library_consolidation_new_review()}
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {m.library_selection_review_close()}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function SelectedAssignments({ picked, compact = false }: { picked: readonly ConsolidationPicked[]; compact?: boolean }) {
  return (
    <section aria-labelledby={compact ? undefined : 'consolidation-selection-heading'} className="min-w-0 space-y-3">
      {!compact ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="consolidation-selection-heading" className="text-base font-semibold">
            {m.library_selection_heading()}
          </h3>
          <span className="text-sm text-muted-foreground">{m.library_selection_count({ count: picked.length })}</span>
        </div>
      ) : null}
      <ol className="space-y-2">
        {picked.map((item) => (
          <li key={item.selected.assignmentId} className="min-w-0 rounded-md border px-3 py-2">
            <span className="h-auto block break-words font-medium">{item.title}</span>
            <code className="mt-1 block break-all text-xs text-muted-foreground">
              {item.selected.subjectId} · {item.selected.assignmentId} · {item.selected.revision}
            </code>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReviewAssignments({
  items,
  titleFor,
  sourceName,
  targetName,
  stateLabel,
}: {
  items: readonly ReviewItem[];
  titleFor(subjectId: string): string;
  sourceName: string;
  targetName: string;
  stateLabel(state: string): string;
}) {
  return (
    <section aria-labelledby="consolidation-reviewed-items-heading" className="space-y-3">
      <h4 id="consolidation-reviewed-items-heading" className="font-medium">
        {m.library_consolidation_review()}
      </h4>
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={item.selected.assignmentId} className="min-w-0 rounded-md border p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <span className="h-auto break-words font-medium">{titleFor(item.selected.subjectId)}</span>
              <span className="text-sm">{stateLabel(item.outcome)}</span>
            </div>
            <details className="mt-2 text-sm">
              <summary className="min-h-10 cursor-pointer py-2">{m.library_selection_heading()}</summary>
              <dl className="grid min-w-0 gap-x-4 gap-y-2 rounded bg-muted/50 p-3 sm:grid-cols-2">
                <EvidenceValue label={sourceName}>
                  {item.source
                    ? `${item.source.id} · ${item.source.revision} · effective=${item.source.effective}`
                    : '—'}
                </EvidenceValue>
                <EvidenceValue label={targetName}>
                  {item.target
                    ? `${item.target.id} · ${item.target.revision} · effective=${item.target.effective}`
                    : '—'}
                </EvidenceValue>
                <EvidenceValue label={item.selected.subjectId}>
                  {item.selected.assignmentId} · {item.selected.revision}
                </EvidenceValue>
              </dl>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ResultAssignments({
  items,
  status,
  titleFor,
  sourceName,
  targetName,
  stateLabel,
  busy,
  hasRetainedCommand,
  canUndo,
  csrfToken,
  isCurrent,
  locale,
  sourceLabelId,
  undoKey,
  onRetryItem,
  onUndoSubmit,
}: {
  items: readonly ResultItem[];
  status: string;
  titleFor(subjectId: string): string;
  sourceName: string;
  targetName: string;
  stateLabel(state: string): string;
  busy: boolean;
  hasRetainedCommand: boolean;
  canUndo(): boolean;
  csrfToken(): string;
  isCurrent(): boolean;
  locale: string;
  sourceLabelId: string;
  undoKey(item: ResultItem): string;
  onRetryItem(item: number): void;
  onUndoSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <section aria-labelledby="consolidation-result-items-heading" className="space-y-3">
      <h4 id="consolidation-result-items-heading" className="font-medium">
        {m.library_consolidation_result()}
      </h4>
      <p role="status">{stateLabel(status)}</p>
      <ol className="space-y-3">
        {items.map((item) => (
          <ResultAssignment
            key={item.item}
            item={item}
            title={item.selected ? titleFor(item.selected.subjectId) : m.library_subject_unavailable()}
            sourceName={sourceName}
            targetName={targetName}
            stateLabel={stateLabel}
            busy={busy}
            hasRetainedCommand={hasRetainedCommand}
            canUndo={canUndo}
            csrfToken={csrfToken}
            isCurrent={isCurrent}
            locale={locale}
            sourceLabelId={sourceLabelId}
            undoKey={undoKey(item)}
            onRetryItem={onRetryItem}
            onUndoSubmit={onUndoSubmit}
          />
        ))}
      </ol>
    </section>
  );
}

function ResultAssignment({
  item,
  title,
  sourceName,
  targetName,
  stateLabel,
  busy,
  hasRetainedCommand,
  canUndo,
  csrfToken,
  isCurrent,
  locale,
  sourceLabelId,
  undoKey,
  onRetryItem,
  onUndoSubmit,
}: {
  item: ResultItem;
  title: string;
  sourceName: string;
  targetName: string;
  stateLabel(state: string): string;
  busy: boolean;
  hasRetainedCommand: boolean;
  canUndo(): boolean;
  csrfToken(): string;
  isCurrent(): boolean;
  locale: string;
  sourceLabelId: string;
  undoKey: string;
  onRetryItem(item: number): void;
  onUndoSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <li data-consolidation-result={item.status} className="min-w-0 rounded-md border p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <span className="h-auto break-words font-medium">{title}</span>
        <span className="text-sm">{stateLabel(item.status)}</span>
      </div>
      {item.targetAssignment ? (
        <p className="mt-2 text-sm">{m.library_consolidation_destination({ name: targetName })}</p>
      ) : null}
      {item.targetUnchanged ? <p className="mt-2 text-sm">{m.library_consolidation_target_unchanged()}</p> : null}
      <details className="mt-2 text-sm">
        <summary className="min-h-10 cursor-pointer py-2">{m.library_selection_heading()}</summary>
        <dl className="grid min-w-0 gap-x-4 gap-y-2 rounded bg-muted/50 p-3 sm:grid-cols-2">
          {item.selected ? (
            <EvidenceValue label={sourceName}>
              {item.selected.subjectId} · {item.selected.assignmentId} · {item.selected.revision}
            </EvidenceValue>
          ) : null}
          {item.targetAssignment ? (
            <EvidenceValue label={targetName}>
              {item.targetAssignment.id} · {item.targetAssignment.revision}
            </EvidenceValue>
          ) : null}
          {item.sourceUnassignRevision !== undefined ? (
            <EvidenceValue label={m.library_consolidation_undo_hint()}>{String(item.sourceUnassignRevision)}</EvidenceValue>
          ) : null}
        </dl>
      </details>
      <div className="mt-3 flex flex-wrap gap-2">
        {item.status === 'processing' ? (
          <Button disabled={busy || hasRetainedCommand} onClick={() => onRetryItem(item.item)}>
            {m.library_consolidation_retry()}
          </Button>
        ) : null}
        {item.selected && item.sourceUnassignRevision !== undefined ? (
          <form
            method="post"
            action={shelfHref(locale, { label: sourceLabelId })}
            onSubmit={onUndoSubmit}
          >
            <p className="mb-2 text-sm text-muted-foreground">{m.library_consolidation_undo_hint()}</p>
            <input type="hidden" name="intent" value="restore" />
            <input type="hidden" name="subjectId" value={item.selected.subjectId} />
            <input type="hidden" name="labelId" value={sourceLabelId} />
            <input type="hidden" name="assignmentId" value={item.selected.assignmentId} />
            <input type="hidden" name="revision" value={item.sourceUnassignRevision} />
            <input type="hidden" name="idempotencyKey" value={undoKey} />
            <input type="hidden" name="csrf_token" value={csrfToken()} />
            <Button type="submit" variant="outline" disabled={busy || !canUndo() || !isCurrent()}>
              {m.library_subject_label_undo()}
            </Button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

function EvidenceValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="h-auto break-words text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all"><code>{children}</code></dd>
    </div>
  );
}
