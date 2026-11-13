import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure, StudioResult } from './contract';
import type { HostedOwnerViewer, HostedTarget } from './hosted-contract';
import type { SourceConsentReceipt, SourceConsentRequest } from './hosted-source-consent-contract';

export type SourceConsentTransport = (
  request: SourceConsentRequest,
  signal: AbortSignal,
  csrfToken: string,
) => Promise<StudioResult<SourceConsentReceipt>>;
export type SourceConsentSelection = Readonly<{ catalogueId: string; target: HostedTarget }>;
export type SourceConsentState =
  | Readonly<{ kind: 'inactive' | 'ended' }>
  | Readonly<{
      kind: 'active';
      phase: 'unknown' | 'working' | 'uncertain' | 'issued' | 'revoked' | 'denied' | 'failed';
      operation: 'issue' | 'revoke' | null;
      failure: StudioFailure['kind'] | null;
    }>;
type Options = {
  source: HistoricalReaderSource;
  viewer: HostedOwnerViewer;
  csrfToken: string;
  isCurrent(): boolean;
  native: SourceConsentTransport;
};

function sameSelection(a: SourceConsentSelection | null, b: SourceConsentSelection | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.catalogueId === b.catalogueId &&
    a.target.threadId === b.target.threadId &&
    a.target.postId === b.target.postId &&
    a.target.revisionId === b.target.revisionId &&
    a.target.sha256 === b.target.sha256
  );
}

/** One selected version and one receipt in memory. No lookup, list, URL, storage or publication side effect. */
export class HostedSourceConsentVisit {
  private state: SourceConsentState = { kind: 'inactive' };
  private selection: SourceConsentSelection | null = null;
  private receipt: SourceConsentReceipt | null = null;
  private pending: SourceConsentRequest | null = null;
  private request: AbortController | null = null;
  private retired = false;
  private readonly origin;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: Options) {
    this.origin = options.source.read();
    this.unsubscribe = options.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    if (!this.isCurrent()) this.retire();
  }
  snapshot = (): SourceConsentState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: SourceConsentState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private isCurrent = () => {
    const now = this.options.source.read();
    return (
      !this.retired &&
      this.options.isCurrent() &&
      this.origin.healthy &&
      now.healthy &&
      this.origin.csrfReady &&
      now.csrfReady &&
      this.origin.state === 'signed-in' &&
      now.state === 'signed-in' &&
      this.origin.credentialMode === 'session' &&
      now.credentialMode === 'session' &&
      this.origin.subject === this.options.viewer.accountId &&
      now.subject === this.origin.subject &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };
  private current() {
    if (!this.isCurrent()) this.retire();
    return !this.retired;
  }
  private clear() {
    this.request?.abort();
    this.request = null;
    this.pending = null;
    this.receipt = null;
    this.selection = null;
  }
  private retire() {
    if (this.retired) return;
    this.retired = true;
    this.clear();
    this.update({ kind: 'ended' });
  }
  dispose = () => {
    this.unsubscribe();
    this.retire();
  };
  /** Called synchronously by point selection, before the next render or any late command reply. */
  select = (selection: SourceConsentSelection | null) => {
    if (!this.current() || sameSelection(this.selection, selection)) return;
    this.clear();
    this.selection = selection ? { catalogueId: selection.catalogueId, target: { ...selection.target } } : null;
    this.update(
      selection ? { kind: 'active', phase: 'unknown', operation: null, failure: null } : { kind: 'inactive' },
    );
  };
  issue = async () => {
    if (!this.current() || !this.selection || this.pending || this.receipt || this.request) return;
    this.pending = {
      kind: 'issue',
      body: { catalogueId: this.selection.catalogueId, target: { ...this.selection.target } },
      expectedViewer: { ...this.options.viewer },
      idempotencyKey: crypto.randomUUID(),
    };
    await this.send();
  };
  revoke = async () => {
    if (!this.current() || !this.selection || !this.receipt || this.pending || this.request) return;
    this.pending = {
      kind: 'revoke',
      body: {
        catalogueId: this.selection.catalogueId,
        target: { ...this.selection.target },
        disclosureId: this.receipt.disclosureId,
      },
      expectedViewer: { ...this.options.viewer },
      idempotencyKey: crypto.randomUUID(),
    };
    await this.send();
  };
  replay = async () => {
    if (this.state.kind !== 'active' || this.state.phase !== 'uncertain') return;
    await this.send();
  };
  private async send() {
    if (!this.current() || !this.pending || this.request) return;
    const command = this.pending;
    const request = new AbortController();
    this.request = request;
    this.update({ kind: 'active', phase: 'working', operation: command.kind, failure: null });
    try {
      const result = await this.options.native(command, request.signal, this.options.csrfToken);
      if (!this.current() || request.signal.aborted || this.request !== request || this.pending !== command) return;
      if (!result.ok && result.error.kind === 'uncertain') {
        // A lost reply may already have committed. Only this exact command can resolve it.
        this.update({ kind: 'active', phase: 'uncertain', operation: command.kind, failure: 'uncertain' });
        return;
      }
      this.pending = null;
      if (result.ok) {
        this.receipt = command.kind === 'issue' ? result.value : null;
        this.update({ kind: 'active', phase: result.value.state, operation: command.kind, failure: null });
      } else {
        // Denial or failure is not evidence of a missing permission, nor a current issued receipt.
        this.receipt = null;
        this.update({
          kind: 'active',
          phase: result.error.kind === 'denied' ? 'denied' : 'failed',
          operation: command.kind,
          failure: result.error.kind,
        });
      }
    } finally {
      if (this.request === request) this.request = null;
    }
  }
}
