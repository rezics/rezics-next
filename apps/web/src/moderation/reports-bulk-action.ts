import type { Report } from './reports-read';
import { createReportReviewAction, type ReportQueueAction } from './reports-view-action';
import type { ReportActionFailure } from './report-actions';

export type BulkItemState = 'unattempted' | 'pending' | 'dismissed' | 'uncertain' | ReportActionFailure;
export type BulkItem = { reportId: string; position: number; state: BulkItemState };
export type BulkSnapshot = {
  selected: readonly string[];
  items: readonly BulkItem[];
  phase: 'selecting' | 'review' | 'running' | 'complete';
  refreshing: boolean;
  retired: boolean;
  hideCards: boolean;
  stale: boolean;
};

/** One rendered native page, with no discovery, persistence or batch transport. */
export function createReportsBulkAction(reports: readonly Report[], originalIsCurrent: () => boolean = () => true) {
  const loaded = reports.slice(0, 20);
  const eligible = new Set(loaded.filter((report) => !report.outcome).map((report) => report.id));
  const bulkOwned = new Set<string>();
  const individual = new Set<string>();
  const intents = new Map<string, ReturnType<typeof createReportReviewAction>>();
  const listeners = new Set<() => void>();
  let alive = true;
  let retired = false;
  let connection = {};
  const current = () => alive && !retired && originalIsCurrent();
  let active = true;
  let busy = false;
  let operation = 0;
  let snapshot: BulkSnapshot = {
    selected: [],
    items: [],
    phase: 'selecting',
    refreshing: false,
    retired: false,
    hideCards: false,
    stale: false,
  };
  function update(patch: Partial<BulkSnapshot>) {
    if (!alive) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function itemState(reportId: string, state: BulkItemState) {
    update({ items: snapshot.items.map((item) => (item.reportId === reportId ? { ...item, state } : item)) });
  }
  function canSelect() {
    return current() && active && snapshot.phase === 'selecting';
  }
  async function send(reportId: string, action: ReportQueueAction, retry: boolean, expected: number) {
    if (!current() || !active || operation !== expected) return false;
    const intent = intents.get(reportId)!;
    itemState(reportId, 'pending');
    const result = retry ? await intent.retry(action) : await intent.submit({ action: 'dismiss', reportId }, action);
    // The private native intent may settle, but an obsolete page cannot publish or continue it.
    if (!active || !current() || operation !== expected) return false;
    itemState(reportId, result?.ok ? 'dismissed' : (result?.state ?? 'error'));
    return result?.ok === true;
  }
  async function refresh(read?: () => Promise<void>) {
    if (!current() || busy || snapshot.refreshing || !read) return;
    active = false;
    operation++;
    update({ hideCards: true, retired: true, refreshing: true, stale: false });
    try {
      await read();
    } catch {
      if (current()) update({ stale: true });
    } finally {
      if (current()) update({ refreshing: false });
    }
  }
  return {
    isCurrent: () => current() && active,
    generation: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    needsDecision: () =>
      current() &&
      snapshot.selected.some(
        (id) => !snapshot.items.some((item) => item.reportId === id && item.state === 'dismissed'),
      ),
    unresolved: () =>
      current() && snapshot.items.some((item) => item.state === 'pending' || item.state === 'uncertain'),
    selectable(reportId: string) {
      return canSelect() && eligible.has(reportId) && !individual.has(reportId) && !bulkOwned.has(reportId);
    },
    toggle(reportId: string) {
      if (!canSelect() || !eligible.has(reportId) || individual.has(reportId) || bulkOwned.has(reportId)) return;
      const selected = snapshot.selected.includes(reportId)
        ? snapshot.selected.filter((id) => id !== reportId)
        : [...snapshot.selected, reportId].slice(0, 20);
      update({ selected, items: [] });
    },
    selectLoaded() {
      if (canSelect())
        update({ selected: [...eligible].filter((id) => !individual.has(id) && !bulkOwned.has(id)), items: [] });
    },
    clear() {
      if (canSelect()) update({ selected: [], items: [] });
    },
    review() {
      if (canSelect() && snapshot.selected.length) update({ phase: 'review' });
    },
    cancel() {
      if (current() && active && snapshot.phase === 'review') update({ phase: 'selecting' });
    },
    async confirm(action: ReportQueueAction, read?: () => Promise<void>) {
      if (!current() || !active || busy || snapshot.phase !== 'review') return;
      busy = true;
      const expected = operation;
      const items = loaded.flatMap((report, index): BulkItem[] =>
        snapshot.selected.includes(report.id)
          ? [{ reportId: report.id, position: index + 1, state: 'unattempted' }]
          : [],
      );
      for (const item of items) {
        intents.set(
          item.reportId,
          createReportReviewAction(
            () => current() && active,
            () => connection,
          ),
        );
        bulkOwned.add(item.reportId);
      }
      update({ phase: 'running', items });
      try {
        for (const item of items) {
          if (!active || !current() || !(await send(item.reportId, action, false, expected))) break;
        }
      } finally {
        busy = false;
      }
      if (!active || !current() || operation !== expected) return;
      update({ phase: 'complete' });
      // Preserve a lost command for explicit exact retry before refreshing its generation away.
      if (
        snapshot.items.some((item) => item.state === 'dismissed') &&
        !snapshot.items.some((item) => item.state === 'uncertain')
      )
        await refresh(read);
    },
    async retry(reportId: string, action: ReportQueueAction, read?: () => Promise<void>) {
      if (
        !current() ||
        !active ||
        busy ||
        snapshot.phase !== 'complete' ||
        !snapshot.items.some((item) => item.reportId === reportId && item.state === 'uncertain')
      )
        return;
      busy = true;
      const expected = operation;
      update({ phase: 'running' });
      try {
        await send(reportId, action, true, expected);
      } finally {
        busy = false;
      }
      if (!active || !current() || operation !== expected) return;
      update({ phase: 'complete' });
      // Retrying never schedules unattempted items, even after a confirmed success.
      if (
        snapshot.items.some((item) => item.state === 'dismissed') &&
        !snapshot.items.some((item) => item.state === 'uncertain')
      )
        await refresh(read);
    },
    refresh,
    async read(read: () => Promise<void>) {
      if (!current()) return;
      const expected = operation + 1;
      active = false;
      operation++;
      update({ retired: true });
      await read();
      if (current() && operation === expected) {
        active = true;
        update({ retired: false });
      }
    },
    claimIndividual(reportId: string) {
      if (
        !current() ||
        !active ||
        snapshot.selected.includes(reportId) ||
        bulkOwned.has(reportId) ||
        individual.has(reportId)
      )
        return false;
      individual.add(reportId);
      update({});
      return true;
    },
    releaseIndividual(reportId: string) {
      individual.delete(reportId);
      update({});
    },
    individualBlocked(reportId: string) {
      return !current() || !active || snapshot.selected.includes(reportId) || bulkOwned.has(reportId);
    },
    leave() {
      active = false;
      operation++;
      update({ selected: [], items: [], retired: true, hideCards: true });
    },
    attach() {
      if (retired) return;
      alive = true;
      active = !snapshot.retired;
    },
    detach() {
      connection = {};
      active = false;
      alive = false;
      operation++;
    },
    retire() {
      connection = {};
      retired = true;
      active = false;
      alive = false;
      operation++;
      listeners.clear();
    },
  };
}
export type ReportsBulkAction = ReturnType<typeof createReportsBulkAction>;
