import {
  emptySelection,
  EPISODE_MUTATION_CAP,
  mutationIntent,
  type ChecklistCommand,
  type ChecklistOutcome,
  type ChecklistRow,
  type ChecklistViewerBinding,
  type ChecklistVisit,
} from './contract';
import {
  bindEpisodeCommand,
  intentFromSelection,
  submitEpisodeIntent,
  type BoundEpisodeCommand,
  type EpisodeSender,
} from './commands';

export function preparingVisit(binding: ChecklistViewerBinding | null): ChecklistVisit {
  return {
    kind: 'preparing',
    binding,
    membership: 'unavailable',
    rows: [],
    retainedNext: null,
    inspectRevision: binding?.revision ?? null,
    selection: emptySelection(),
    outcome: null,
    retry: null,
    pending: false,
    completeness: 'unavailable',
  };
}

export function readyVisit(
  binding: ChecklistViewerBinding,
  rows: ChecklistRow[],
  options: {
    membership?: ChecklistVisit['membership'];
    retainedNext?: string | null;
    completeness?: number | 'unavailable';
    inspectRevision?: number;
  } = {},
): ChecklistVisit {
  return {
    kind: rows.length ? 'ready' : 'empty',
    binding,
    membership: options.membership ?? (rows.length ? 'admitted' : 'empty'),
    rows,
    retainedNext: options.retainedNext ?? null,
    inspectRevision: options.inspectRevision ?? binding.revision,
    selection: emptySelection(),
    outcome: null,
    retry: null,
    pending: false,
    completeness: options.completeness ?? 'unavailable',
  };
}

export function unavailableVisit(
  binding: ChecklistViewerBinding | null,
  seam: string,
  kind: ChecklistVisit['kind'] = 'unavailable',
): ChecklistVisit {
  return {
    ...preparingVisit(binding),
    kind,
    seam,
  };
}

export function replaceBinding(visit: ChecklistVisit, binding: ChecklistViewerBinding | null): ChecklistVisit {
  if (!binding) return { ...preparingVisit(null), kind: 'denied' };
  const current = visit.binding;
  if (
    !current ||
    current.viewer !== binding.viewer ||
    current.sessionId !== binding.sessionId ||
    current.subjectId !== binding.subjectId ||
    current.locale !== binding.locale
  ) {
    return preparingVisit(binding);
  }
  if (current.revision !== binding.revision && visit.kind !== 'submitting') {
    return {
      ...visit,
      binding,
      kind: visit.retry ? visit.kind : 'stale',
      retainedNext: null,
    };
  }
  return { ...visit, binding };
}

function selectedSet(list: readonly string[]): Set<string> {
  return new Set(list);
}

export function toggleRow(visit: ChecklistVisit, episodeSubjectId: string, completed: boolean): ChecklistVisit {
  if (visit.kind === 'submitting' || visit.retry || !canToggle(visit, episodeSubjectId)) return visit;
  const add = selectedSet(visit.selection.add);
  const remove = selectedSet(visit.selection.remove);
  if (completed) {
    if (remove.has(episodeSubjectId)) remove.delete(episodeSubjectId);
    else remove.add(episodeSubjectId);
    add.delete(episodeSubjectId);
  } else {
    if (add.has(episodeSubjectId)) add.delete(episodeSubjectId);
    else add.add(episodeSubjectId);
    remove.delete(episodeSubjectId);
  }
  if (add.size + remove.size > EPISODE_MUTATION_CAP) return visit;
  return {
    ...visit,
    kind: visit.kind === 'accepted' ? 'ready' : visit.kind === 'empty' ? 'ready' : visit.kind,
    selection: { add: [...add], remove: [...remove] },
    outcome: visit.kind === 'review' ? null : visit.outcome,
  };
}

function canToggle(visit: ChecklistVisit, episodeSubjectId: string): boolean {
  if (visit.kind === 'denied' || visit.kind === 'retired' || visit.kind === 'preparing') return false;
  const row = visit.rows.find((item) => item.episodeSubjectId === episodeSubjectId);
  if (!row) return false;
  if (row.membership === 'unavailable' || row.completed === null) return false;
  if (!row.completed && row.membership !== 'member') return false;
  return true;
}

export function stageChecklistReview(visit: ChecklistVisit): ChecklistVisit {
  if (visit.retry) return visit;
  const intent = intentFromSelection(visit.selection.add, visit.selection.remove);
  if (!intent) return { ...visit, kind: visit.rows.length ? 'ready' : 'empty' };
  return { ...visit, kind: 'review', outcome: null };
}

export function stageChecklistClear(visit: ChecklistVisit): ChecklistVisit {
  if (visit.retry || visit.kind === 'submitting' || visit.kind === 'retired' || visit.kind === 'denied') return visit;
  return {
    ...visit,
    kind: 'review',
    selection: emptySelection(),
    outcome: null,
    pending: false,
  };
}

export function cancelChecklistReview(visit: ChecklistVisit): ChecklistVisit {
  if (visit.retry) return visit;
  return {
    ...visit,
    kind: visit.rows.length ? 'ready' : 'empty',
  };
}

export function applyChecklistOutcome(visit: ChecklistVisit, outcome: ChecklistOutcome): ChecklistVisit {
  if (outcome.state === 'acknowledged') {
    return {
      ...visit,
      kind: 'accepted',
      binding: visit.binding ? { ...visit.binding, revision: outcome.revision } : visit.binding,
      inspectRevision: outcome.revision,
      selection: emptySelection(),
      outcome,
      retry: null,
      pending: true,
    };
  }
  if (outcome.state === 'conflict') {
    return { ...visit, kind: 'conflict', outcome, retry: outcome.command, pending: false };
  }
  if (outcome.state === 'stale_cursor') {
    return { ...visit, kind: 'stale', outcome, retry: null, retainedNext: null, pending: false };
  }
  if (outcome.state === 'ambiguous') {
    return { ...visit, kind: 'ambiguous', outcome, retry: outcome.command, pending: false };
  }
  if (outcome.state === 'uncertain') {
    return { ...visit, kind: 'retry', outcome, retry: outcome.command, pending: false };
  }
  if (outcome.state === 'retired') {
    return {
      ...visit,
      kind: 'retired',
      rows: [],
      retainedNext: null,
      selection: emptySelection(),
      outcome,
      retry: outcome.command ?? visit.retry,
      pending: false,
    };
  }
  if (outcome.state === 'refused') {
    return { ...visit, kind: 'denied', outcome, retry: null, pending: false };
  }
  if (outcome.state === 'unsupported' || outcome.state === 'unavailable' || outcome.state === 'invalid') {
    const seam = outcome.state === 'unavailable' ? outcome.seam : visit.seam;
    return {
      ...visit,
      kind: 'unavailable',
      outcome,
      retry: outcome.state === 'unavailable' ? (outcome.command ?? null) : null,
      pending: false,
      ...(seam === undefined ? {} : { seam }),
    };
  }
  return visit;
}

export function applyReadback(
  visit: ChecklistVisit,
  rows: ChecklistRow[],
  revision: number,
  retainedNext: string | null,
): ChecklistVisit {
  return {
    ...visit,
    kind: rows.length ? 'ready' : 'empty',
    rows,
    inspectRevision: revision,
    binding: visit.binding ? { ...visit.binding, revision } : visit.binding,
    retainedNext,
    selection: emptySelection(),
    pending: false,
    outcome: visit.outcome?.state === 'acknowledged' ? visit.outcome : visit.outcome,
    retry: null,
  };
}

export function appendRetainedPage(
  visit: ChecklistVisit,
  rows: ChecklistRow[],
  next: string | null,
  revision: number,
): ChecklistVisit {
  if (visit.inspectRevision !== null && visit.inspectRevision !== revision) {
    return { ...visit, kind: 'stale', retainedNext: null, outcome: { state: 'stale_cursor' } };
  }
  const seen = new Set(visit.rows.map((row) => row.episodeSubjectId).filter((id): id is string => !!id));
  const extra = rows.filter((row) => !row.episodeSubjectId || !seen.has(row.episodeSubjectId));
  return {
    ...visit,
    kind: visit.rows.length || extra.length ? 'ready' : 'empty',
    rows: [...visit.rows, ...extra],
    retainedNext: next,
    inspectRevision: revision,
  };
}

export async function submitChecklistVisit(
  visit: ChecklistVisit,
  credential: HeadersInit,
  current: () => boolean,
  sender: EpisodeSender,
  key: string,
  captured?: BoundEpisodeCommand,
  clear = false,
): Promise<{ visit: ChecklistVisit; command: BoundEpisodeCommand | undefined }> {
  if (!visit.binding) return { visit: { ...visit, kind: 'denied' }, command: captured };
  const intent = clear ? { kind: 'clear' as const } : mutationIntent(visit.selection.add, visit.selection.remove);
  if (!intent) return { visit: { ...visit, kind: visit.rows.length ? 'ready' : 'empty' }, command: captured };
  const submitting: ChecklistVisit = { ...visit, kind: 'submitting', pending: true };
  const retry = visit.retry ? bindEpisodeCommand(visit.retry, sender) : captured;
  const result = await submitEpisodeIntent(
    visit.binding.sessionId,
    visit.binding.revision,
    intent,
    credential,
    current,
    sender,
    retry?.key ?? key,
    retry,
  );
  if (!current()) {
    return {
      visit: applyChecklistOutcome(submitting, { state: 'uncertain', command: result.command }),
      command: result.command,
    };
  }
  return { visit: applyChecklistOutcome(submitting, result.outcome), command: result.command };
}

export function checklistDirty(visit: ChecklistVisit): boolean {
  return visit.selection.add.length > 0 || visit.selection.remove.length > 0 || visit.kind === 'review';
}

export function checklistLocked(visit: ChecklistVisit): boolean {
  return visit.kind === 'submitting' || visit.retry !== null;
}

export function retirePrivateState(_visit: ChecklistVisit): ChecklistVisit {
  return preparingVisit(null);
}

export function matchingBinding(left: ChecklistViewerBinding, right: ChecklistViewerBinding): boolean {
  return (
    left.viewer === right.viewer &&
    left.locale === right.locale &&
    left.subjectId === right.subjectId &&
    left.sessionId === right.sessionId &&
    left.revision === right.revision &&
    (left.cursor ?? null) === (right.cursor ?? null)
  );
}

export function commandForRetry(visit: ChecklistVisit): ChecklistCommand | null {
  return visit.retry;
}
