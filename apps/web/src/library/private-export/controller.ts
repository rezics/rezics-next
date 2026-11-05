import { ExportAssembly, deliverLocalFile } from './artifact';
import {
  exportCoverage,
  isExportPage,
  isExportStatus,
  isTerminalState,
  newCommandKey,
  sameExportCoverage,
  type ExportCommand,
  type ExportCoverage,
  type ExportFailure,
  type ExportFileDelivery,
  type ExportManifest,
  type ExportPage,
  type ExportPort,
  type ExportStatus,
  type ExportUnknown,
} from './contract';
import { ExportCostLedger, type ExportCostSnapshot } from './cost';
import type { ExportVisit } from './visit';

export type ExportStage =
  | 'coverage'
  | 'preparing'
  | 'capturing'
  | 'cancelling'
  | 'ready'
  | 'empty'
  | 'save-failed'
  | 'cancelled'
  | 'stale'
  | 'expired'
  | 'conflict'
  | 'limit'
  | 'denied'
  | 'unavailable';

export type ExportNotice = ExportFailure | ExportUnknown | { kind: 'saved' } | { kind: 'bytes-lost' } | null;

export type ExportJourneySnapshot = {
  stage: ExportStage;
  busy: boolean;
  notice: ExportNotice;
  exportId: string | null;
  requestKey: string;
  capturedAt: string | null;
  expiresAt: string | null;
  completeness: string | null;
  fullExport: false;
  sections: string[];
  omissions: { readonly [key: string]: string };
  pages: number;
  records: number;
  manifest: ExportManifest | null;
  hasArtifact: boolean;
  previousDisposition: ExportStage | null;
  cost: ExportCostSnapshot;
};

export function createExportJourney(input: {
  port: ExportPort;
  visit: ExportVisit;
  deliver?: ExportFileDelivery;
  onChange?: (snapshot: ExportJourneySnapshot) => void;
  now?: () => number;
}) {
  const { port, visit } = input;
  const deliver = input.deliver ?? deliverLocalFile;
  const now = input.now ?? Date.now;
  const sender = { subject: visit.subject, csrfToken: visit.csrfToken };
  const cost = new ExportCostLedger();
  const assembly = new ExportAssembly();
  let stage: ExportStage = 'coverage';
  let busy = false;
  let stop = false;
  let notice: ExportNotice = null;
  let requestKey = newCommandKey();
  let exportId: string | null = null;
  let firstCursor: string | null = null;
  let capturedAt: string | null = null;
  let expiresAt: string | null = null;
  let completeness: string | null = null;
  let sections: string[] = [];
  let omissions: { readonly [key: string]: string } = {};
  let binding: ExportCoverage | null = null;
  let manifest: ExportManifest | null = null;
  let unknown: ExportCommand | null = null;
  let previousDisposition: ExportStage | null = null;
  let generation = 0;
  let cancelWork: Promise<ExportJourneySnapshot> | null = null;

  function live(): boolean {
    return (
      visit.current() &&
      sender.subject === visit.subject &&
      sender.csrfToken === visit.csrfToken &&
      !visit.controller.signal.aborted
    );
  }

  function retain(): void {
    const artifact = assembly.current();
    cost.retain({
      recordBytes: assembly.retainedRecordBytes(),
      pageBytes: assembly.retainedPageBytes(),
      manifest,
      artifactBytes: artifact ? artifact.bytes.byteLength : 0,
    });
  }

  function snapshot(): ExportJourneySnapshot {
    if (!live()) retire();
    retain();
    const artifact = assembly.current();
    return {
      stage,
      busy,
      notice,
      exportId,
      requestKey,
      capturedAt,
      expiresAt,
      completeness,
      fullExport: false,
      sections: [...sections],
      omissions: { ...omissions },
      pages: cost.snapshot.pagesVisited,
      records: assembly.recordCount() || (artifact ? (manifest?.rows ?? 0) : 0),
      manifest,
      hasArtifact: artifact !== null,
      previousDisposition,
      cost: { ...cost.snapshot, calls: { ...cost.snapshot.calls } },
    };
  }

  function emit(): ExportJourneySnapshot {
    const current = snapshot();
    input.onChange?.(current);
    return current;
  }

  function clearBytes(): void {
    assembly.clear();
    manifest = null;
  }

  function rememberCoverage(value: ExportStatus | ExportManifest): boolean {
    const candidate = exportCoverage(value);
    if (binding && !sameExportCoverage(binding, candidate)) return false;
    const issue = assembly.bind(candidate.version);
    if (issue) return false;
    binding ??= candidate;
    exportId = candidate.exportId;
    capturedAt = candidate.capturedAt;
    expiresAt = candidate.expiresAt;
    completeness = candidate.completeness;
    sections = [...candidate.sections];
    omissions = { ...candidate.omissions };
    return true;
  }

  function enterTerminal(next: ExportStage): ExportJourneySnapshot {
    generation += 1;
    clearBytes();
    previousDisposition = next;
    stage = next;
    busy = false;
    stop = true;
    retain();
    return emit();
  }

  function expired(): boolean {
    if (!expiresAt) return false;
    const deadline = Date.parse(expiresAt);
    return !Number.isFinite(deadline) || now() >= deadline;
  }

  function expireIfNeeded(): boolean {
    if (previousDisposition === stage || !binding || !expired()) return false;
    unknown = null;
    notice = null;
    enterTerminal('expired');
    return true;
  }

  function acceptStatus(status: ExportStatus): ExportJourneySnapshot | null {
    if (!isExportStatus(status) || !rememberCoverage(status)) return enterTerminal('unavailable');
    if (isTerminalState(status.state)) return enterTerminal(status.state);
    if (!status.first) return enterTerminal('unavailable');
    if (firstCursor !== null && firstCursor !== status.first) return enterTerminal('unavailable');
    firstCursor ??= status.first;
    if (expireIfNeeded()) return snapshot();
    return null;
  }

  function applyFailure(response: ExportFailure): ExportJourneySnapshot {
    notice = response;
    if (response.kind === 'denied') return enterTerminal('denied');
    if (response.kind === 'conflict') return enterTerminal('conflict');
    if (response.kind === 'not-found') return enterTerminal('unavailable');
    if (stage === 'preparing' || stage === 'capturing' || stage === 'cancelling') return enterTerminal('unavailable');
    busy = false;
    retain();
    return emit();
  }

  async function run<T extends { kind: string }>(
    command: ExportCommand,
    send: () => Promise<T | ExportFailure | ExportUnknown>,
    retry = false,
  ): Promise<T | undefined> {
    if (!live() || (stop && command.kind !== 'cancel') || expireIfNeeded()) return;
    const token = generation;
    const response = await send().catch(() => ({ kind: 'unknown' as const, command }));
    // A command acknowledgement must not be replaced by an older capture/page observation.
    if (!live() || token !== generation) return;
    cost.recordCall(command.kind, retry);
    if (expireIfNeeded()) return;
    if (stop && command.kind !== 'cancel') return;
    if (response.kind === 'unknown') {
      unknown = command;
      notice = { kind: 'unknown', command };
      busy = false;
      retain();
      emit();
      return;
    }
    unknown = null;
    if (response.kind === 'status' || response.kind === 'page' || response.kind === 'cancelled') {
      notice = null;
      return response as T;
    }
    applyFailure(response as ExportFailure);
    return;
  }

  function acceptPage(page: ExportPage): ExportJourneySnapshot | null {
    if (!isExportPage(page) || page.exportId !== exportId || !binding) return enterTerminal('unavailable');
    if (isTerminalState(page.state)) return enterTerminal(page.state);
    if (expireIfNeeded()) return snapshot();

    const issue = assembly.addPage(page.records, binding.version);
    cost.recordPage(page);
    if (issue?.kind === 'limit') return enterTerminal('limit');
    if (issue) return enterTerminal('unavailable');

    if (page.state === 'ready') {
      if (!page.manifest || !sameExportCoverage(binding, page.manifest)) return enterTerminal('unavailable');
      const file = assembly.finalize(page.manifest);
      if ('kind' in file) return enterTerminal(file.kind === 'limit' ? 'limit' : 'unavailable');
      cost.recordFinalize(file.bytes.byteLength);
      manifest = page.manifest;
      rememberCoverage(page.manifest);
      stage = page.manifest.rows === 0 ? 'empty' : 'ready';
      busy = false;
      retain();
      return emit();
    }
    return null;
  }

  async function traverse(cursor: string, retry = false): Promise<ExportJourneySnapshot> {
    let current = cursor;
    const token = generation;
    let checkpoint = cursor;
    let checkpointPower = 1;
    let checkpointDistance = 0;
    while (current && live() && !stop && token === generation) {
      if (expireIfNeeded()) return snapshot();
      if (!exportId) return emit();
      stage = 'capturing';
      const command: Extract<ExportCommand, { kind: 'page' }> = {
        kind: 'page',
        exportId,
        cursor: current,
      };
      emit();
      const response = await run(command, () => port.page(command), retry);
      retry = false;
      if (!response || response.kind !== 'page' || !live()) return cancelWork ?? snapshot();
      if (stop || token !== generation) return cancelWork ?? snapshot();
      const finished = acceptPage(response.page);
      if (finished) return finished;
      const next = response.page.next ?? '';
      if (next) {
        checkpointDistance += 1;
        if (next === checkpoint) return enterTerminal('unavailable');
        if (checkpointDistance === checkpointPower) {
          checkpoint = next;
          checkpointPower = Math.min(checkpointPower * 2, Number.MAX_SAFE_INTEGER);
          checkpointDistance = 0;
        }
      }
      current = next;
      emit();
      await Promise.resolve();
    }
    if (stop && live()) return cancelWork ?? snapshot();
    if (stage !== 'preparing' && stage !== 'capturing') return snapshot();
    if (live() && !assembly.current()) return enterTerminal('unavailable');
    return emit();
  }

  async function capture(): Promise<ExportJourneySnapshot> {
    if (!live()) return snapshot();
    if (unknown) return snapshot();
    if (stage !== 'coverage' || busy) return snapshot();
    stop = false;
    busy = true;
    stage = 'preparing';
    notice = null;
    clearBytes();
    emit();
    const command: Extract<ExportCommand, { kind: 'create' }> = { kind: 'create', key: requestKey };
    const response = await run(command, () => port.create(command));
    if (!response || response.kind !== 'status' || !live()) return snapshot();
    const finished = acceptStatus(response.status);
    if (finished) return finished;
    return traverse(firstCursor!);
  }

  async function retryUnknown(): Promise<ExportJourneySnapshot> {
    const command = unknown;
    if (!command || !live()) return snapshot();
    if (command.kind === 'cancel') return cancel();
    if (busy || stop) return snapshot();
    if (command.kind === 'create') {
      busy = true;
      stage = 'preparing';
      emit();
      const response = await run(command, () => port.create(command), true);
      if (!response || response.kind !== 'status' || !live()) return snapshot();
      const finished = acceptStatus(response.status);
      if (finished) return finished;
      return traverse(firstCursor!);
    }
    if (command.kind === 'page') {
      busy = true;
      stage = 'capturing';
      emit();
      return traverse(command.cursor, true);
    }
    if (command.kind === 'status') return replay(true);
    return snapshot();
  }

  async function cancel(): Promise<ExportJourneySnapshot> {
    if (!live()) return snapshot();
    if (cancelWork) return cancelWork;
    if (expireIfNeeded()) return snapshot();
    const command = unknown?.kind === 'cancel' ? unknown : null;
    // Creation has no resolved identity yet; only its exact create command may be retried.
    if (!exportId || (stage !== 'capturing' && !(stage === 'cancelling' && command))) return snapshot();
    const retry = command !== null;
    const original = command ?? { kind: 'cancel' as const, exportId };
    stop = true;
    generation += 1;
    clearBytes();
    stage = 'cancelling';
    busy = true;
    notice = null;
    // Install the in-flight promise before publishing, including to synchronous subscribers.
    const work = Promise.resolve().then(async () => {
      const response = await run(original, () => port.cancel(original), retry);
      if (!response || response.kind !== 'cancelled' || !live()) return snapshot();
      if (
        !isExportStatus(response.status) ||
        !isTerminalState(response.status.state) ||
        !binding ||
        !sameExportCoverage(binding, response.status)
      )
        return enterTerminal('unavailable');
      return enterTerminal(response.status.state);
    });
    cancelWork = work.finally(() => {
      cancelWork = null;
    });
    emit();
    return cancelWork;
  }

  async function download(): Promise<ExportJourneySnapshot> {
    if (!live() || stop || busy) return snapshot();
    if (expireIfNeeded()) return snapshot();
    const file = assembly.current();
    if (!file) {
      if ((stage === 'ready' || stage === 'empty' || stage === 'save-failed') && firstCursor && exportId) {
        notice = { kind: 'bytes-lost' };
        retain();
        return emit();
      }
      return snapshot();
    }
    const token = generation;
    busy = true;
    notice = null;
    emit();
    if (!live() || token !== generation || expireIfNeeded()) return snapshot();
    let saved: boolean;
    try {
      saved = await deliver(file);
    } catch {
      if (!live() || token !== generation) return snapshot();
      if (expireIfNeeded()) return snapshot();
      busy = false;
      stage = 'save-failed';
      retain();
      return emit();
    }
    if (!live() || token !== generation) return snapshot();
    if (expireIfNeeded()) return snapshot();
    busy = false;
    if (!saved) {
      stage = 'save-failed';
      retain();
      return emit();
    }
    notice = { kind: 'saved' };
    stage = manifest?.rows === 0 ? 'empty' : 'ready';
    retain();
    return emit();
  }

  async function replay(retry = false): Promise<ExportJourneySnapshot> {
    if (!live() || !exportId || !firstCursor || busy || stop || (unknown && !retry)) return snapshot();
    if (expireIfNeeded()) return snapshot();
    stop = false;
    busy = true;
    stage = 'preparing';
    notice = null;
    clearBytes();
    emit();
    const command: Extract<ExportCommand, { kind: 'status' }> = { kind: 'status', exportId };
    const response = await run(command, () => port.status(command), retry);
    if (!response || response.kind !== 'status' || !live()) return snapshot();
    const finished = acceptStatus(response.status);
    if (finished) return finished;
    return traverse(firstCursor);
  }

  function restart(): ExportJourneySnapshot {
    if (!live()) return snapshot();
    if (busy || unknown || previousDisposition !== stage) return snapshot();
    previousDisposition = stage === 'coverage' ? previousDisposition : stage;
    generation += 1;
    stop = false;
    cancelWork = null;
    busy = false;
    notice = null;
    unknown = null;
    requestKey = newCommandKey();
    exportId = null;
    firstCursor = null;
    capturedAt = null;
    expiresAt = null;
    completeness = null;
    sections = [];
    omissions = {};
    binding = null;
    clearBytes();
    stage = 'coverage';
    retain();
    return emit();
  }

  function retire(): void {
    visit.controller.signal.removeEventListener('abort', retire);
    generation += 1;
    stop = true;
    busy = false;
    unknown = null;
    visit.retire();
    exportId = null;
    firstCursor = null;
    capturedAt = null;
    expiresAt = null;
    completeness = null;
    sections = [];
    omissions = {};
    binding = null;
    notice = null;
    clearBytes();
    stage = 'coverage';
    retain();
  }

  visit.controller.signal.addEventListener('abort', retire, { once: true });

  return {
    snapshot,
    capture,
    retryUnknown,
    cancel,
    download,
    replay,
    restart,
    retire,
    live,
    cost: () => snapshot().cost,
  };
}

export type ExportJourney = ReturnType<typeof createExportJourney>;
