import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { Locale } from '../paraglide/runtime.js';
import type { StudioFailure, StudioSelection, StudioResult } from './contract';
import type {
  HostedBookNative,
  HostedCommandReceipt,
  HostedOutlineWindowNative,
  HostedOwnedBook,
} from './hosted-contract';
import type { HostedDraftPicker } from './hosted-draft-picker';
import { HostedOutlineWindow } from './hosted-outline-window';

type Phase =
  | 'idle'
  | 'selecting'
  | 'preparing'
  | 'review'
  | 'submitting'
  | 'uncertain'
  | 'stale'
  | 'rejected'
  | 'acknowledged';
export type DraftCommandIntent<Request> = Readonly<{
  request: Request;
  csrfToken: string;
  session: Readonly<{ sourceId: string; generation: number; accountId: string; locale: Locale }>;
}>;
export type HostedDraftCommandState<Request, Choice> =
  | Readonly<{ kind: 'ended' }>
  | Readonly<{
      kind: 'active';
      head: string;
      outlineAddress: Readonly<{ catalogueId: string }>;
      selection: StudioSelection | null;
      title: string;
      phase: Phase;
      refreshing: boolean;
      intent: DraftCommandIntent<Request> | null;
      choice: Choice;
      receipt: HostedCommandReceipt | null;
      error: StudioFailure | null;
      outline: HostedOutlineWindow;
    }>;
export type DraftCommandTransport = HostedOutlineWindowNative & Pick<HostedBookNative, 'readOwn'>;

export type DraftCommandOptions<Request, Choice> = {
  owner: HostedOwnedBook;
  source: HistoricalReaderSource;
  locale: Locale;
  csrfToken: string;
  picker: HostedDraftPicker;
  native: DraftCommandTransport;
  choice: Choice;
  prepare(
    state: Extract<HostedDraftCommandState<Request, Choice>, { kind: 'active' }>,
    key: string,
  ): Promise<Request | null>;
  send(request: Request, signal: AbortSignal, csrf: string): Promise<StudioResult<HostedCommandReceipt>>;
  refreshed?(choice: Choice): Choice;
  selected?(choice: Choice, selection: StudioSelection, head: string): Choice;
};

/** Shared root-append/point command lifecycle: exact replay, stale refresh, receipt-only acknowledgement. */
export class HostedDraftCommandVisit<Request, Choice> {
  protected state: HostedDraftCommandState<Request, Choice>;
  private readonly origin;
  private readonly unsubscribe: () => void;
  private readonly disconnectPicker: () => void;
  private readonly listeners = new Set<() => void>();
  protected request: AbortController | null = null;
  private retired = false;

  constructor(protected readonly options: DraftCommandOptions<Request, Choice>) {
    this.origin = options.source.read();
    this.state = {
      kind: 'active',
      choice: options.choice,
      outlineAddress: { catalogueId: options.owner.item.catalogueId },
      head: options.owner.item.headRevisionId,
      selection: null,
      title: '',
      phase: 'idle',
      refreshing: false,
      intent: null,
      receipt: null,
      error: null,
      outline: this.window(options.owner.item.headRevisionId),
    };
    this.unsubscribe = options.source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
    this.disconnectPicker = options.picker.connect();
    if (!this.isCurrent()) this.retire();
  }
  get picker() {
    return this.options.picker;
  }
  snapshot = (): HostedDraftCommandState<Request, Choice> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = (): boolean => {
    const now = this.options.source.read();
    return (
      !this.retired &&
      this.origin.healthy &&
      now.healthy &&
      this.origin.state === 'signed-in' &&
      now.state === 'signed-in' &&
      this.origin.credentialMode === 'session' &&
      now.credentialMode === 'session' &&
      this.origin.csrfReady &&
      now.csrfReady &&
      this.origin.subject === this.options.owner.viewer.accountId &&
      now.subject === this.origin.subject &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };
  private window(head: string) {
    return new HostedOutlineWindow(
      this.options.native,
      this.options.source,
      this.options.owner.viewer.accountId,
      {
        catalogueId: this.options.owner.item.catalogueId,
        kind: 'structure',
        revisionId: head,
        sourceRevisionId: null,
      },
      this.isCurrent,
    );
  }
  protected update(state: HostedDraftCommandState<Request, Choice>) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private retire() {
    if (this.retired) return;
    this.retired = true;
    this.request?.abort();
    this.request = null;
    this.options.picker.dispose();
    if (this.state.kind === 'active') this.state.outline.dispose();
    this.update({ kind: 'ended' });
  }
  dispose = () => {
    this.unsubscribe();
    this.disconnectPicker();
    this.retire();
  };
  protected current(request?: AbortController): boolean {
    if (!this.isCurrent()) this.retire();
    return !this.retired && (!request || (this.request === request && !request.signal.aborted));
  }
  canEdit = (): boolean =>
    this.state.kind === 'active' &&
    !this.state.refreshing &&
    (this.state.phase === 'idle' || this.state.phase === 'review' || this.state.phase === 'rejected');

  setTitle = (title: string) => {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active') return;
    this.update({ ...this.state, title, phase: 'idle', intent: null, error: null });
  };
  select = async (postId: string): Promise<void> => {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active') return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'selecting', selection: null, title: '', intent: null, error: null });
    try {
      const opened = await this.picker.openDocument(postId, request.signal);
      if (!this.current(request)) return;
      this.update(
        opened.ok
          ? {
              ...state,
              phase: 'idle',
              selection: opened.value,
              choice: this.options.selected?.(state.choice, opened.value, state.head) ?? state.choice,
              title: opened.value.revision.title,
              intent: null,
              error: null,
            }
          : { ...state, phase: 'rejected', selection: null, title: '', intent: null, error: opened.error },
      );
    } finally {
      if (this.request === request) this.request = null;
    }
  };
  review = async (): Promise<void> => {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active') return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'preparing', error: null });
    try {
      const body = await this.options.prepare(state, crypto.randomUUID());
      if (!this.current(request)) return;
      if (!body) {
        this.update({ ...state, phase: 'idle' });
        return;
      }
      const intent: DraftCommandIntent<Request> = {
        request: body,
        csrfToken: this.options.csrfToken,
        session: {
          sourceId: this.origin.sourceId,
          generation: this.origin.generation,
          accountId: this.options.owner.viewer.accountId,
          locale: this.options.locale,
        },
      };
      this.picker.close();
      this.update({ ...state, title: state.title.trim(), phase: 'review', intent, error: null });
    } finally {
      if (this.request === request) this.request = null;
    }
  };
  cancelReview = () => {
    if (!this.current() || this.state.kind !== 'active' || this.state.phase !== 'review') return;
    this.update({ ...this.state, phase: 'idle', intent: null });
  };
  submit = async (): Promise<void> => {
    if (!this.current() || this.state.kind !== 'active') return;
    const state = this.state;
    if ((state.phase !== 'review' && state.phase !== 'uncertain') || !state.intent) return;
    const intent = state.intent;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'submitting', error: null });
    try {
      const result = await this.options.send(intent.request, request.signal, intent.csrfToken);
      if (!this.current(request)) return;
      if (!result.ok) {
        this.update({
          ...state,
          phase: result.error.kind === 'uncertain' ? 'uncertain' : result.error.kind === 'stale' ? 'stale' : 'rejected',
          error: result.error,
        });
        return;
      }
      // A receipt is final command acknowledgement, even if its separate bounded observation fails.
      state.outline.dispose();
      const outline = this.window(result.value.revisionId);
      this.update({
        ...state,
        phase: 'acknowledged',
        head: result.value.revisionId,
        receipt: result.value,
        outline,
        error: null,
      });
      await outline.load();
    } finally {
      if (this.request === request) this.request = null;
    }
  };
  refreshHead = async (): Promise<void> => {
    if (!this.current() || this.state.kind !== 'active' || this.state.phase !== 'stale' || this.state.refreshing)
      return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, refreshing: true, error: null });
    try {
      const owner = await this.options.native.readOwn(
        this.options.owner.viewer.accountId,
        this.options.owner.item.catalogueId,
        request.signal,
        this.options.owner.viewer,
      );
      if (!this.current(request)) return;
      if (!owner.ok) {
        this.update({ ...state, refreshing: false, error: owner.error });
        return;
      }
      state.outline.dispose();
      const head = owner.value.item.headRevisionId;
      const outline = this.window(head);
      this.update({
        ...state,
        head,
        outline,
        choice: this.options.refreshed?.(state.choice) ?? state.choice,
        phase: 'idle',
        refreshing: false,
        intent: null,
        error: null,
      });
      await outline.load();
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
