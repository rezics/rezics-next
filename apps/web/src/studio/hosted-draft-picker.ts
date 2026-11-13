import { serializeDocument } from '@rezics/document';
import { readSelectedOwnDraft, type OwnDraftEntry, type OwnDraftReader } from '../threads';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { ExactDocument, StudioResult, StudioSelection } from './contract';
import type { HostedOwnerViewer, HostedTarget } from './hosted-contract';

type ReadFailure = 'unavailable' | 'denied' | 'concealed' | 'stale';
type PickerPage = Readonly<{
  cursor: string | null;
  rows: readonly OwnDraftEntry[];
  next: string | null;
  preparing: boolean;
}>;
export type HostedDraftPickerState =
  | Readonly<{ kind: 'closed' | 'ended' }>
  | Readonly<{ kind: 'loading'; cursor: string | null }>
  | Readonly<{ kind: 'failed'; cursor: string | null; error: ReadFailure }>
  | Readonly<{ kind: 'page'; page: PickerPage; selecting: string | null; error: ReadFailure | null }>;

export type HostedDraftPickerBinding = Readonly<{
  viewer: HostedOwnerViewer;
  source: HistoricalReaderSource;
  reader: OwnDraftReader;
  locale: Locale;
  isCurrent(): boolean;
  /** The existing exact Post port verifies owner, current revision and body digest. */
  readDocument(postId: string, signal: AbortSignal): Promise<StudioResult<StudioSelection>>;
}>;

export function hostedDraftPickerMessage(error: ReadFailure, locale: Locale): string {
  if (error === 'denied') return m.own_drafts_denied({}, { locale });
  if (error === 'stale') return m.own_drafts_stale_selection({}, { locale });
  if (error === 'concealed') return m.own_drafts_selection_unavailable({}, { locale });
  return m.own_drafts_unavailable({}, { locale });
}

function refused(error: ReadFailure, locale: Locale): StudioResult<never> {
  return {
    ok: false,
    error: { kind: error === 'concealed' ? 'withdrawn' : error, message: hostedDraftPickerMessage(error, locale) },
  };
}

/** One explicitly opened metadata page and one selected admission; never a second document store. */
export class HostedDraftPicker {
  private state: HostedDraftPickerState = { kind: 'closed' };
  private readonly origin;
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private readingPost: string | null = null;
  private candidate: { postId: string; threadId: string } | null = null;
  private retired = false;

  constructor(private readonly binding: HostedDraftPickerBinding) {
    this.origin = binding.source.read();
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: HostedDraftPickerState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  isCurrent = (): boolean => {
    const now = this.binding.source.read();
    return (
      !this.retired &&
      this.binding.isCurrent() &&
      this.origin.healthy &&
      this.origin.state === 'signed-in' &&
      this.origin.subject === this.binding.viewer.accountId &&
      now.healthy &&
      now.state === 'signed-in' &&
      now.subject === this.binding.viewer.accountId &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };
  connect = () => {
    const stop = this.binding.source.subscribe(() => {
      if (!this.isCurrent()) this.dispose();
    });
    if (!this.isCurrent()) this.dispose();
    return stop;
  };
  dispose = () => {
    this.retired = true;
    this.request?.abort();
    this.request = null;
    this.readingPost = null;
    this.candidate = null;
    this.update({ kind: 'ended' });
  };
  close = () => {
    this.request?.abort();
    this.request = null;
    this.readingPost = null;
    if (!this.retired) this.update({ kind: 'closed' });
  };
  open = async () => {
    if (this.state.kind === 'closed') await this.load(null);
  };
  next = async () => {
    if (this.state.kind === 'page' && this.state.page.next && !this.state.selecting)
      await this.load(this.state.page.next);
  };
  retry = async () => {
    if (this.state.kind === 'failed') await this.load(this.state.cursor);
  };
  restart = async () => {
    if (this.state.kind !== 'closed' && this.state.kind !== 'ended') await this.load(null);
  };

  canSelect = (entry: OwnDraftEntry) =>
    entry.authorId === this.binding.viewer.accountId && entry.kind === 'discussion' && entry.documentKind === 'opening';
  hasEntry = (postId: string): boolean =>
    this.state.kind === 'page' && this.state.page.rows.some((entry) => entry.id === postId);
  /** Temporary read admission exists only after exact account resume succeeded. */
  admitsPost = (postId: string): boolean =>
    this.isCurrent() && (this.readingPost === postId || this.candidate?.postId === postId);
  retainSelection = (selection: StudioSelection | null) => {
    // These are the editor's already admitted selections, including an attached chapter removed while open.
    this.candidate = selection?.native
      ? { postId: selection.revision.exact.postId, threadId: selection.native.threadId }
      : null;
  };
  target = (document: ExactDocument): HostedTarget | null =>
    this.isCurrent() && this.candidate?.postId === document.postId
      ? { ...document, threadId: this.candidate.threadId }
      : null;

  private async load(cursor: string | null) {
    if (!this.isCurrent()) return this.dispose();
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    // Replacing the page retires every former row and action before any asynchronous work.
    this.update({ kind: 'loading', cursor });
    try {
      const page = await this.binding.reader.list(
        { ...this.binding.viewer, ...(cursor === null ? {} : { cursor }) },
        request.signal,
      );
      if (!this.currentRequest(request)) return;
      if (typeof page === 'string') {
        this.update({ kind: 'failed', cursor, error: page });
        return;
      }
      if (
        page.viewer.accountId !== this.binding.viewer.accountId ||
        page.viewer.authnEpoch !== this.binding.viewer.authnEpoch ||
        page.drafts.length > 20
      ) {
        this.update({ kind: 'failed', cursor, error: 'denied' });
        return;
      }
      this.update({
        kind: 'page',
        page: { cursor, rows: page.drafts, next: page.next, preparing: page.state === 'preparing' },
        selecting: null,
        error: null,
      });
    } finally {
      if (this.request === request) this.request = null;
    }
  }
  private currentRequest(request: AbortController): boolean {
    if (!this.isCurrent()) this.dispose();
    return !request.signal.aborted && this.request === request && !this.retired;
  }

  /** Called by the shared controller's open operation, so dirty/pending editor work cannot be replaced. */
  openDocument = async (postId: string, signal: AbortSignal): Promise<StudioResult<StudioSelection>> => {
    if (!this.isCurrent()) {
      this.dispose();
      return refused('denied', this.binding.locale);
    }
    const state = this.state;
    const entry = state.kind === 'page' ? state.page.rows.find((row) => row.id === postId) : undefined;
    if (signal.aborted || state.kind !== 'page' || state.selecting || !entry || !this.canSelect(entry))
      return refused('concealed', this.binding.locale);
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.request = request;
    this.candidate = null;
    this.update({ ...state, selecting: postId, error: null });
    const current = () => this.currentRequest(request);
    const fail = (error: ReadFailure): StudioResult<never> => {
      if (current()) this.update({ kind: 'failed', cursor: state.page.cursor, error });
      return refused(error, this.binding.locale);
    };
    try {
      const resumed = await readSelectedOwnDraft(
        this.binding.reader,
        {
          ...this.binding.viewer,
          callerEpoch: `${this.origin.sourceId}:${this.origin.generation}`,
          locale: this.binding.locale,
          source: 'content',
          address: '/studio',
        },
        entry,
        request.signal,
        current,
      );
      if (!current()) return refused('denied', this.binding.locale);
      if (typeof resumed === 'string') return fail(resumed);
      if (resumed.post.parentId !== null) return fail('concealed');
      this.readingPost = postId;
      const opened = await this.binding.readDocument(postId, request.signal);
      if (!current()) return refused('denied', this.binding.locale);
      if (!opened.ok) return fail(opened.error.kind === 'denied' ? 'denied' : 'unavailable');
      const selection = opened.value;
      const native = selection.native;
      if (
        selection.revision.exact.postId !== entry.id ||
        selection.revision.exact.revisionId !== entry.revisionId ||
        selection.visibility !== 'draft' ||
        !selection.permissions.edit ||
        native?.threadId !== entry.threadId ||
        native.boardId !== entry.board.id ||
        native.licence !== entry.licence ||
        JSON.stringify(native.subjectIds) !== JSON.stringify(entry.subjectIds) ||
        selection.revision.title !== (entry.title ?? 'Untitled draft') ||
        serializeDocument(selection.revision.body) !== serializeDocument(resumed.post.body) ||
        JSON.stringify(selection.revision.mediaIds) !== JSON.stringify(resumed.post.mediaIds)
      )
        return fail('stale');
      this.candidate = { postId, threadId: entry.threadId };
      this.close();
      return opened;
    } finally {
      signal.removeEventListener('abort', abort);
      this.readingPost = null;
      if (this.request === request) this.request = null;
    }
  };
}
