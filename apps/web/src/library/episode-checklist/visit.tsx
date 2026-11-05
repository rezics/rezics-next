import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
import type { ChecklistViewerBinding, ChecklistVisit } from './contract';
import {
  applyChecklistOutcome,
  applyReadback,
  appendRetainedPage,
  cancelChecklistReview,
  checklistDirty,
  checklistLocked,
  preparingVisit,
  replaceBinding,
  stageChecklistClear,
  stageChecklistReview,
  submitChecklistVisit,
  toggleRow,
} from './controller';
import {
  bindEpisodeCommand,
  outcomeFromRecord,
  retryOriginal,
  type BoundEpisodeCommand,
  type EpisodeSender,
} from './commands';
import { EpisodeChecklistEditor, EpisodeChecklistReadout, EpisodeChecklistReview } from './editor';
import { EpisodeChecklistRecovery } from './states';
import type { ChecklistRow } from './contract';

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

function focusStatus(root: HTMLElement | null) {
  const status = root?.querySelector<HTMLElement>('[data-checklist-status]');
  status?.focus();
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
  const [visit, setVisit] = useState<ChecklistVisit>(() => initial ?? preparingVisit(binding));
  const [clearing, setClearing] = useState(false);
  const commands = useRef<BoundEpisodeCommand | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const token = {};
  const rendered = useRef(token);
  rendered.current = token;
  const current = () => rendered.current === token && isCurrent();
  useLayoutEffect(() => {
    return () => {
      rendered.current = {};
    };
  }, []);
  useEffect(() => {
    setVisit((currentVisit) => replaceBinding(currentVisit, binding));
    setClearing(false);
    commands.current = undefined;
  }, [binding?.viewer, binding?.sessionId, binding?.subjectId, binding?.locale, binding?.revision, binding?.cursor]);
  useEffect(() => {
    if (!load || visit.kind !== 'preparing' || !binding || !current()) return;
    void load().then((next) => {
      if (current()) setVisit(next);
    });
  }, [visit.kind, binding?.sessionId, binding?.viewer, load]);
  useLayoutEffect(() => {
    if (visit.kind !== 'ready' && visit.kind !== 'review' && visit.kind !== 'submitting') focusStatus(root.current);
  }, [visit.kind]);
  useAuthoringDeparture(
    () => current() && checklistDirty(visit),
    () => current() && checklistLocked(visit),
    `${binding?.sessionId ?? ''}:${visit.kind}:${visit.selection.add.join(',')}:${visit.selection.remove.join(',')}`,
  );

  async function refresh() {
    if (!current() || !load) return;
    const next = await load();
    if (current()) {
      commands.current = undefined;
      setClearing(false);
      setVisit(next);
    }
  }

  async function submit(clear = false) {
    if (!current() || visit.kind === 'submitting') return;
    const headers = credential();
    if (!headers) return;
    const staged = clear ? stageChecklistClear(visit) : stageChecklistReview(visit);
    setVisit({ ...staged, kind: 'submitting' });
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
    setVisit(result.visit);
    if (result.visit.outcome?.state === 'acknowledged') {
      onRevision?.(result.visit.binding?.revision ?? staged.binding?.revision ?? 0);
      const ids = visit.rows.map((row) => row.episodeSubjectId).filter((id): id is string => !!id);
      if (inspect && ids.length) {
        const readback = await inspect(ids);
        if (!current()) return;
        if ('kind' in readback) {
          setVisit((currentVisit) => {
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
        setVisit((currentVisit) =>
          applyReadback(currentVisit, readback.rows, readback.revision, currentVisit.retainedNext),
        );
      }
    }
  }

  async function retry() {
    if (!current() || !visit.retry) return;
    const command = bindEpisodeCommand(visit.retry, sender);
    try {
      const result = await retryOriginal(command, current);
      if (!result || !current()) return;
      setVisit(applyChecklistOutcome(visit, outcomeFromRecord(visit.retry, result)));
    } catch {
      if (current()) setVisit(applyChecklistOutcome(visit, { state: 'uncertain', command: visit.retry }));
    }
  }

  async function continuePage() {
    if (!current() || !continueRetained) return;
    const page = await continueRetained(visit.retainedNext ?? undefined);
    if (!current()) return;
    if ('kind' in page) {
      if (page.kind === 'stale') setVisit({ ...visit, kind: 'stale', retainedNext: null });
      else if (page.kind === 'retired') setVisit({ ...visit, kind: 'retired', rows: [], retainedNext: null });
      else if (page.kind === 'denied') setVisit({ ...visit, kind: 'denied' });
      else setVisit({ ...visit, kind: 'unavailable' });
      return;
    }
    setVisit(appendRetainedPage(visit, page.rows, page.next, page.revision));
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
      {visit.kind === 'accepted' ? <EpisodeChecklistRecovery kind="accepted" /> : null}
      {visit.kind === 'review' || visit.kind === 'submitting' ? (
        <EpisodeChecklistReview
          visit={visit}
          busy={visit.kind === 'submitting'}
          clear={clearing}
          onConfirm={() => void submit(clearing)}
          onCancel={() => {
            if (current() && !visit.retry) {
              setClearing(false);
              setVisit(cancelChecklistReview(visit));
            }
          }}
        />
      ) : visit.kind === 'ready' || visit.kind === 'empty' || visit.kind === 'accepted' ? (
        <EpisodeChecklistEditor
          visit={visit}
          busy={false}
          onToggle={(id, completed) => current() && setVisit(toggleRow(visit, id, completed))}
          onReview={() => {
            if (current()) {
              setClearing(false);
              setVisit(stageChecklistReview(visit));
            }
          }}
          onClear={() => {
            if (current()) {
              setClearing(true);
              setVisit(stageChecklistClear(visit));
            }
          }}
          {...(continueRetained ? { onContinue: () => void continuePage() } : {})}
        />
      ) : null}
    </div>
  );
}
