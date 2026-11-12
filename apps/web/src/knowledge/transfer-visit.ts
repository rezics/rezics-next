import type { KnowledgeNavigationPage, KnowledgeNavigationRequest, KnowledgeNavigationResult, KnowledgeNotebookRow, KnowledgePlacementRow } from './navigation-read';
import type { KnowledgePrivatePreparation } from './private-server';
import type { KnowledgeDocumentReceipt } from './private-knowledge';
import { sealKnowledgeCopy, type KnowledgeCopyIntent, type KnowledgeCopyReadback, type KnowledgeCopyResult, type KnowledgeExportResult, type KnowledgeTransferBinding, type KnowledgeTransferSource } from './transfer';

export type KnowledgeTransferOperations = Readonly<{
  export: (source: KnowledgeTransferSource) => Promise<KnowledgeExportResult>;
  prepare: () => Promise<KnowledgePrivatePreparation>;
  navigate: (request: KnowledgeNavigationRequest) => Promise<KnowledgeNavigationResult>;
  copy: (intent: KnowledgeCopyIntent) => Promise<KnowledgeCopyResult>;
  readback: (receipt: KnowledgeDocumentReceipt) => Promise<KnowledgeCopyReadback>;
  current: () => boolean;
  subscribeRetirement: (retire: () => void) => () => void;
}>;
export type KnowledgeTransferDownload = { save: () => void; dispose: () => void };
export type KnowledgeTransferSaver = (bytes: string, filename: string) => KnowledgeTransferDownload;
export type KnowledgeTransferSnapshot = Readonly<{
  retired: boolean;
  exportState: 'idle' | 'preparing' | 'saved' | 'save-failed' | 'unavailable';
  copyState: 'idle' | 'preparing' | 'choosing' | 'review' | 'pending' | 'uncertain' | 'conflict' | 'readback' | 'copied' | 'unavailable';
  navigationState: 'idle' | 'preparing' | 'ready' | 'changed' | 'unavailable';
  page: KnowledgeNavigationPage | null;
  notebook: KnowledgeNotebookRow | null;
  parents: readonly { placementId: string; title: string }[];
  reviewed: boolean;
  receipt: KnowledgeDocumentReceipt | null;
}>;
const initial = (): KnowledgeTransferSnapshot => ({ retired: false, exportState: 'idle', copyState: 'idle', navigationState: 'idle', page: null, notebook: null, parents: [], reviewed: false, receipt: null });

/** Local download is a request to the browser, not proof that the person saved a file. */
export const browserKnowledgeTransferSaver: KnowledgeTransferSaver = (bytes, filename) => {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
  return {
    save() {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
    },
    dispose() { URL.revokeObjectURL(url); },
  };
};

/** One admitted source and destination. The only retained pages are the two current native windows. */
export class KnowledgeTransferVisit {
  private value = initial();
  private listeners = new Set<() => void>();
  private binding: KnowledgeTransferBinding | null;
  private bytes: string | null = null;
  private download: KnowledgeTransferDownload | null = null;
  private intent: KnowledgeCopyIntent | null = null;
  private navigation: KnowledgeNavigationRequest = { kind: 'owned' };
  private generation = 0;
  private navigationSequence = 0;
  private connection = 0;
  private readingCopy = false;
  private stop: (() => void) | null = null;
  constructor(
    readonly source: KnowledgeTransferSource,
    private readonly operations: KnowledgeTransferOperations,
    private readonly saver: KnowledgeTransferSaver = browserKnowledgeTransferSaver,
    binding: KnowledgeTransferBinding | null = null,
    private readonly onSourceLost: () => void = () => {},
  ) { this.binding = binding; }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  connect() {
    const connection = ++this.connection;
    this.stop?.();
    this.stop = this.operations.subscribeRetirement(() => this.retire());
    if (!this.operations.current()) this.retire();
    return () => { queueMicrotask(() => { if (this.connection === connection) this.retire(); }); };
  }
  private publish(change: Partial<KnowledgeTransferSnapshot>) {
    this.value = { ...this.value, ...change };
    for (const listener of this.listeners) listener();
  }
  private current(generation = this.generation) {
    if (this.value.retired || generation !== this.generation) return false;
    if (!this.operations.current()) { this.retire(); return false; }
    return true;
  }
  retire = () => {
    if (this.value.retired) return;
    this.generation++;
    this.navigationSequence++;
    this.stop?.();
    this.stop = null;
    this.binding = null;
    this.bytes = null;
    this.download?.dispose();
    this.download = null;
    this.intent = null;
    this.navigation = { kind: 'owned' };
    this.publish({ ...initial(), retired: true });
  };
  private lost(state: string) {
    if (state === 'denied' || state === 'signed-out' || state === 'retired' || state === 'not-found') {
      this.retire();
      if (this.source.representation === 'public' && (state === 'not-found' || state === 'denied')) this.onSourceLost();
      return true;
    }
    return false;
  }
  async exportFresh() {
    if (!this.current() || this.value.exportState === 'preparing') return;
    const generation = this.generation;
    this.bytes = null;
    this.download?.dispose();
    this.download = null;
    this.publish({ exportState: 'preparing' });
    let result: KnowledgeExportResult;
    try { result = await this.operations.export(this.source); }
    catch { if (this.current(generation)) this.publish({ exportState: 'unavailable' }); return; }
    if (!this.current(generation)) return;
    if (result.state !== 'ready') {
      if (!this.lost(result.state)) this.publish({ exportState: 'unavailable' });
      return;
    }
    this.bytes = result.bytes;
    this.saveAgain();
  }
  saveAgain() {
    if (!this.current() || this.bytes === null) return;
    try {
      this.download ??= this.saver(this.bytes, `knowledge-${this.source.documentId}-${this.source.revisionId}.json`);
      this.download.save();
      this.publish({ exportState: 'saved' });
    } catch {
      this.publish({ exportState: 'save-failed' });
    }
  }
  async openCopy() {
    if (!this.current() || this.value.receipt || !['idle', 'unavailable'].includes(this.value.copyState)) return;
    const generation = this.generation;
    this.publish({ copyState: 'preparing' });
    if (!this.binding) {
      let result: KnowledgePrivatePreparation;
      try { result = await this.operations.prepare(); }
      catch { if (this.current(generation)) this.publish({ copyState: 'unavailable' }); return; }
      if (!this.current(generation)) return;
      if (result.state !== 'ready') {
        if (!this.lost(result.state)) this.publish({ copyState: 'unavailable' });
        return;
      }
      this.binding = { viewer: result.viewer, csrfToken: result.csrfToken, credential: result.credential };
    }
    this.publish({ copyState: 'choosing' });
    await this.readDestination({ kind: 'owned' });
  }
  private locked() { return ['pending', 'uncertain', 'readback', 'copied'].includes(this.value.copyState); }
  async readDestination(request: KnowledgeNavigationRequest) {
    if (!this.current() || !this.binding || this.locked() || this.value.navigationState === 'preparing') return;
    const generation = this.generation, sequence = ++this.navigationSequence;
    this.navigation = request;
    this.publish({ page: null, reviewed: false, navigationState: 'preparing' });
    let result: KnowledgeNavigationResult;
    try { result = await this.operations.navigate(request); }
    catch { if (this.current(generation) && sequence === this.navigationSequence) this.publish({ navigationState: 'unavailable' }); return; }
    if (!this.current(generation) || sequence !== this.navigationSequence) return;
    if (result.state !== 'ready') {
      if (!this.lost(result.state)) this.publish({ navigationState: result.state === 'changed' ? 'changed' : 'unavailable' });
      return;
    }
    this.publish({ page: result.page, navigationState: 'ready' });
  }
  chooseNotebook(row: KnowledgeNotebookRow) {
    if (!this.current() || this.locked() || this.value.navigationState === 'preparing') return;
    this.publish({ notebook: row, parents: [], copyState: 'choosing' });
    void this.readDestination({ kind: 'outline', notebookId: row.notebookId, parentPlacementId: null });
  }
  owned() {
    if (!this.current() || this.locked() || this.value.navigationState === 'preparing') return;
    this.publish({ notebook: null, parents: [], copyState: 'choosing' });
    void this.readDestination({ kind: 'owned' });
  }
  descend(row: KnowledgePlacementRow) {
    const notebook = this.value.notebook;
    if (!this.current() || !notebook || this.locked() || this.value.navigationState === 'preparing') return;
    this.publish({ parents: [...this.value.parents, { placementId: row.placementId, title: row.title }], copyState: 'choosing' });
    void this.readDestination({ kind: 'outline', notebookId: notebook.notebookId, parentPlacementId: row.placementId });
  }
  up(root = false) {
    const notebook = this.value.notebook;
    if (!this.current() || !notebook || this.locked() || this.value.navigationState === 'preparing') return;
    const parents = root ? [] : this.value.parents.slice(0, -1);
    this.publish({ parents, copyState: 'choosing' });
    void this.readDestination({ kind: 'outline', notebookId: notebook.notebookId, parentPlacementId: parents.at(-1)?.placementId ?? null });
  }
  more() {
    if (!this.current() || !this.value.page?.next) return;
    void this.readDestination({ ...this.navigation, cursor: this.value.page.next });
  }
  refresh() {
    if (!this.current() || this.locked()) return;
    this.intent = null;
    this.publish({ copyState: 'choosing', reviewed: false });
    const { cursor: _cursor, ...address } = this.navigation;
    void this.readDestination(address);
  }
  retryNavigation() { void this.readDestination(this.navigation); }
  review() {
    if (!this.current() || this.locked() || this.value.navigationState !== 'ready' || this.value.page?.kind !== 'outline') return;
    this.publish({ copyState: 'review', reviewed: true });
  }
  confirm() {
    if (!this.current() || !this.binding || !this.value.notebook || !this.value.reviewed || this.value.copyState !== 'review' || this.value.page?.kind !== 'outline') return;
    this.intent = sealKnowledgeCopy({ source: this.source, notebookId: this.value.notebook.notebookId,
      expectedStructureRevisionId: this.value.page.structureRevisionId, parentPlacementId: this.value.page.parentPlacementId,
      binding: this.binding });
    void this.send();
  }
  retryCopy() { if (this.current() && this.value.copyState === 'uncertain') void this.send(); }
  private async send() {
    if (!this.current() || !this.intent || this.value.copyState === 'pending') return;
    const generation = this.generation, intent = this.intent;
    this.publish({ copyState: 'pending' });
    let result: KnowledgeCopyResult;
    try { result = await this.operations.copy(intent); }
    catch { if (this.current(generation)) this.publish({ copyState: 'uncertain' }); return; }
    if (!this.current(generation)) return;
    if (result.state === 'acknowledged') {
      this.intent = null;
      this.publish({ receipt: result.receipt, copyState: 'readback' });
      await this.readCopied();
    } else if (result.state === 'uncertain') this.publish({ copyState: 'uncertain' });
    else if (result.state === 'conflict') {
      this.intent = null;
      this.publish({ copyState: 'conflict', reviewed: false });
    } else if (!this.lost(result.state)) {
      this.intent = null;
      this.publish({ copyState: 'unavailable', reviewed: false });
    }
  }
  async readCopied() {
    const receipt = this.value.receipt;
    if (!this.current() || !receipt || this.value.copyState === 'copied' || this.readingCopy) return;
    this.readingCopy = true;
    const generation = this.generation;
    this.publish({ copyState: 'readback' });
    let result: KnowledgeCopyReadback;
    try { result = await this.operations.readback(receipt); }
    catch { this.readingCopy = false; if (this.current(generation)) this.publish({ copyState: 'unavailable' }); return; }
    this.readingCopy = false;
    if (!this.current(generation)) return;
    if (result.state === 'ready') this.publish({ copyState: 'copied' });
    else if (!this.lost(result.state)) this.publish({ copyState: 'unavailable' });
  }
}
