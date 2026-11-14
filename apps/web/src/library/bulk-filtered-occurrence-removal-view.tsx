import { useId, useLayoutEffect, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { bulkOccurrenceRemoveResultKind } from './bulk-occurrence-remove';
import type { FilteredOccurrenceRemoval, RemovalOutcome } from './bulk-filtered-occurrence-removal';

type FocusStage = 'preview' | 'confirm' | 'read';
type FocusIntent = {
  stage: FocusStage;
  activator: HTMLElement | null;
  beforePhase: string;
  beforeRead: unknown;
};

const label = (outcome: RemovalOutcome) => {
  switch (bulkOccurrenceRemoveResultKind(outcome)) {
    case 'removed':
      return m.library_filtered_occurrence_remove_removed();
    case 'changed':
      return m.library_filtered_occurrence_remove_changed();
    case 'missing':
      return m.library_filtered_occurrence_remove_missing();
    case 'skipped':
      return m.library_filtered_occurrence_remove_skipped();
    case 'failed':
      return m.library_filtered_occurrence_remove_failed();
    case 'pending':
      return m.library_filtered_occurrence_remove_pending();
  }
};

/** Display one native manifest/result page at a time, in its supplied occurrence order. */
export function FilteredOccurrenceRemovalReview({
  journey,
  canPreview,
  canConfirm,
}: {
  journey: FilteredOccurrenceRemoval;
  canPreview: boolean;
  canConfirm: boolean;
}) {
  const id = useId();
  const { state, source, busy } = journey;
  const focusRegion = useRef<HTMLElement | null>(null);
  const focusIntent = useRef<FocusIntent | null>(null);
  const launchedIntoPreview = useRef(state.phase === 'previewing');
  useLayoutEffect(() => {
    if (!launchedIntoPreview.current) return;
    launchedIntoPreview.current = false;
    const active = document.activeElement;
    if (active === document.body || active === document.documentElement) focusRegion.current?.focus();
  }, []);
  useLayoutEffect(() => {
    const retireOnMove = (event: FocusEvent) => {
      const pending = focusIntent.current;
      const next = event.target;
      if (
        !pending ||
        !(next instanceof HTMLElement) ||
        next === document.body ||
        next === document.documentElement ||
        next === pending.activator
      )
        return;
      focusIntent.current = null;
    };
    document.addEventListener('focusin', retireOnMove);
    return () => document.removeEventListener('focusin', retireOnMove);
  }, []);
  useLayoutEffect(() => {
    const pending = focusIntent.current;
    if (!pending) return;
    if (state.phase === 'retired') {
      focusIntent.current = null;
      return;
    }
    const changed =
      pending.stage === 'read'
        ? !state.reading && state.read !== pending.beforeRead
        : pending.stage === 'confirm'
          ? state.phase !== pending.beforePhase &&
            ['confirming', 'confirmation_uncertain', 'confirmed'].includes(state.phase)
          : state.phase !== pending.beforePhase;
    if (!changed) return;
    const target = focusRegion.current;
    if (!target?.isConnected) return;
    focusIntent.current = null;
    target.focus();
  });
  const captureFocusIntent = (stage: FocusStage, activator: HTMLElement | null) => {
    focusIntent.current = {
      stage,
      activator,
      beforePhase: state.phase,
      beforeRead: state.read,
    };
  };
  if (!source || state.phase === 'retired') return null;
  const operation = state.operation;
  const read = state.read;
  const result = read?.state === 'ready' ? read : null;
  const retryPreview = ['preparing', 'unavailable', 'preview_uncertain'].includes(state.phase);
  return (
    <section
      ref={focusRegion}
      tabIndex={-1}
      className="space-y-3 rounded-xl border p-4 [overflow-wrap:anywhere]"
      aria-labelledby={`${id}-heading`}
      aria-busy={busy}
    >
      <h3 id={`${id}-heading`} className="font-medium">
        {m.library_filtered_occurrence_remove_title()}
      </h3>
      <p>{m.library_filtered_occurrence_remove_source({ title: source.title, id: source.id })}</p>
      <p className="text-sm text-muted-foreground">{m.library_filtered_occurrence_remove_scope()}</p>
      {operation ? (
        <>
          <p>{m.library_filtered_occurrence_remove_count({ count: operation.counts.targets })}</p>
          <p className="break-all text-sm">
            {m.library_filtered_occurrence_remove_capture({
              revision: operation.selectionSource!.revision,
              id: operation.id,
            })}
          </p>
          {operation.selectionSource?.filter ? (
            <pre className="whitespace-pre-wrap break-all text-xs">{operation.selectionSource.filter}</pre>
          ) : null}
          {operation.counts.targets === 0 ? <p role="status">{m.library_filtered_occurrence_remove_empty()}</p> : null}
        </>
      ) : null}
      {state.phase === 'previewing' ? <p role="status">{m.library_filtered_occurrence_remove_preparing()}</p> : null}
      {state.phase === 'preparing' ? (
        <p role="status">{m.library_filtered_occurrence_remove_source_preparing()}</p>
      ) : null}
      {state.phase === 'unavailable' ? <p role="status">{m.library_filtered_occurrence_remove_unavailable()}</p> : null}
      {state.phase === 'refused' ? <p role="alert">{m.library_filtered_occurrence_remove_refused()}</p> : null}
      {state.phase === 'preview_uncertain' ? (
        <p role="status">{m.library_filtered_occurrence_remove_preview_uncertain()}</p>
      ) : null}
      {retryPreview ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy || !canPreview}
          onClick={(event) => {
            captureFocusIntent('preview', event.currentTarget);
            void journey.preview(true);
          }}
        >
          {m.library_filtered_occurrence_remove_retry_preview()}
        </Button>
      ) : null}
      {state.phase === 'previewed' && operation && operation.counts.targets > 0 ? (
        <Button
          type="button"
          variant="destructive"
          className="min-h-11"
          disabled={busy || !canConfirm || !(Date.parse(operation.expiresAt) > Date.now())}
          onClick={(event) => {
            captureFocusIntent('confirm', event.currentTarget);
            void journey.confirm().then((ok) => {
              if (ok) void journey.read();
            });
          }}
        >
          {m.library_filtered_occurrence_remove_confirm()}
        </Button>
      ) : null}
      {state.phase === 'confirming' ? <p role="status">{m.library_filtered_occurrence_remove_confirming()}</p> : null}
      {state.phase === 'confirmation_uncertain' ? (
        <>
          <p role="status">{m.library_filtered_occurrence_remove_confirmation_uncertain()}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy || !canConfirm}
            onClick={(event) => {
              captureFocusIntent('confirm', event.currentTarget);
              void journey.confirm(true).then((ok) => {
                if (ok) void journey.read();
              });
            }}
          >
            {m.library_filtered_occurrence_remove_retry_confirmation()}
          </Button>
        </>
      ) : null}
      {operation ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={(event) => {
            captureFocusIntent('read', event.currentTarget);
            void journey.read();
          }}
        >
          {m.library_filtered_occurrence_remove_read()}
        </Button>
      ) : null}
      {state.reading ? <p role="status">{m.library_filtered_occurrence_remove_reading()}</p> : null}
      {read && read.state !== 'ready' ? (
        <p role="status">{m.library_filtered_occurrence_remove_read_failed()}</p>
      ) : null}
      {result ? (
        <>
          <ol className="space-y-2" data-filtered-occurrence-remove-results>
            {result.page.outcomes.map((outcome) => (
              <li key={outcome.ordinal} className="break-all text-sm">
                <code className="break-all">{outcome.memberId}</code>
                {' · '}
                <code className="break-all">{outcome.subjectId}</code>
                {' · '}
                {label(outcome)}
                {outcome.state === 'applied' && outcome.memberDeletion ? (
                  <p>
                    {m.library_filtered_occurrence_remove_receipt({
                      id: outcome.memberDeletion.deletionId,
                      revision: outcome.memberDeletion.revision,
                      deadline: outcome.memberDeletion.purgeAfter,
                    })}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          {result.page.next ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={(event) => {
                captureFocusIntent('read', event.currentTarget);
                void journey.read(result.page.next!);
              }}
            >
              {m.library_filtered_occurrence_remove_more()}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
