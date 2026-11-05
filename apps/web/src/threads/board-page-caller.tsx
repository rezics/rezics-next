import type { QueryClient } from '@tanstack/react-query';
import { QueryClientContext } from '@tanstack/react-query';
import { useRouter, type AnyRouter } from '@tanstack/react-router';
import {
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { BoardCommunityStatus } from './board-community';
import type { BoardOpeningReactionOrigin } from './board-opening';
import type { CommunityBoardPage } from './board-feed-data';
import type { BoardPageRead, BoardPageReaderOrigin } from './reads';
import type { SlowModeVisitOwner } from './slow-mode/contract';

export type BoardPageCallerInput = {
  id: string;
  cursor?: string;
  sort?: 'hot' | 'new';
  locale: string;
  credentialMode: ReadCredentialMode;
};

type SessionValue = {
  state?: string;
  subject?: string | null;
  csrfToken?: string | null;
};

type SessionCapture = {
  revision: number;
  dataUpdateCount: number;
  dataUpdatedAt: number;
  tuple: string;
};

type BoardExpectedReader = {
  state: string;
  subject: string;
  ready: true;
  csrfFingerprint: string;
};

type BoardReaderObservation = {
  sourceId: number;
  revision: number;
  dataUpdateCount: number;
  dataUpdatedAt: number;
};

type SessionSource = {
  id: number;
  read: () => SessionValue | undefined;
  capture: () => SessionCapture;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

export type BoardPageCallerReceipt = {
  id: string;
  credentialMode: ReadCredentialMode;
  sessionSourceId: number | null;
  routeKey: string;
  publicTransfer: boolean;
  expectedReader: BoardExpectedReader | null;
  readerOrigin: BoardPageReaderOrigin;
  originalObservation: BoardReaderObservation;
  queryKey: readonly unknown[];
};

export type BoardPageLoadResult = CommunityBoardPage & {
  indexable: boolean;
  caller: BoardPageCallerReceipt;
};

type LiveBinding = {
  client: QueryClient;
  input: BoardPageCallerInput;
};

type RetireReason =
  | 'session'
  | 'input'
  | 'navigation'
  | 'reload'
  | 'aborted'
  | 'unmount'
  | 'missing'
  | 'cache'
  | 'manual';

const sessionSources = new WeakMap<QueryClient, SessionSource>();
const clientVisits = new WeakMap<QueryClient, Map<string, BoardPageCaller>>();
const errorOwners = new WeakMap<object, BoardPageCaller>();
const boardReadOwners = new WeakMap<object, BoardPageCaller>();
const acceptedBoardReads = new WeakMap<
  object,
  { caller: BoardPageCaller; query: object; expectedReader: BoardExpectedReader | null }
>();
const retiredResults = new WeakSet<BoardPageLoadResult>();
const consumedResultTransfers = new WeakSet<BoardPageLoadResult>();
let nextSourceId = 0;
let nextVisitId = 0;

async function csrfFingerprint(token: string | null | undefined): Promise<string> {
  const value = token == null ? 'null\u0000' : `token\u0000${token}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameReader(left: BoardPageReaderOrigin, right: BoardExpectedReader | null): boolean {
  return (
    !!right &&
    left.kind === 'session' &&
    left.subject === right.subject &&
    left.csrfFingerprint === right.csrfFingerprint
  );
}

function sessionTuple(value: SessionValue | undefined): string {
  return JSON.stringify([
    value?.state ?? 'unknown',
    value?.subject ?? null,
    value?.csrfToken ?? null,
    value?.state === 'signed-in' && typeof value.subject === 'string' && value.subject.length > 0,
  ]);
}

function sessionSource(client: QueryClient): SessionSource {
  const existing = sessionSources.get(client);
  if (existing) return existing;

  const read = () => client.getQueryData<SessionValue>(sessionQuery.queryKey);
  const state = () => client.getQueryState(sessionQuery.queryKey);
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (
      query.queryKey.length !== sessionQuery.queryKey.length ||
      query.queryKey.some((part: unknown, index: number) => part !== sessionQuery.queryKey[index])
    )
      return;
    if (
      event.type !== 'removed' &&
      !(event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
    )
      return;
    revision++;
    for (const listener of listeners) listener();
  });

  const source: SessionSource = {
    id: ++nextSourceId,
    read,
    capture: () => ({
      revision,
      dataUpdateCount: state()?.dataUpdateCount ?? 0,
      dataUpdatedAt: state()?.dataUpdatedAt ?? 0,
      tuple: sessionTuple(read()),
    }),
    snapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  sessionSources.set(client, source);
  return source;
}

function visitsFor(client: QueryClient): Map<string, BoardPageCaller> {
  let visits = clientVisits.get(client);
  if (!visits) {
    visits = new Map();
    clientVisits.set(client, visits);
  }
  return visits;
}

function sameInput(left: BoardPageCallerInput, right: BoardPageCallerInput): boolean {
  return (
    left.id === right.id &&
    left.cursor === right.cursor &&
    left.sort === right.sort &&
    left.locale === right.locale &&
    left.credentialMode === right.credentialMode
  );
}

function boardPathLocation(
  href: string,
): { input: Pick<BoardPageCallerInput, 'id' | 'cursor' | 'sort' | 'locale'> } | null {
  try {
    const url = new URL(href, 'https://board-page.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    let boardIndex = parts.length - 2;
    if (parts.at(-2) !== 'boards' && (parts.length < 3 || parts.at(-3) !== 'boards')) return null;
    if (parts[boardIndex] !== 'boards' || !parts[boardIndex + 1]) return null;
    const locale = boardIndex === 1 ? parts[0]! : boardIndex > 1 ? parts[boardIndex - 1]! : getLocale();
    let id = parts[boardIndex + 1]!;
    try {
      id = decodeURIComponent(id);
    } catch {
      return null;
    }
    const cursorValues = url.searchParams.getAll('cursor');
    const sortValues = url.searchParams.getAll('sort');
    const rawCursor = cursorValues[0];
    const rawSort = sortValues[0];
    return {
      input: {
        id,
        ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
        ...(rawSort === 'hot' || rawSort === 'new' ? { sort: rawSort } : {}),
        locale,
      },
    };
  } catch {
    return null;
  }
}

function currentPageKey(input: BoardPageCallerInput): string {
  return JSON.stringify([input.id, input.cursor ?? null, input.sort ?? null, input.locale, input.credentialMode]);
}

/** One source observes the exact session cache entry before the Board query can start. */
export class BoardPageCaller {
  readonly id: string;
  readonly source: SessionSource;
  readonly sourceCapture: SessionCapture;
  readonly input: BoardPageCallerInput;
  private readonly expectedSession: SessionValue | undefined;
  private readonly signal: AbortSignal | undefined;
  private binding: () => LiveBinding;
  private queryKey?: readonly unknown[];
  private pageQuery: object | undefined;
  private queryDataUpdateCount: number | undefined;
  private stopQueryWatching: (() => void) | undefined;
  private result?: BoardPageLoadResult;
  private pendingRead: BoardPageRead | undefined;
  private retired = false;
  private connected = false;
  private connection = 0;
  private revision = 0;
  private reason?: RetireReason;
  private readonly listeners = new Set<() => void>();
  private stopWatching: (() => void) | undefined;
  private stopNavigation: (() => void) | undefined;
  private stopLoad: (() => void) | undefined;
  private readonly abortListener: () => void;
  private readonly createdOnServer: boolean;
  private readonly transferReceipt: BoardPageCallerReceipt | undefined;
  private transferVerified: boolean;
  private transferVerificationAttempt = 0;
  private registryKey: string;

  constructor(
    private readonly client: QueryClient,
    input: BoardPageCallerInput,
    signal?: AbortSignal,
    transferredPublic = false,
    transferReceipt?: BoardPageCallerReceipt,
  ) {
    this.id = `${++nextVisitId}`;
    this.registryKey = this.id;
    this.source = sessionSource(client);
    const expectedSession = this.source.read();
    this.expectedSession = expectedSession ? { ...expectedSession } : undefined;
    this.sourceCapture = this.source.capture();
    this.input = input;
    this.signal = signal;
    this.binding = () => ({ client: this.client, input: this.input });
    this.transferredPublic = transferredPublic;
    this.transferReceipt = transferReceipt;
    this.transferVerified = input.credentialMode === 'anonymous' || !transferReceipt;
    this.createdOnServer = typeof window === 'undefined';
    this.abortListener = () => this.retire('aborted');
    visitsFor(client).set(this.id, this);
    if (signal?.aborted) this.retire('aborted');
    else signal?.addEventListener('abort', this.abortListener, { once: true });
  }

  private readonly transferredPublic: boolean;

  bindCurrent(read: () => LiveBinding) {
    this.binding = read;
  }

  private sessionMatches(): boolean {
    const value = this.source.read();
    const capture = this.source.capture();
    const observationMatches =
      this.source.snapshot() === this.sourceCapture.revision &&
      capture.dataUpdateCount === this.sourceCapture.dataUpdateCount &&
      capture.dataUpdatedAt === this.sourceCapture.dataUpdatedAt &&
      capture.tuple === this.sourceCapture.tuple;
    if (this.input.credentialMode === 'anonymous') return observationMatches;
    const ready = value?.state === 'signed-in' && typeof value.subject === 'string' && value.subject.length > 0;
    return ready && observationMatches;
  }

  private inputMatches(): boolean {
    const live = this.binding();
    return (
      live.client === this.client &&
      sameInput(live.input, this.input) &&
      getLocale() === this.input.locale &&
      (!this.signal || !this.signal.aborted)
    );
  }

  private check(reason: RetireReason = 'input', notify = false): boolean {
    if (this.retired) return false;
    if (!this.inputMatches()) {
      this.retire(this.signal?.aborted ? 'aborted' : reason);
      return false;
    }
    if (!this.sessionMatches()) {
      this.retire('session');
      return false;
    }
    if (notify) this.publish();
    return true;
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  retire(reason: RetireReason = 'manual') {
    if (this.retired) return;
    this.retired = true;
    this.reason = reason;
    this.connection++;
    this.connected = false;
    this.stopWatching?.();
    this.stopQueryWatching?.();
    this.stopNavigation?.();
    this.stopLoad?.();
    this.stopWatching = undefined;
    this.stopQueryWatching = undefined;
    this.stopNavigation = undefined;
    this.stopLoad = undefined;
    this.pendingRead = undefined;
    this.signal?.removeEventListener('abort', this.abortListener);
    if (this.result) retiredResults.add(this.result);
    const visits = visitsFor(this.client);
    if (visits.get(this.registryKey) === this) visits.delete(this.registryKey);
    if (this.input.credentialMode === 'session' && this.queryKey && this.pageQuery) {
      const owned = this.pageQuery;
      const exactOwner = {
        queryKey: this.queryKey,
        exact: true,
        predicate: (query: unknown) => query === owned,
      };
      void this.client.cancelQueries(exactOwner as never);
      this.client.removeQueries(exactOwner as never);
    }
    this.publish();
  }

  assertLoadCurrent(): void {
    if (!this.check('input')) throw new Error('Board page caller retired');
  }

  queryOptions<T extends { queryKey: readonly unknown[]; queryFn?: unknown }>(options: T): T {
    const baseQueryKey = [
      'board-page',
      this.input.id,
      this.input.cursor ?? null,
      this.input.sort ?? null,
      this.input.credentialMode,
    ];
    if (
      options.queryKey.length !== baseQueryKey.length ||
      options.queryKey.some((part, index) => part !== baseQueryKey[index])
    ) {
      this.retire('input');
      throw new Error('Board page query did not match its caller inputs');
    }
    const queryKey =
      this.input.credentialMode === 'session' ? [...options.queryKey, 'board-page-caller', this.id] : options.queryKey;
    this.queryKey = queryKey;
    const original = options.queryFn as unknown as (context: unknown) => Promise<BoardPageRead>;
    const existing = this.client.getQueryCache().find({ queryKey, exact: true });
    this.pageQuery = existing;
    if (existing) this.queryDataUpdateCount = this.client.getQueryState(queryKey)?.dataUpdateCount;
    this.watchQueryUpdates(queryKey, true);
    const queryFn = async (context: unknown) => {
      this.assertLoadCurrent();
      try {
        this.assertQueryOwner();
        const read = await original(context);
        await this.validateOriginalRead(read, true);
        this.pendingRead = read;
        return read;
      } catch (error) {
        this.pendingRead = undefined;
        this.assertLoadCurrent();
        throw error;
      }
    };
    return { ...options, queryKey, queryFn } as T;
  }

  async resultFor(read: BoardPageRead, indexable: boolean): Promise<BoardPageLoadResult> {
    const expectedReader = await this.validateOriginalRead(read, false);
    this.assertLoadCurrent();
    const page = read.page;
    this.assertQueryOwner(read);
    const queryState = this.client.getQueryState<BoardPageRead>(this.queryKey!);
    if (this.queryDataUpdateCount !== undefined && queryState?.dataUpdateCount !== this.queryDataUpdateCount) {
      this.retire('cache');
      throw new Error('Board page query revision changed before result publication');
    }
    if (this.input.credentialMode === 'session' && boardReadOwners.get(read) !== this) {
      this.retire('cache');
      throw new Error('Board page result was not produced by its caller');
    }
    this.queryDataUpdateCount ??= queryState?.dataUpdateCount;
    const receipt: BoardPageCallerReceipt = {
      id: this.id,
      credentialMode: this.input.credentialMode,
      sessionSourceId: this.input.credentialMode === 'session' ? this.source.id : null,
      routeKey: currentPageKey(this.input),
      publicTransfer:
        this.createdOnServer && this.input.credentialMode === 'anonymous' && read.readerOrigin.kind === 'anonymous',
      expectedReader,
      readerOrigin: read.readerOrigin,
      originalObservation: {
        sourceId: this.source.id,
        revision: this.sourceCapture.revision,
        dataUpdateCount: this.sourceCapture.dataUpdateCount,
        dataUpdatedAt: this.sourceCapture.dataUpdatedAt,
      },
      queryKey: [...(this.queryKey ?? [])],
    };
    const result = { ...page, indexable, caller: receipt };
    this.result = result;
    this.publish();
    return result;
  }

  ownsResult(result: BoardPageLoadResult): boolean {
    return this.result === result && this.input.id === result.board.id && this.isCurrent();
  }

  ownsReceipt(result: BoardPageLoadResult): boolean {
    return this.result === result && this.input.id === result.board.id;
  }

  reactionOrigin(result: BoardPageLoadResult): BoardOpeningReactionOrigin {
    const receipt = result.caller;
    const reader =
      receipt.readerOrigin.kind === 'session' &&
      receipt.expectedReader &&
      sameReader(receipt.readerOrigin, receipt.expectedReader)
        ? receipt.expectedReader.subject
        : null;
    return {
      key: `${receipt.id}:${receipt.routeKey}`,
      reader,
      isCurrent: () => this.ownsResult(result),
    };
  }

  captureError(error: unknown) {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function')
      errorOwners.set(error as object, this);
  }

  isCurrent(): boolean {
    return (
      !this.retired &&
      this.check('input') &&
      (!this.transferReceipt || this.input.credentialMode === 'anonymous' || this.transferVerified)
    );
  }

  currentRetry(ticket: number, callback: () => void): boolean {
    if (!this.connected || this.retired || ticket !== this.connection || !this.check('input')) return false;
    callback();
    return true;
  }

  get connectionTicket(): number {
    return this.connection;
  }

  adoptTransferredResult(result: BoardPageLoadResult, receiptId: string) {
    this.result = result;
    this.queryKey = result.caller.queryKey;
    this.pageQuery = this.client.getQueryCache().find({ queryKey: this.queryKey, exact: true });
    if (this.pageQuery) this.queryDataUpdateCount = this.client.getQueryState(this.queryKey)?.dataUpdateCount;
    this.watchQueryUpdates(this.queryKey, false);
    const visits = visitsFor(this.client);
    if (visits.get(this.registryKey) === this) visits.delete(this.registryKey);
    this.registryKey = receiptId;
    visits.set(receiptId, this);
  }

  get isTransferPending(): boolean {
    return !!this.transferReceipt && this.input.credentialMode === 'session' && !this.transferVerified;
  }

  get isTransferredResult(): boolean {
    return !!this.transferReceipt;
  }

  get retiredReason(): RetireReason | undefined {
    return this.reason;
  }

  snapshot = (): number => {
    this.check('input');
    return this.revision;
  };

  serverSnapshot = (): number => this.revision;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.snapshot();
    return () => this.listeners.delete(listener);
  };

  connect(router: AnyRouter): () => void {
    if (this.retired) return () => {};
    this.connected = true;
    const ticket = ++this.connection;
    this.stopWatching = this.source.subscribe(() => this.check('session'));
    this.stopNavigation = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const target = boardPathLocation(toLocation.publicHref);
      if (!target || !sameInput({ ...target.input, credentialMode: this.input.credentialMode }, this.input))
        this.retire('navigation');
    });
    this.stopLoad = router.subscribe('onBeforeLoad', () => this.retire('reload'));
    this.check('input');
    if (this.transferReceipt && this.input.credentialMode === 'session') void this.verifyTransferredResult();
    this.publish();
    return () => {
      if (ticket !== this.connection || !this.connected) return;
      this.connected = false;
      const disconnected = ++this.connection;
      this.stopWatching?.();
      this.stopNavigation?.();
      this.stopLoad?.();
      this.stopWatching = undefined;
      this.stopNavigation = undefined;
      this.stopLoad = undefined;
      this.publish();
      queueMicrotask(() => {
        if (!this.connected && this.connection === disconnected) this.retire('unmount');
      });
    };
  }

  get canDisplayTransferredPublic(): boolean {
    return this.transferredPublic && this.input.credentialMode === 'anonymous' && this.isCurrent();
  }

  private async verifyTransferredResult(): Promise<void> {
    const ticket = this.connection;
    if (!this.connected || this.retired || !this.transferReceipt) return;
    const attempt = ++this.transferVerificationAttempt;
    const result = this.result;
    const receipt = this.transferReceipt;
    const queryKey = this.queryKey ? [...this.queryKey] : undefined;
    const queryAtStart = queryKey ? this.client.getQueryCache().find({ queryKey, exact: true }) : undefined;
    const currentAttempt = () =>
      attempt === this.transferVerificationAttempt &&
      ticket === this.connection &&
      this.connected &&
      !this.retired &&
      this.result === result &&
      this.transferReceipt === receipt &&
      sameInput(this.binding().input, this.input) &&
      this.binding().client === this.client &&
      getLocale() === this.input.locale &&
      this.pageQuery === (queryAtStart ?? this.pageQuery) &&
      (!queryKey || this.client.getQueryCache().find({ queryKey, exact: true }) === queryAtStart);
    try {
      const expected = receipt.expectedReader;
      const origin = receipt.readerOrigin;
      const current = this.source.read();
      if (
        !currentAttempt() ||
        !expected ||
        origin.kind !== 'session' ||
        !sameReader(origin, expected) ||
        current?.state !== 'signed-in' ||
        !current.subject
      ) {
        if (currentAttempt()) this.retire('session');
        return;
      }
      const fingerprint = await csrfFingerprint(current.csrfToken);
      if (!currentAttempt()) return;
      if (
        !this.sessionMatches() ||
        current.subject !== origin.subject ||
        fingerprint !== origin.csrfFingerprint ||
        !this.check('input')
      ) {
        if (currentAttempt()) this.retire('session');
        return;
      }
      this.transferVerified = true;
      this.publish();
    } catch {
      if (currentAttempt()) this.retire('session');
    }
  }

  private assertQueryOwner(read?: BoardPageRead): object {
    const queryKey = this.queryKey;
    if (!queryKey) {
      this.retire('cache');
      throw new Error('Board page query owner is unavailable');
    }
    const query = this.client.getQueryCache().find({ queryKey, exact: true });
    if (!query || (this.pageQuery && query !== this.pageQuery)) {
      this.retire('cache');
      throw new Error('Board page query owner changed');
    }
    if (!this.pageQuery) this.pageQuery = query;
    if (read !== undefined && this.client.getQueryState<BoardPageRead>(queryKey)?.data !== read) {
      this.retire('cache');
      throw new Error('Board page query result changed');
    }
    return query;
  }

  private async validateOriginalRead(read: BoardPageRead, beforeCachePublication: boolean) {
    this.assertLoadCurrent();
    if (!read || typeof read !== 'object') {
      this.retire('cache');
      throw new Error('Board page reader returned no result envelope');
    }
    const query = this.assertQueryOwner();
    const beforeState = this.client.getQueryState<BoardPageRead>(this.queryKey!);
    const beforeData = beforeState?.data;
    const beforeDataUpdateCount = beforeState?.dataUpdateCount;
    const accepted = acceptedBoardReads.get(read);
    if (accepted?.caller === this && accepted.query === query) {
      if (!beforeCachePublication) this.assertQueryOwner(read);
      return accepted.expectedReader;
    }
    if (!beforeCachePublication && this.input.credentialMode === 'session' && boardReadOwners.get(read) !== this) {
      this.retire('cache');
      throw new Error('Board page result was not produced by its caller');
    }

    let expectedReader: BoardExpectedReader | null = null;
    if (this.input.credentialMode === 'session') {
      const expected = this.expectedSession;
      if (expected?.state !== 'signed-in' || typeof expected.subject !== 'string' || !expected.subject) {
        this.retire('session');
        throw new Error('Board page caller has no expected signed-in reader');
      }
      const fingerprint = await csrfFingerprint(expected.csrfToken);
      this.assertLoadCurrent();
      if (this.assertQueryOwner() !== query) throw new Error('Board page query owner changed');
      const currentState = this.client.getQueryState<BoardPageRead>(this.queryKey!);
      if (currentState?.data !== beforeData || currentState?.dataUpdateCount !== beforeDataUpdateCount) {
        this.retire('cache');
        throw new Error('Board page query changed during reader verification');
      }
      expectedReader = {
        state: expected.state,
        subject: expected.subject,
        ready: true,
        csrfFingerprint: fingerprint,
      };
      if (!sameReader(read.readerOrigin, expectedReader)) {
        this.retire('session');
        throw new Error('Board page reader did not match its expected session');
      }
    } else if (read.readerOrigin.kind !== 'anonymous') {
      this.retire('session');
      throw new Error('Anonymous Board page read did not use an anonymous reader');
    }

    this.assertLoadCurrent();
    if (this.assertQueryOwner() !== query) throw new Error('Board page query owner changed');
    if (!beforeCachePublication) this.assertQueryOwner(read);
    boardReadOwners.set(read, this);
    acceptedBoardReads.set(read, { caller: this, query, expectedReader });
    return expectedReader;
  }

  private watchQueryUpdates(queryKey: readonly unknown[], acceptFirstRead: boolean): void {
    this.stopQueryWatching?.();
    this.stopQueryWatching = this.client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey.length !== queryKey.length ||
        event.query.queryKey.some((part: unknown, index: number) => part !== queryKey[index])
      )
        return;
      if (event.type === 'added') {
        if (!this.pageQuery && !this.transferReceipt) this.pageQuery = event.query;
        else if (!this.pageQuery && this.transferReceipt) this.retire('cache');
        return;
      }
      if (this.pageQuery && event.query !== this.pageQuery) return;
      if (event.type === 'removed') {
        this.retire('cache');
        return;
      }
      if (event.type !== 'updated') return;
      if (event.action.type === 'success') {
        const data = event.query.state.data;
        const previousUpdateCount = this.queryDataUpdateCount ?? 0;
        if (
          acceptFirstRead &&
          !this.result &&
          data === this.pendingRead &&
          event.query.state.fetchStatus === 'idle' &&
          event.query.state.dataUpdateCount > previousUpdateCount &&
          data &&
          typeof data === 'object' &&
          boardReadOwners.get(data) === this
        ) {
          this.pageQuery = event.query;
          this.queryDataUpdateCount = event.query.state.dataUpdateCount;
          this.pendingRead = undefined;
          return;
        }
        this.retire('cache');
      } else if (event.action.type === 'error' && (this.queryDataUpdateCount !== undefined || this.result)) {
        this.retire('cache');
      }
    });
  }
}

export function createBoardPageCaller(
  client: QueryClient,
  input: BoardPageCallerInput,
  signal?: AbortSignal,
): BoardPageCaller {
  return new BoardPageCaller(client, input, signal);
}

function findCaller(client: QueryClient, id: string): BoardPageCaller | undefined {
  return visitsFor(client).get(id);
}

function transferredResultCaller(
  client: QueryClient,
  input: BoardPageCallerInput,
  result: BoardPageLoadResult,
  receipt: BoardPageCallerReceipt | undefined,
): BoardPageCaller | undefined {
  if (!receipt || receipt.credentialMode !== input.credentialMode || retiredResults.has(result)) return undefined;
  if (receipt.routeKey !== currentPageKey(input) || consumedResultTransfers.has(result)) return undefined;
  if (input.credentialMode === 'anonymous' && (!receipt.publicTransfer || receipt.readerOrigin.kind !== 'anonymous'))
    return undefined;
  if (
    input.credentialMode === 'session' &&
    (!receipt.expectedReader || !sameReader(receipt.readerOrigin, receipt.expectedReader))
  )
    return undefined;
  const caller = new BoardPageCaller(client, input, undefined, input.credentialMode === 'anonymous', receipt);
  consumedResultTransfers.add(result);
  // Preserve the originating receipt for this one transfer; the browser separately verifies its current reader.
  caller.adoptTransferredResult(result, receipt.id);
  return caller;
}

function currentCallerForResult(
  client: QueryClient,
  result: BoardPageLoadResult,
  input: BoardPageCallerInput,
): BoardPageCaller | undefined {
  const caller = result.caller ? findCaller(client, result.caller.id) : undefined;
  if (caller && caller.ownsReceipt(result)) return caller;
  if (
    result.caller &&
    result.caller.credentialMode === input.credentialMode &&
    result.caller.routeKey === currentPageKey(input) &&
    result.board.id === input.id
  )
    return transferredResultCaller(client, input, result, result.caller);
  return undefined;
}

export function boardPageResultIsCurrent(
  client: QueryClient,
  result: BoardPageLoadResult | undefined,
  input: BoardPageCallerInput,
): boolean {
  if (!result || result.board.id !== input.id) return false;
  const caller = currentCallerForResult(client, result, input);
  return !!caller && (caller.ownsResult(result) || caller.canDisplayTransferredPublic);
}

function callerForError(error: unknown): BoardPageCaller | undefined {
  return (
    (typeof error === 'object' && error !== null) || typeof error === 'function'
      ? errorOwners.get(error as object)
      : undefined
  ) as BoardPageCaller | undefined;
}

const noSubscribe = () => () => {};
const noSnapshot = () => 0;
const browserHydration = { subscribe: () => () => {}, getSnapshot: () => true, getServerSnapshot: () => false };
const useCallerLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type BoardPageCallerLifecycle = {
  caller: BoardPageCaller | undefined;
  current: boolean;
  reason: RetireReason | undefined;
  retry: (callback: () => void) => boolean;
};

function useCallerLifecycle(
  caller: BoardPageCaller | undefined,
  input: BoardPageCallerInput,
): BoardPageCallerLifecycle {
  const client = useContext(QueryClientContext);
  const router = useRouter();
  const binding = useRef<LiveBinding>({ client: client ?? ({} as QueryClient), input });
  binding.current = { client: client ?? ({} as QueryClient), input };
  caller?.bindCurrent(() => binding.current);
  useSyncExternalStore(
    caller?.subscribe ?? noSubscribe,
    caller?.snapshot ?? noSnapshot,
    caller?.serverSnapshot ?? noSnapshot,
  );
  useCallerLayoutEffect(() => (caller && client ? caller.connect(router) : undefined), [caller, client, router]);
  const ticket = caller?.connectionTicket ?? -1;
  const current = caller?.isCurrent() ?? false;
  return {
    caller,
    current,
    reason: caller?.retiredReason,
    retry: (callback) => (caller ? caller.currentRetry(ticket, callback) : false),
  };
}

function BoardPageVisit({
  result,
  input,
  children,
}: {
  result: BoardPageLoadResult;
  input: BoardPageCallerInput;
  children: (
    page: CommunityBoardPage,
    reactionOrigin: BoardOpeningReactionOrigin,
    source: SlowModeVisitOwner,
  ) => ReactNode;
}) {
  const client = useContext(QueryClientContext);
  const router = useRouter();
  const [caller] = useState(() => (client ? currentCallerForResult(client, result, input) : undefined));
  const lifecycle = useCallerLifecycle(caller, input);
  const source = useMemo(() => {
    let observed = false;
    let retired = false;
    return {
      identity: result,
      current: () => {
        const current = caller?.ownsResult(result) ?? false;
        if (current) observed = true;
        else if (observed) retired = true;
        return current && !retired;
      },
    } satisfies SlowModeVisitOwner;
  }, [caller, result]);
  const hydrated = useSyncExternalStore(
    browserHydration.subscribe,
    browserHydration.getSnapshot,
    browserHydration.getServerSnapshot,
  );
  const reloadFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    const needsCurrentVisit = !lifecycle.current && (lifecycle.reason === 'session' || !caller);
    if (!needsCurrentVisit || router.state.isLoading) return;
    const key = `${result.caller?.id ?? 'missing'}:${lifecycle.reason ?? 'missing'}`;
    if (reloadFor.current === key) return;
    reloadFor.current = key;
    void router.invalidate();
  }, [caller, lifecycle.current, lifecycle.reason, result.caller?.id, router]);

  if (
    !lifecycle.current &&
    !hydrated &&
    caller?.isTransferPending &&
    caller.isTransferredResult &&
    caller.ownsReceipt(result)
  )
    return children(result, caller.reactionOrigin(result), source);
  if (!lifecycle.current || !caller || (!caller.ownsResult(result) && !caller.canDisplayTransferredPublic))
    return createElement(BoardCommunityStatus, { state: 'loading' });
  return children(result, caller.reactionOrigin(result), source);
}

/** Admission sits outside the shared renderer and existing participation/start/menu controllers. */
export function BoardPageCallerHost({
  result,
  input,
  children,
}: {
  result: BoardPageLoadResult;
  input: BoardPageCallerInput;
  children: (
    page: CommunityBoardPage,
    reactionOrigin: BoardOpeningReactionOrigin,
    source: SlowModeVisitOwner,
  ) => ReactNode;
}) {
  const key = result.caller?.id ?? currentPageKey(input);
  return createElement(BoardPageVisit, { key, result, input, children });
}

export function useBoardPageErrorLifecycle(error: unknown, input: BoardPageCallerInput): BoardPageCallerLifecycle {
  return useCallerLifecycle(callerForError(error), input);
}

/** A caller may be retained by router loader data only while its original binding still owns it. */
export function isBoardPageResultCurrent(
  client: QueryClient,
  result: BoardPageLoadResult | undefined,
  input: BoardPageCallerInput,
): boolean {
  return boardPageResultIsCurrent(client, result, input);
}
