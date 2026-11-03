import { ExportAssembly, deliverLocalFile } from './artifact';
import {
  isTerminalState,
  newCommandKey,
  type ExportCommand,
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
}) {
  const { port, visit } = input;
  const deliver = input.deliver ?? deliverLocalFile;
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
      chunks: assembly.chunksView(),
      manifest,
      artifactBytes: artifact ? artifact.bytes.byteLength : 0,
    });
  }

  function snapshot(): ExportJourneySnapshot {
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
      sections,
      omissions,
      pages: cost.snapshot.pagesVisited,
      records: assembly.recordCount() || (artifact ? manifest?.rows ?? 0 : 0),
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

  function rememberCoverage(status: ExportStatus | ExportManifest): void {
    exportId = status.exportId;
    capturedAt = status.capturedAt;
    expiresAt = status.expiresAt;
    completeness = status.completeness;
    sections = [...status.sections];
    omissions = status.omissions;
  }

  function enterTerminal(next: ExportStage): ExportJourneySnapshot {
    clearBytes();
    previousDisposition = next;
    stage = next;
    busy = false;
    stop = true;
    retain();
    return emit();
  }

  function applyFailure(response: ExportFailure): ExportJourneySnapshot {
    notice = response;
    if (response.kind === 'denied') return enterTerminal('denied');
    if (response.kind === 'conflict') return enterTerminal('conflict');
    if (response.kind === 'not-found') return enterTerminal('unavailable');
    busy = false;
    if (stage === 'preparing' || stage === 'capturing') stage = 'unavailable';
    retain();
    return emit();
  }

  async function run<T extends { kind: string }>(
    command: ExportCommand,
    send: () => Promise<T | ExportFailure | ExportUnknown>,
    retry = false,
  ): Promise<T | undefined> {
    if (!live()) return;
    const response = await send();
    if (!live()) return;
    cost.recordCall(command.kind, retry);
    if (stop && command.kind !== 'cancel') return;
    if (response.kind === 'unknown') {
      unknown = (response as ExportUnknown).command;
      notice = response as ExportUnknown;
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
    if (isTerminalState(page.state)) {
      previousDisposition = page.state;
      return enterTerminal(page.state);
    }
    const limited = assembly.addPage(page.records);
    cost.recordPage(page);
    if (limited) return enterTerminal('limit');
    if (page.state === 'ready') {
      if (!page.manifest) {
        clearBytes();
        return enterTerminal('unavailable');
      }
      const file = assembly.finalize(page.manifest);
      if ('kind' in file) return enterTerminal('limit');
      cost.recordFinalize(file.bytes.byteLength);
      manifest = page.manifest;
      rememberCoverage(page.manifest);
      stage = page.manifest.rows === 0 ? 'empty' : 'ready';
      busy = false;
      retain();
      return emit();
    }
    if (!page.next) {
      clearBytes();
      return enterTerminal('unavailable');
    }
    return null;
  }

  async function traverse(cursor: string, retry = false): Promise<ExportJourneySnapshot> {
    let current = cursor;
    const token = generation;
    while (current && live() && !stop && token === generation) {
      if (!exportId) return emit();
      stage = 'capturing';
      const command: Extract<ExportCommand, { kind: 'page' }> = {
        kind: 'page',
        exportId,
        cursor: current,
      };
      const response = await run(command, () => port.page(command), retry);
      retry = false;
      if (!response || response.kind !== 'page' || !live()) return snapshot();
      if (stop || token !== generation) return cancelWork ?? snapshot();
      const finished = acceptPage(response.page);
      if (finished) return finished;
      current = response.page.next ?? '';
      emit();
      await Promise.resolve();
    }
    if (stage !== 'preparing' && stage !== 'capturing') return snapshot();
    if (stop && live()) return cancelWork ?? cancel();
    if (live() && !assembly.current()) return enterTerminal('unavailable');
    return emit();
  }

  async function capture(): Promise<ExportJourneySnapshot> {
    if (!live()) return snapshot();
    if (unknown) return retryUnknown();
    if (busy && stage !== 'coverage') return snapshot();
    stop = false;
    busy = true;
    stage = 'preparing';
    notice = null;
    clearBytes();
    emit();
    const command: Extract<ExportCommand, { kind: 'create' }> = { kind: 'create', key: requestKey };
    const response = await run(command, () => port.create(command));
    if (!response || response.kind !== 'status' || !live()) return snapshot();
    const status = response.status;
    rememberCoverage(status);
    firstCursor = status.first;
    if (isTerminalState(status.state)) return enterTerminal(status.state);
    if (!status.first) return enterTerminal('unavailable');
    return traverse(status.first);
  }

  async function retryUnknown(): Promise<ExportJourneySnapshot> {
    const command = unknown;
    if (!command || !live()) return snapshot();
    if (command.kind === 'create') {
      busy = true;
      stage = 'preparing';
      emit();
      const response = await run(command, () => port.create(command), true);
      if (!response || response.kind !== 'status' || !live()) return snapshot();
      rememberCoverage(response.status);
      firstCursor = response.status.first;
      if (isTerminalState(response.status.state)) return enterTerminal(response.status.state);
      if (!response.status.first) return enterTerminal('unavailable');
      return traverse(response.status.first);
    }
    if (command.kind === 'page') {
      busy = true;
      stage = 'capturing';
      emit();
      return traverse(command.cursor, true);
    }
    if (command.kind === 'status') return replay();
    if (command.kind === 'cancel') return cancel();
    return snapshot();
  }

  async function cancel(): Promise<ExportJourneySnapshot> {
    stop = true;
    if (cancelWork) return cancelWork;
    const id = exportId;
    if (!id || !live()) return snapshot();
    cancelWork = (async () => {
      const command: Extract<ExportCommand, { kind: 'cancel' }> = { kind: 'cancel', exportId: id };
      const response = await run(command, () => port.cancel(command));
      if (!response || response.kind !== 'cancelled' || !live()) return snapshot();
      return enterTerminal('cancelled');
    })();
    return cancelWork;
  }

  async function download(): Promise<ExportJourneySnapshot> {
    const file = assembly.current();
    if (!file || !live()) {
      if ((stage === 'ready' || stage === 'empty' || stage === 'save-failed') && firstCursor && exportId) {
        notice = { kind: 'bytes-lost' };
        retain();
        return emit();
      }
      return snapshot();
    }
    try {
      const saved = await deliver(file);
      if (!live()) return snapshot();
      if (!saved) {
        stage = 'save-failed';
        notice = null;
        retain();
        return emit();
      }
      notice = { kind: 'saved' };
      stage = manifest?.rows === 0 ? 'empty' : 'ready';
      retain();
      return emit();
    } catch {
      if (!live()) return snapshot();
      stage = 'save-failed';
      notice = null;
      retain();
      return emit();
    }
  }

  async function replay(): Promise<ExportJourneySnapshot> {
    if (!live() || !exportId || !firstCursor) return snapshot();
    stop = false;
    busy = true;
    stage = 'preparing';
    notice = null;
    clearBytes();
    emit();
    const command: Extract<ExportCommand, { kind: 'status' }> = { kind: 'status', exportId };
    const response = await run(command, () => port.status(command));
    if (!response || response.kind !== 'status' || !live()) return snapshot();
    rememberCoverage(response.status);
    if (isTerminalState(response.status.state)) return enterTerminal(response.status.state);
    if (response.status.first && response.status.first !== firstCursor) return enterTerminal('stale');
    return traverse(firstCursor);
  }

  function restart(): ExportJourneySnapshot {
    if (!live()) return snapshot();
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
    clearBytes();
    stage = 'coverage';
    retain();
    return emit();
  }

  function retire(): void {
    generation += 1;
    stop = true;
    busy = false;
    unknown = null;
    clearBytes();
    visit.retire();
  }

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
