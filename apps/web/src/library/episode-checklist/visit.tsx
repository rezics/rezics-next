import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import type { ChecklistRow, ChecklistViewerBinding, ChecklistVisit } from './contract';
import { applyChecklistOutcome, applyReadback, appendRetainedPage, cancelChecklistReview, checklistDirty, checklistLocked, preparingVisit, replaceBinding, stageChecklistClear, stageChecklistReview, submitChecklistVisit, toggleRow } from './controller';
import { bindEpisodeCommand, outcomeFromRecord, retryOriginal, type BoundEpisodeCommand, type EpisodeSender } from './commands';
import { EpisodeChecklistEditor, EpisodeChecklistReadout, EpisodeChecklistReview } from './editor';
import { EpisodeChecklistRecovery } from './states';
import { Button } from '@rezics/ui/shadcn/button';

export type ChecklistInspect = (
  ids: readonly string[],
) => Promise<{ rows: ChecklistRow[]; revision: number } | { kind: 'unavailable' | 'retired' | 'denied' }>;
export type ChecklistContinue = (
  cursor?: string,
) => Promise<
  | { rows: ChecklistRow[]; next: string | null; revision: number }
  | { kind: 'stale' | 'unavailable' | 'retired' | 'denied' }
>;
export type ChecklistLoad = () => Promise<ChecklistVisit>;

export type EpisodeChecklistHost = {
  binding: ChecklistViewerBinding | null;
  credential: () => HeadersInit | null;
  isCurrent: () => boolean;
  onRevision?: (revision: number) => void;
  sender: EpisodeSender;
  load?: ChecklistLoad;
  inspect?: ChecklistInspect;
  continueRetained?: ChecklistContinue;
  initial?: ChecklistVisit;
  work?: { id: string; label?: string | null };
};

function focusStatus(root: HTMLElement | null, current: () => boolean, selector = '[data-checklist-status]') {
  const status = root?.querySelector<HTMLElement>(selector);
  if (status?.isConnected && current()) status.focus();
}

type VisitScope = {
  token: object;
  viewer: string | null;
  locale: string | null;
  subjectId: string | null;
  sessionId: string | null;
  revision: number | null;
  cursor: string | null;
  expectedRevision?: number;
};

type VisitActivity = { kind: 'readback' | 'continuation' | 'refresh' };

function scopeFor(binding: ChecklistViewerBinding | null): Omit<VisitScope, 'token' | 'expectedRevision'> {
  return {
    viewer: binding?.viewer ?? null,
    locale: binding?.locale ?? null,
    subjectId: binding?.subjectId ?? null,
    sessionId: binding?.sessionId ?? null,
    revision: binding?.revision ?? null,
    cursor: binding?.cursor ?? null,
  };
}

function sameScopeIdentity(left: VisitScope, right: ReturnType<typeof scopeFor>): boolean {
  return (
    left.viewer === right.viewer &&
    left.locale === right.locale &&
    left.subjectId === right.subjectId &&
    left.sessionId === right.sessionId &&
    left.cursor === right.cursor
  );
}

export function EpisodeChecklistVisit({
  binding,
  credential,
  isCurrent,
  onRevision,
  sender,
  load,
  inspect,
  continueRetained,
  initial,
  work,
}: EpisodeChecklistHost) {
  const [visit, setVisitState] = useState<ChecklistVisit>(() => initial ?? preparingVisit(binding));
  const [clearing, setClearing] = useState(false);
  const [activity, setActivity] = useState<VisitActivity | null>(null);
  const commands = useRef<BoundEpisodeCommand | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const scope = scopeFor(binding);
  const scopeRef = useRef<VisitScope | undefined>(undefined);
  const committedScope = scopeRef.current;
  const token =
    committedScope &&
    sameScopeIdentity(committedScope, scope) &&
    (committedScope.revision === scope.revision || committedScope.expectedRevision === scope.revision)
      ? committedScope.token
      : {};
  const current = () => scopeRef.current?.token === token && isCurrent();
  const activityRef = useRef<VisitActivity | null>(null);
  const visitRef = useRef(visit);
  visitRef.current = visit;
  const admittedFacts = useRef(new Map<string, { label: string | null; ordinal: string | null }>());
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  const updateVisit = useCallback(
    (next: ChecklistVisit | ((currentVisit: ChecklistVisit) => ChecklistVisit)): ChecklistVisit => {
      const value = typeof next === 'function' ? next(visitRef.current) : next;
      visitRef.current = value;
      setVisitState(value);
      return value;
    },
    [],
  );

  useLayoutEffect(() => {
    const nextScope = scopeFor(bindingRef.current);
    const previous = scopeRef.current;
    if (!previous || previous.token !== token) {
      scopeRef.current = { ...nextScope, token };
    } else if (previous.revision !== nextScope.revision) {
      previous.revision = nextScope.revision;
      delete previous.expectedRevision;
    }
  }, [token, binding?.revision]);

  function beginActivity(kind: VisitActivity['kind']): VisitActivity | null {
    if (!current() || activityRef.current) return null;
    const operation = { kind };
    activityRef.current = operation;
    setActivity(operation);
    return operation;
  }

  function activityIsCurrent(operation: VisitActivity): boolean {
    return current() && activityRef.current === operation;
  }

  function finishActivity(operation: VisitActivity) {
    if (activityRef.current !== operation) return;
    activityRef.current = null;
    setActivity(null);
  }

  useLayoutEffect(() => {
    return () => {
      scopeRef.current = undefined;
      activityRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    updateVisit((currentVisit) => {
      const nextBinding = bindingRef.current;
      const previousBinding = currentVisit.binding;
      const cursorChanged =
        previousBinding !== null &&
        nextBinding !== null &&
        previousBinding.viewer === nextBinding.viewer &&
        previousBinding.locale === nextBinding.locale &&
        previousBinding.subjectId === nextBinding.subjectId &&
        previousBinding.sessionId === nextBinding.sessionId &&
        (previousBinding.cursor ?? null) !== (nextBinding.cursor ?? null);
      const replaced = replaceBinding(currentVisit, nextBinding);
      if (currentVisit.kind === 'submitting' && replaced.kind === 'submitting') {
        return { ...replaced, kind: 'unavailable', pending: true };
      }
      if (cursorChanged && !currentVisit.retry) {
        return {
          ...replaced,
          kind: 'stale',
          retainedNext: null,
          selection: { add: [], remove: [] },
          pending: false,
        };
      }
      return replaced;
    });
    setClearing(false);
    commands.current = undefined;
    admittedFacts.current.clear();
    activityRef.current = null;
    setActivity(null);
  }, [token, updateVisit]);
  useEffect(() => {
    if (!load || visit.kind !== 'preparing' || !binding || !current()) return;
    void load().then((next) => {
      if (current()) updateVisit(next);
    });
  }, [visit.kind, binding?.sessionId, binding?.viewer, load, token, updateVisit]);
  const previousKind = useRef(visit.kind);
  useLayoutEffect(() => {
    if (previousKind.current === visit.kind) return;
    const previous = previousKind.current;
    previousKind.current = visit.kind;
    if (
      (previous === 'submitting' ||
        previous === 'accepted' ||
        previous === 'retry' ||
        previous === 'ambiguous' ||
        previous === 'conflict') &&
      (visit.kind === 'ready' || visit.kind === 'empty') &&
      visit.outcome?.state === 'acknowledged'
    ) {
      focusStatus(root.current, current, '[data-checklist-ack-status]');
    } else if (visit.kind !== 'ready' && visit.kind !== 'review' && visit.kind !== 'submitting') {
      focusStatus(root.current, current);
    }
  }, [visit.kind, visit.outcome, current]);
  useAuthoringDeparture(
    () => current() && checklistDirty(visit),
    () => current() && checklistLocked(visit),
    `${binding?.sessionId ?? ''}:${visit.kind}:${visit.selection.add.join(',')}:${visit.selection.remove.join(',')}`,
  );

  async function refresh() {
    if (!current() || !load || activityRef.current) return;
    const capturedVisit = visitRef.current;
    const operation = beginActivity('refresh');
    if (!operation) return;
    try {
      const next = await load();
      if (!activityIsCurrent(operation) || visitRef.current !== capturedVisit) return;
      commands.current = undefined;
      setClearing(false);
      admittedFacts.current.clear();
      updateVisit(next);
    } catch {
      // Keep the current facts and any admitted choices when refresh remains unknown.
    } finally {
      finishActivity(operation);
    }
  }

  async function submit(clear = false) {
    if (
      !current() ||
      activityRef.current ||
      visitRef.current.kind === 'submitting' ||
      visitRef.current.pending
    ) {
      return;
    }
    const headers = credential();
    if (!headers) return;
    const capturedVisit = visitRef.current;
    const staged = clear ? stageChecklistClear(capturedVisit) : stageChecklistReview(capturedVisit);
    updateVisit({ ...staged, kind: 'submitting', pending: true });
    const result = await submitChecklistVisit(
      staged,
      headers,
      current,
      sender,
      crypto.randomUUID(),
      commands.current,
      clear,
    );
    if (!current()) return;
    commands.current = result.command;
    if (result.visit.outcome?.state === 'acknowledged') {
      await presentAcknowledgement(result.visit, capturedVisit.rows);
    } else updateVisit(result.visit);
  }

  async function presentAcknowledgement(accepted: ChecklistVisit, rows: readonly ChecklistRow[]) {
    if (!current() || accepted.outcome?.state !== 'acknowledged') return;
    commands.current = undefined;
    admittedFacts.current.clear();
    const scopeAtAcknowledgement = scopeRef.current;
    if (scopeAtAcknowledgement?.token === token) {
      scopeAtAcknowledgement.expectedRevision = accepted.outcome.revision;
    }
    updateVisit(accepted);
    const ids = rows.map((row) => row.episodeSubjectId).filter((id): id is string => !!id);
    const operation = inspect && ids.length ? beginActivity('readback') : null;
    onRevision?.(accepted.outcome.revision);
    if (!operation || !inspect) return;
    try {
      const readback = await inspect(ids);
      if (!activityIsCurrent(operation)) return;
      if ('kind' in readback) {
        updateVisit((currentVisit) => {
          if (currentVisit.kind !== 'accepted' || currentVisit.outcome !== accepted.outcome) return currentVisit;
          if (readback.kind === 'retired')
            return { ...currentVisit, kind: 'retired', rows: [], retainedNext: null, pending: false };
          if (readback.kind === 'denied') return { ...currentVisit, kind: 'denied', pending: false };
          return {
            ...currentVisit,
            kind: 'unavailable',
            seam: 'KernelClient.progressSessions({ sessionId }).episodes.get',
            pending: false,
          };
        });
        return;
      }
      updateVisit((currentVisit) => {
        if (currentVisit.kind !== 'accepted' || currentVisit.outcome !== accepted.outcome) return currentVisit;
        admittedFacts.current.clear();
        return applyReadback(currentVisit, readback.rows, readback.revision, currentVisit.retainedNext);
      });
    } catch {
      // The acknowledgement remains visible; row completion stays pending until a known read succeeds.
    } finally {
      finishActivity(operation);
    }
  }

  async function retry() {
    if (!current() || activityRef.current) return;
    const capturedVisit = visitRef.current;
    const retryCommand = capturedVisit.retry;
    if (!retryCommand) return;
    const command = bindEpisodeCommand(retryCommand, sender);
    let result: Awaited<ReturnType<typeof retryOriginal>>;
    try {
      result = await retryOriginal(command, current);
    } catch {
      if (current() && visitRef.current === capturedVisit) {
        updateVisit(applyChecklistOutcome(capturedVisit, { state: 'uncertain', command: retryCommand }));
      }
      return;
    }
    if (!result || !current() || visitRef.current !== capturedVisit) return;
    const next = applyChecklistOutcome(capturedVisit, outcomeFromRecord(retryCommand, result));
    if (next.outcome?.state === 'acknowledged') await presentAcknowledgement(next, capturedVisit.rows);
    else updateVisit(next);
  }

  async function continuePage() {
    if (!current() || !continueRetained || activityRef.current || visitRef.current.pending) return;
    const capturedVisit = visitRef.current;
    const operation = beginActivity('continuation');
    if (!operation) return;
    try {
      const page = await continueRetained(capturedVisit.retainedNext ?? undefined);
      if (!activityIsCurrent(operation) || visitRef.current !== capturedVisit) return;
      if ('kind' in page) {
        if (page.kind === 'stale') updateVisit({ ...capturedVisit, kind: 'stale', retainedNext: null });
        else if (page.kind === 'retired')
          updateVisit({ ...capturedVisit, kind: 'retired', rows: [], retainedNext: null });
        else if (page.kind === 'denied') updateVisit({ ...capturedVisit, kind: 'denied' });
        else updateVisit({ ...capturedVisit, kind: 'unavailable' });
        return;
      }
      const appended = appendRetainedPage(capturedVisit, page.rows, page.next, page.revision);
      updateVisit(
        appended.kind === 'stale'
          ? appended
          : {
              ...appended,
              selection: {
                add: [...capturedVisit.selection.add],
                remove: [...capturedVisit.selection.remove],
              },
            },
      );
    } catch {
      // Keep the captured page and choices when continuation remains unknown.
    } finally {
      finishActivity(operation);
    }
  }

  const recovery =
    visit.kind === 'preparing' ||
    visit.kind === 'denied' ||
    visit.kind === 'unavailable' ||
    visit.kind === 'retired' ||
    visit.kind === 'stale' ||
    visit.kind === 'conflict' ||
    visit.kind === 'ambiguous' ||
    visit.kind === 'retry';
  const editingUnavailable = visit.kind === 'submitting' || visit.pending || activity !== null;

  return (
    <div ref={root} className="space-y-6">
      <EpisodeChecklistReadout visit={visit} {...(work ? { work } : {})} />
      {recovery ? (
        <EpisodeChecklistRecovery
          kind={visit.kind}
          {...(visit.seam === undefined ? {} : { seam: visit.seam })}
          onRetry={() => void retry()}
          onRefresh={() => void refresh()}
        />
      ) : null}
      {visit.kind === 'accepted' ? (
        <EpisodeChecklistRecovery kind="accepted" />
      ) : visit.outcome?.state === 'acknowledged' ? (
        <p data-checklist-ack-status role="status" aria-live="polite" className="text-sm">
          {m.library_progress_episodes_accepted()}
        </p>
      ) : null}
      {visit.kind !== 'review' && visit.kind !== 'submitting' && (visit.pending || activity) ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {m.library_progress_episodes_pending()}
        </p>
      ) : null}
      {visit.kind === 'accepted' && visit.pending && load ? (
        <Button
          type="button"
          variant="outline"
          disabled={activity !== null}
          onClick={() => void refresh()}
        >
          {m.library_progress_retry()}
        </Button>
      ) : null}
      {visit.kind === 'review' || visit.kind === 'submitting' ? (
        <EpisodeChecklistReview
          visit={visit}
          episodeFacts={admittedFacts.current}
          busy={editingUnavailable}
          clear={clearing}
          onConfirm={() => void submit(clearing)}
          onCancel={() => {
            if (current() && !activityRef.current && !visit.retry) {
              setClearing(false);
              updateVisit(cancelChecklistReview(visit));
            }
          }}
        />
      ) : visit.kind === 'ready' || visit.kind === 'empty' || visit.kind === 'accepted' ? (
        <EpisodeChecklistEditor
          visit={visit}
          busy={editingUnavailable}
          onToggle={(id, completed) => {
            if (!current() || activityRef.current || visitRef.current.pending) return;
            const row = visit.rows.find((item) => item.episodeSubjectId === id);
            updateVisit((currentVisit) => {
              const next = toggleRow(currentVisit, id, completed);
              if (next === currentVisit) return next;
              if (next.selection.add.includes(id) || next.selection.remove.includes(id)) {
                admittedFacts.current.set(id, { label: row?.label ?? null, ordinal: row?.ordinal ?? null });
              } else {
                admittedFacts.current.delete(id);
              }
              return next;
            });
          }}
          onReview={() => {
            if (current() && !activityRef.current && !visitRef.current.pending) {
              setClearing(false);
              updateVisit((currentVisit) => stageChecklistReview(currentVisit));
            }
          }}
          onClear={() => {
            if (current() && !activityRef.current && !visitRef.current.pending) {
              setClearing(true);
              admittedFacts.current.clear();
              updateVisit((currentVisit) => stageChecklistClear(currentVisit));
            }
          }}
          {...(continueRetained ? { onContinue: () => void continuePage() } : {})}
        />
      ) : null}
    </div>
  );
}
