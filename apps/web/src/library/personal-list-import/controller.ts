import {
  chunkVndbRows,
  newVndbKey,
  VNDB_ID,
  type VndbCommand,
  type VndbFailure,
  type VndbPage,
  type VndbPort,
  type VndbPreview,
  type VndbReviewInput,
  type VndbRow,
  type VndbUnknown,
} from './contract';
import type { VndbVisit } from './visit';

export type VndbStage = 'upload' | 'review' | 'confirm' | 'applying' | 'results' | 'removed';
export type VndbNotice = VndbFailure | VndbUnknown | { kind: 'file-read' } | null;
export type VndbJourneySnapshot = {
  stage: VndbStage;
  busy: boolean;
  notice: VndbNotice;
  uploadId: string | null;
  total: number;
  page: VndbPage | null;
  rows: VndbRow[];
  selection: VndbRow[];
  outcomes: { ordinal: number; reviewId: string; status: string }[];
  unattempted: number[];
  applying: number;
  applied: number;
  cancelled: boolean;
  stopped: 'cancelled' | 'deadline' | null;
  limits: VndbPreview['limits'] | null;
  sourceXML: string | null;
  sourceVisible: boolean;
};

function receiptKey(ordinal: number, reviewId: string): string {
  return `${ordinal}:${reviewId}`;
}

function sameCommand(left: VndbCommand, right: VndbCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function chooseRows(rows: VndbRow[], outcomes: Map<string, { ordinal: number; reviewId: string; status: string }>) {
  return rows
    .filter((row) => row.decision && !outcomes.has(receiptKey(row.ordinal, row.decision.reviewId)) &&
      ['reviewed', 'skipped', 'unsupported'].includes(row.decision.status))
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function createVndbJourney(input: { port: VndbPort; visit: VndbVisit }) {
  const { port, visit } = input;
  const sender = { subject: visit.subject, csrfToken: visit.csrfToken };
  let stage: VndbStage = 'upload';
  let pending = 0;
  let notice: VndbNotice = null;
  let uploadId: string | null = null;
  let total = 0;
  let page: VndbPage | null = null;
  const rows = new Map<number, VndbRow>();
  const outcomes = new Map<string, { ordinal: number; reviewId: string; status: string }>();
  let applyQueue: Extract<VndbCommand, { kind: 'apply' }>[] = [];
  let currentApply: Extract<VndbCommand, { kind: 'apply' }> | null = null;
  let unknown: VndbCommand | null = null;
  let pendingPreview: Extract<VndbCommand, { kind: 'preview' }> | null = null;
  let replacementXML: string | null = null;
  let limits: VndbPreview['limits'] | null = null;
  let cancelled = false;
  let stopped: 'cancelled' | 'deadline' | null = null;
  let stopApply = false;
  let applying = 0;
  let sourceXML: string | null = null;
  let sourceVisible = false;

  function live(): boolean {
    return visit.current() && sender.subject === visit.subject && sender.csrfToken === visit.csrfToken;
  }

  function selection(): VndbRow[] {
    return chooseRows([...rows.values()], outcomes);
  }

  function snapshot(): VndbJourneySnapshot {
    const receipts = [...outcomes.values()].sort((a, b) => a.ordinal - b.ordinal);
    const selected = [...rows.values()].sort((a, b) => a.ordinal - b.ordinal);
    const unattempted = [...rows.values()]
      .filter((row) => row.decision && !outcomes.has(receiptKey(row.ordinal, row.decision.reviewId)))
      .map((row) => row.ordinal)
      .sort((a, b) => a - b);
    return {
      stage,
      busy: pending > 0,
      notice,
      uploadId,
      total,
      page,
      rows: selected,
      selection: selection(),
      outcomes: receipts,
      unattempted,
      applying,
      applied: receipts.filter((item) => item.status === 'applied').length,
      cancelled,
      stopped,
      limits,
      sourceXML,
      sourceVisible,
    };
  }

  function clearForReplacement(): void {
    notice = null;
    uploadId = null;
    total = 0;
    page = null;
    rows.clear();
    outcomes.clear();
    applyQueue = [];
    currentApply = null;
    unknown = null;
    pendingPreview = null;
    replacementXML = null;
    limits = null;
    cancelled = false;
    stopped = null;
    stopApply = false;
    applying = 0;
    sourceXML = null;
    sourceVisible = false;
    stage = 'upload';
  }

  async function run<T extends { kind: string }>(
    command: VndbCommand,
    send: () => Promise<T | VndbFailure | VndbUnknown>,
    options: { retry?: boolean; concurrent?: boolean } = {},
  ): Promise<T | VndbFailure | VndbUnknown | undefined> {
    if (!live() || (pending > 0 && !options.concurrent) || (unknown !== null && !options.retry)) return undefined;
    pending += 1;
    let response: T | VndbFailure | VndbUnknown;
    try {
      response = await send();
    } catch {
      response = { kind: 'unknown', command };
    }
    pending -= 1;
    if (!live()) return undefined;
    if (response.kind === 'unknown') {
      unknown = response.command;
      notice = response;
      return response;
    }
    if ('status' in response) {
      if (unknown && !sameCommand(unknown, command)) {
        notice = { kind: 'unknown', command: unknown };
        return response;
      }
      unknown = null;
      notice = response;
      if (command.kind === 'preview') pendingPreview = null;
      return response;
    }
    if (unknown && !sameCommand(unknown, command)) {
      notice = { kind: 'unknown', command: unknown };
      return response;
    }
    unknown = null;
    notice = null;
    return response;
  }

  async function loadPage(offset: number, retry = false): Promise<VndbJourneySnapshot> {
    const id = uploadId;
    if (!id || !live()) return snapshot();
    const command: Extract<VndbCommand, { kind: 'page' }> = { kind: 'page', uploadId: id, offset };
    const response = await run(command, () => port.page(command), { retry });
    if (!response || response.kind !== 'page' || !live()) return snapshot();
    page = response.value;
    total = response.value.total;
    for (const row of response.value.rows) {
      const previous = rows.get(row.ordinal);
      rows.set(row.ordinal, previous ? { ...previous, ...row, decision: row.decision ?? previous.decision } : row);
    }
    cancelled = response.value.state === 'cancelled';
    if (cancelled) stage = 'results';
    else stage = 'review';
    return snapshot();
  }

  async function sendPreview(command: Extract<VndbCommand, { kind: 'preview' }>, retry = false): Promise<VndbJourneySnapshot> {
    pendingPreview = command;
    const response = await run(command, () => port.preview(command), { retry });
    if (!response || response.kind !== 'previewed' || !live()) return snapshot();
    pendingPreview = null;
    replacementXML = null;
    uploadId = response.value.uploadId;
    total = response.value.rows;
    limits = response.value.limits;
    stage = 'review';
    return loadPage(0);
  }

  async function preview(xml: string): Promise<VndbJourneySnapshot> {
    if (!live() || pending > 0 || unknown) return snapshot();
    const command: Extract<VndbCommand, { kind: 'preview' }> = { kind: 'preview', key: newVndbKey(), xml };
    pendingPreview = command;
    if (uploadId) {
      replacementXML = xml;
      const remove: Extract<VndbCommand, { kind: 'delete' }> = {
        kind: 'delete', uploadId, key: newVndbKey(),
      };
      const response = await run(remove, () => port.delete(remove));
      if (!response || response.kind !== 'deleted' || !live()) {
        if (response && response.kind !== 'unknown') {
          pendingPreview = null;
          replacementXML = null;
        }
        return snapshot();
      }
      clearForReplacement();
    }
    return sendPreview(command);
  }

  async function source(retryCommand?: Extract<VndbCommand, { kind: 'source' }>): Promise<VndbJourneySnapshot> {
    if (!uploadId || !live() || (pending > 0 && !retryCommand)) return snapshot();
    const command = retryCommand ?? { kind: 'source' as const, uploadId };
    const response = await run(command, () => port.source(command), { retry: !!retryCommand });
    if (response?.kind === 'source' && live()) {
      sourceXML = response.xml;
      sourceVisible = true;
    }
    return snapshot();
  }

  function hideSource(): VndbJourneySnapshot {
    sourceVisible = false;
    return snapshot();
  }

  async function review(body: VndbReviewInput, retryCommand?: Extract<VndbCommand, { kind: 'review' }>): Promise<VndbJourneySnapshot> {
    if (!uploadId || !live() || stage === 'applying' || (pending > 0 && !retryCommand) || (unknown && !retryCommand)) return snapshot();
    const row = rows.get(body.ordinal);
    if (!row || (row.kind === 'retained' && body.action === 'state')) return snapshot();
    if (body.action === 'state' && (!VNDB_ID.test(body.targetId) || !body.state)) return snapshot();
    const command = retryCommand ?? { kind: 'review' as const, uploadId, key: newVndbKey(), body };
    const response = await run(command, () => port.review(command), { retry: !!retryCommand });
    if (response?.kind !== 'reviewed' || !live()) return snapshot();
    const updated: VndbRow = { ...row, decision: response.value };
    rows.set(row.ordinal, updated);
    if (page) page = { ...page, rows: page.rows.map((item) => item.ordinal === row.ordinal ? updated : item) };
    return snapshot();
  }

  async function applyBatch(command: Extract<VndbCommand, { kind: 'apply' }>, retry = false): Promise<boolean> {
    if (!live()) return false;
    currentApply = command;
    applying = command.body.rows.length;
    const response = await run(command, () => port.apply(command), { retry });
    applying = 0;
    if (!response || response.kind !== 'applied' || !live()) return false;
    for (const receipt of response.value.outcomes) {
      outcomes.set(receiptKey(receipt.ordinal, receipt.reviewId), receipt);
    }
    stopped = response.value.stopped;
    if (stopped) {
      cancelled = stopped === 'cancelled';
      stage = 'results';
      return false;
    }
    const complete = response.value.outcomes.length === command.body.rows.length;
    if (!complete) {
      const held = { kind: 'unknown' as const, command };
      unknown = command;
      notice = held;
      stage = 'results';
      return false;
    }
    applyQueue.shift();
    currentApply = applyQueue[0] ?? null;
    return true;
  }

  async function continueApply(retryCommand?: Extract<VndbCommand, { kind: 'apply' }>): Promise<VndbJourneySnapshot> {
    if (!live() || stopApply) return snapshot();
    if (retryCommand) {
      const done = await applyBatch(retryCommand, true);
      if (!done) return snapshot();
    }
    while (applyQueue.length && live() && !stopApply) {
      const command = applyQueue[0]!;
      const done = await applyBatch(command);
      if (!done) break;
    }
    if (live() && !unknown) stage = cancelled ? 'results' : 'results';
    return snapshot();
  }

  function openConfirm(): VndbJourneySnapshot {
    if (stage !== 'review' || cancelled || selection().length === 0) return snapshot();
    stage = 'confirm';
    return snapshot();
  }

  function backToReview(): VndbJourneySnapshot {
    if (stage === 'applying' || !uploadId) return snapshot();
    stage = cancelled ? 'results' : 'review';
    return snapshot();
  }

  async function confirm(): Promise<VndbJourneySnapshot> {
    if (!uploadId || cancelled || !live() || stage !== 'confirm' || pending > 0) return snapshot();
    const selected = selection();
    if (!selected.length) return snapshot();
    const bodyRows = selected.map((row) => ({ ordinal: row.ordinal, reviewId: row.decision!.reviewId }));
    applyQueue = chunkVndbRows(bodyRows).map((batch) => ({ kind: 'apply', uploadId: uploadId!, body: { rows: batch } }));
    currentApply = applyQueue[0] ?? null;
    stopApply = false;
    stopped = null;
    stage = 'applying';
    return continueApply();
  }

  async function retryUnknown(): Promise<VndbJourneySnapshot> {
    const command = unknown;
    if (!command || !live() || pending > 0) return snapshot();
    if (command.kind === 'preview') return sendPreview(command, true);
    if (command.kind === 'page') return loadPage(command.offset, true);
    if (command.kind === 'source') return source(command);
    if (command.kind === 'review') return review(command.body, command);
    if (command.kind === 'apply') return continueApply(command);
    if (command.kind === 'cancel') {
      const response = await run(command, () => port.cancel(command), { retry: true, concurrent: true });
      if (response?.kind === 'cancelled') {
        cancelled = true;
        stopped = 'cancelled';
        stage = 'results';
      }
      return snapshot();
    }
    const response = await run(command, () => port.delete(command), { retry: true });
    if (response?.kind === 'deleted') {
      const xml = replacementXML;
      const next = pendingPreview;
      const receipts = [...outcomes.values()];
      clearForReplacement();
      if (xml === null) {
        receipts.forEach((receipt) => outcomes.set(receiptKey(receipt.ordinal, receipt.reviewId), receipt));
        stage = 'removed';
        return snapshot();
      }
      return sendPreview(next ?? { kind: 'preview', key: newVndbKey(), xml });
    }
    return snapshot();
  }

  async function resume(): Promise<VndbJourneySnapshot> {
    if (stopped !== 'deadline' || !currentApply || !live() || pending > 0) return snapshot();
    stopped = null;
    stage = 'applying';
    return continueApply(currentApply);
  }

  async function cancelAdmission(): Promise<VndbJourneySnapshot> {
    if (!uploadId || !live() || unknown || (pending > 0 && stage !== 'applying')) return snapshot();
    stopApply = true;
    const command: Extract<VndbCommand, { kind: 'cancel' }> = { kind: 'cancel', uploadId, key: newVndbKey() };
    const response = await run(command, () => port.cancel(command), { concurrent: true });
    if (response?.kind === 'cancelled' && live()) {
      cancelled = true;
      stopped = 'cancelled';
      stage = 'results';
    }
    return snapshot();
  }

  async function discard(): Promise<VndbJourneySnapshot> {
    const id = uploadId;
    if (!id || !live() || pending > 0 || unknown) return snapshot();
    const command: Extract<VndbCommand, { kind: 'delete' }> = { kind: 'delete', uploadId: id, key: newVndbKey() };
    const response = await run(command, () => port.delete(command));
    if (response?.kind === 'deleted' && live()) {
      const receipts = [...outcomes.values()];
      clearForReplacement();
      receipts.forEach((receipt) => outcomes.set(receiptKey(receipt.ordinal, receipt.reviewId), receipt));
      stage = 'removed';
    }
    return snapshot();
  }

  function retryVisibleSource(): Promise<VndbJourneySnapshot> {
    return unknown?.kind === 'source' ? source(unknown) : source();
  }

  function fileReadFailed(): VndbJourneySnapshot {
    notice = { kind: 'file-read' };
    return snapshot();
  }

  return {
    snapshot,
    preview,
    loadPage,
    source: retryVisibleSource,
    hideSource,
    review,
    openConfirm,
    backToReview,
    confirm,
    resume,
    retryUnknown,
    cancelAdmission,
    discard,
    fileReadFailed,
    live,
  };
}

export type VndbJourney = ReturnType<typeof createVndbJourney>;
