import type { QueryClient } from '@tanstack/react-query';
import { createModerationIntent } from './command-intent';
import type { CatalogueReportActionInput, CatalogueReportActionResult, CatalogueReportCommand } from './catalogue-reports-actions';
import {
  catalogueReportsReadKey,
  type CatalogueReport,
  type CatalogueReportInput,
  type CatalogueReportsRead,
  type CatalogueReportsReader,
  type CatalogueSubjectRead,
  type CatalogueSubjectReader,
} from './catalogue-reports-read';
import { createPrivateReaderLifetime } from './private-reader-lifetime';

export type CatalogueReportsPageState =
  | { state: 'loading'; reports: []; next: null }
  | { state: 'denied'; reports: []; next: null }
  | { state: 'error'; reports: []; next: null }
  | { state: 'stale'; reports: []; next: null }
  | {
      state: 'loaded';
      reports: CatalogueReport[];
      next: string | null;
      selectedId: string | null;
      subject: CatalogueSubjectState;
      reason: string;
      action: CatalogueReportsActionState;
    };
export type CatalogueSubjectState =
  | { state: 'idle' | 'loading' | 'unavailable' | 'error' }
  | { state: 'loaded'; subject: { id: string; label: string; description: string | null; type: string } }
  | { state: 'changed'; visibility: 'visible' | 'hidden' | 'taken_down' };
export type CatalogueReportsActionState =
  | { state: 'idle' | 'sending' | 'invalid' }
  | { state: 'uncertain' }
  | { state: 'failed'; reason: Exclude<CatalogueReportActionResult, { ok: true }>['state'] }
  | { state: 'confirmed'; result: Extract<CatalogueReportActionResult, { ok: true }>['result'] };

export type CatalogueReportsJourneyOptions = {
  cache: QueryClient;
  initial: CatalogueReportsRead;
  readPage: CatalogueReportsReader;
  readSubject: CatalogueSubjectReader;
  action: CatalogueReportCommand;
};

/** One private catalogue visit owns its report evidence, selected target, and exact pending command. */
export function createCatalogueReportsJourney({ cache, initial, readPage, readSubject, action }: CatalogueReportsJourneyOptions) {
  const owner = createPrivateReaderLifetime(cache, initial, catalogueReportsReadKey(initial.cursor ?? undefined));
  let result = initial.result;
  let reports = initial.result.state === 'loaded' ? initial.result.reports : [];
  let next = initial.result.state === 'loaded' ? initial.result.next : null;
  let selectedId = reports[0]?.id ?? null;
  let subject: CatalogueSubjectState = { state: 'idle' };
  let reason = '';
  let actionState: CatalogueReportsActionState = { state: 'idle' };
  let command: CatalogueReportActionInput | null = null;
  let pageGeneration = 0;
  let subjectGeneration = 0;
  let actionGeneration = 0;
  let retired = false;
  const identity = createModerationIntent();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const erase = () => {
    if (retired) return;
    retired = true;
    pageGeneration++;
    subjectGeneration++;
    actionGeneration++;
    reports = [];
    next = null;
    selectedId = null;
    subject = { state: 'idle' };
    reason = '';
    command = null;
    actionState = { state: 'idle' };
    result = { state: 'denied', reports: [], next: null };
    identity.changed();
    publish();
  };
  const ownerUnsubscribe = owner.subscribe(() => {
    if (!owner.healthy()) erase();
    else publish();
  });

  function snapshot(): CatalogueReportsPageState {
    if (retired || !owner.healthy()) return { state: 'denied', reports: [], next: null };
    if (result.state === 'loaded' && !owner.available()) return { state: 'loading', reports: [], next: null };
    if (result.state !== 'loaded') return { state: result.state, reports: [], next: null };
    return { state: 'loaded', reports, next, selectedId, subject, reason, action: actionState };
  }

  function clearPage(nextResult: CatalogueReportsRead['result']) {
    result = nextResult;
    reports = nextResult.state === 'loaded' ? nextResult.reports : [];
    next = nextResult.state === 'loaded' ? nextResult.next : null;
    selectedId = reports[0]?.id ?? null;
    subject = { state: 'idle' };
    reason = '';
    command = null;
    actionState = { state: 'idle' };
    identity.changed();
    publish();
    if (selectedId) void select(selectedId);
  }

  async function select(reportId: string) {
    if (!owner.isCurrent()) return;
    const report = reports.find((item) => item.id === reportId);
    if (!report) return;
    const attempt = ++subjectGeneration;
    const ticket = owner.ticket();
    selectedId = reportId;
    subject = { state: 'loading' };
    reason = '';
    command = null;
    actionState = { state: 'idle' };
    identity.changed();
    publish();
    try {
      const current = await readSubject(report.target.id, report.id);
      if (!owner.owns(ticket) || attempt !== subjectGeneration) return;
      if (current.subjectId !== report.target.id || !(await owner.accepts(current))) return owner.retire();
      if (current.result.state === 'loaded' && current.result.report) {
        const fresh = current.result.report;
        reports = reports.map((item) =>
          item.id === fresh.id ? { ...item, outcome: fresh.outcome, resolvedAt: fresh.resolvedAt } : item,
        );
      }
      subject = current.result;
    } catch {
      if (owner.owns(ticket) && attempt === subjectGeneration) subject = { state: 'error' };
    }
    if (owner.owns(ticket) && attempt === subjectGeneration) publish();
  }

  async function reload(cursor = initial.cursor ?? undefined) {
    if (!owner.isCurrent() || actionState.state === 'sending' || actionState.state === 'uncertain') return;
    const attempt = ++pageGeneration;
    const ticket = owner.ticket();
    subjectGeneration++;
    selectedId = null;
    subject = { state: 'idle' };
    reason = '';
    actionState = { state: 'idle' };
    command = null;
    result = { state: 'error', reports: [], next: null };
    reports = [];
    next = null;
    publish();
    try {
      const page = await readPage(cursor ? { cursor } : {});
      if (!owner.owns(ticket) || attempt !== pageGeneration) return;
      if (page.cursor !== (cursor ?? null) || !(await owner.accepts(page))) return owner.retire();
      clearPage(page.result);
    } catch {
      if (owner.owns(ticket) && attempt === pageGeneration) {
        result = { state: 'error', reports: [], next: null };
        publish();
      }
    }
  }

  async function send(input: CatalogueReportActionInput) {
    const ticket = owner.ticket();
    const attempt = ++actionGeneration;
    actionState = { state: 'sending' };
    publish();
    let outcome: CatalogueReportActionResult;
    try {
      outcome = await action(input);
    } catch {
      outcome = { ok: false, state: 'uncertain' };
    }
    if (!owner.owns(ticket) || attempt !== actionGeneration) return;
    if (outcome.ok) {
      const result = outcome.result;
      if (result.kind === 'dismissed' && result.reportId === input.reportId) {
        reports = reports.map((report) =>
          report.id === input.reportId ? { ...report, outcome: result.outcome } : report,
        );
        actionState = { state: 'confirmed', result };
      } else if (result.kind === 'visibility' && result.subjectId === input.subjectId) {
        subject = { state: 'changed', visibility: result.visibility };
        actionState = { state: 'confirmed', result };
      } else {
        actionState = { state: 'failed', reason: 'error' };
      }
      command = null;
      identity.changed();
    } else if (outcome.state === 'uncertain') {
      actionState = { state: 'uncertain' };
      command = input;
    } else {
      actionState = { state: 'failed', reason: outcome.state };
      command = null;
    }
    publish();
  }

  return {
    snapshot,
    serverSnapshot: () =>
      !initial.readerBinding?.retired && initial.readerOrigin && initial.result.state === 'loaded'
        ? {
            state: 'loaded' as const,
            reports: initial.result.reports,
            next: initial.result.next,
            selectedId: initial.result.reports[0]?.id ?? null,
            subject: { state: 'idle' as const },
            reason: '',
            action: { state: 'idle' as const },
          }
        : { state: 'loading' as const, reports: [], next: null },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retire() {
      owner.retire();
      ownerUnsubscribe();
      erase();
    },
    isCurrent: () => !retired && owner.isCurrent(),
    select,
    retryPage: () => reload(initial.cursor ?? undefined),
    refresh: () => reload(initial.cursor ?? undefined),
    retrySubject: () => (selectedId ? select(selectedId) : Promise.resolve()),
    changeReason(value: string) {
      if (retired || actionState.state === 'sending' || actionState.state === 'uncertain' || actionState.state === 'confirmed' || actionState.state === 'failed') return;
      reason = value;
      identity.changed();
      actionState = { state: 'idle' };
      publish();
    },
    act(actionName: 'dismiss' | 'hide' | 'restore') {
      if (!owner.isCurrent() || retired || actionState.state === 'sending' || actionState.state === 'uncertain' || actionState.state === 'confirmed' || actionState.state === 'failed') return;
      const report = reports.find((item) => item.id === selectedId);
      if (!report || (actionName !== 'restore' && report.outcome !== null)) return;
      if (actionName === 'hide' && subject.state !== 'loaded') return;
      if (actionName !== 'dismiss' && (!reason.trim() || Array.from(reason.trim()).length > 1024)) {
        actionState = { state: 'invalid' };
        publish();
        return;
      }
      const intent = {
        action: actionName,
        reportId: report.id,
        subjectId: report.target.id,
        ...(actionName === 'dismiss' ? {} : { reason: reason.trim() }),
      };
      const idempotencyKey = identity.keyFor(intent);
      command = Object.freeze({ ...intent, idempotencyKey }) as CatalogueReportActionInput;
      void send(command);
    },
    retryAction() {
      if (!owner.isCurrent() || actionState.state !== 'uncertain' || !command) return;
      void send(command);
    },
  };
}
