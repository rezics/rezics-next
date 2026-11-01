import type { QueryClient } from '@tanstack/react-query';
import { QueryClientContext } from '@tanstack/react-query';
import { useRouter, type AnyRouter } from '@tanstack/react-router';
import {
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { BoardCommunityStatus } from './board-community';
import type { CommunityBoardPage } from './board-feed-data';

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
};

export type BoardPageLoadResult = CommunityBoardPage & {
  indexable: boolean;
  caller: BoardPageCallerReceipt;
};

type LiveBinding = {
  client: QueryClient;
  input: BoardPageCallerInput;
};

type RetireReason = 'session' | 'input' | 'navigation' | 'reload' | 'aborted' | 'unmount' | 'missing' | 'manual';

const sessionSources = new WeakMap<QueryClient, SessionSource>();
const clientVisits = new WeakMap<QueryClient, Map<string, BoardPageCaller>>();
const errorOwners = new WeakMap<object, BoardPageCaller>();
const consumedPublicTransfers = new WeakSet<BoardPageLoadResult>();
let nextSourceId = 0;
let nextVisitId = 0;

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
  client.getQueryCache().subscribe(({ query }) => {
    if (
      query.queryKey.length !== sessionQuery.queryKey.length ||
      query.queryKey.some((part: unknown, index: number) => part !== sessionQuery.queryKey[index])
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

function boardPathLocation(href: string): { input: Pick<BoardPageCallerInput, 'id' | 'cursor' | 'sort' | 'locale'> } | null {
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
  private readonly signal: AbortSignal | undefined;
  private binding: () => LiveBinding;
  private queryKey?: readonly unknown[];
  private result?: BoardPageLoadResult;
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
  private registryKey: string;

  constructor(
    private readonly client: QueryClient,
    input: BoardPageCallerInput,
    signal?: AbortSignal,
    transferredPublic = false,
  ) {
    this.id = `${++nextVisitId}`;
    this.registryKey = this.id;
    this.source = sessionSource(client);
    this.sourceCapture = this.source.capture();
    this.input = input;
    this.signal = signal;
    this.binding = () => ({ client: this.client, input: this.input });
    this.transferredPublic = transferredPublic;
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
    if (this.input.credentialMode === 'anonymous') return true;
    const value = this.source.read();
    const capture = this.source.capture();
    const ready = value?.state === 'signed-in' && typeof value.subject === 'string' && value.subject.length > 0;
    return (
      ready &&
      this.source.snapshot() === this.sourceCapture.revision &&
      capture.dataUpdateCount === this.sourceCapture.dataUpdateCount &&
      capture.dataUpdatedAt === this.sourceCapture.dataUpdatedAt &&
      capture.tuple === this.sourceCapture.tuple
    );
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
    this.stopNavigation?.();
    this.stopLoad?.();
    this.stopWatching = undefined;
    this.stopNavigation = undefined;
    this.stopLoad = undefined;
    this.signal?.removeEventListener('abort', this.abortListener);
    const visits = visitsFor(this.client);
    if (visits.get(this.registryKey) === this) visits.delete(this.registryKey);
    if (this.input.credentialMode === 'session' && this.queryKey) {
      void this.client.cancelQueries({ queryKey: this.queryKey, exact: true });
      this.client.removeQueries({ queryKey: this.queryKey, exact: true });
    }
    this.publish();
  }

  assertLoadCurrent(): void {
    if (!this.check('input')) throw new Error('Board page caller retired');
  }

  queryOptions<T extends { queryKey: readonly unknown[]; queryFn?: unknown }>(options: T): T {
    const queryKey =
      this.input.credentialMode === 'session' ? [...options.queryKey, 'board-page-caller', this.id] : options.queryKey;
    this.queryKey = queryKey;
    const original = options.queryFn as unknown as (context: unknown) => Promise<CommunityBoardPage>;
    const queryFn = async (context: unknown) => {
      this.assertLoadCurrent();
      try {
        const page = await original(context);
        this.assertLoadCurrent();
        return page;
      } catch (error) {
        this.assertLoadCurrent();
        throw error;
      }
    };
    return { ...options, queryKey, queryFn } as T;
  }

  resultFor(page: CommunityBoardPage, indexable: boolean): BoardPageLoadResult {
    this.assertLoadCurrent();
    const receipt: BoardPageCallerReceipt = {
      id: this.id,
      credentialMode: this.input.credentialMode,
      sessionSourceId: this.input.credentialMode === 'session' ? this.source.id : null,
      routeKey: currentPageKey(this.input),
      publicTransfer: this.createdOnServer && this.input.credentialMode === 'anonymous',
    };
    const result = { ...page, indexable, caller: receipt };
    this.result = result;
    this.publish();
    return result;
  }

  ownsResult(result: BoardPageLoadResult): boolean {
    return this.result === result && this.input.id === result.board.id && this.check('input');
  }

  captureError(error: unknown) {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function')
      errorOwners.set(error as object, this);
  }

  isCurrent(): boolean {
    return !this.retired && this.check('input');
  }

  currentRetry(ticket: number, callback: () => void): boolean {
    if (!this.connected || this.retired || ticket !== this.connection || !this.check('input')) return false;
    callback();
    return true;
  }

  get connectionTicket(): number {
    return this.connection;
  }

  adoptTransferredPublicResult(result: BoardPageLoadResult, receiptId: string) {
    this.result = result;
    const visits = visitsFor(this.client);
    if (visits.get(this.registryKey) === this) visits.delete(this.registryKey);
    this.registryKey = receiptId;
    visits.set(receiptId, this);
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

function transferredPublicCaller(
  client: QueryClient,
  input: BoardPageCallerInput,
  result: BoardPageLoadResult,
  receipt: BoardPageCallerReceipt | undefined,
): BoardPageCaller | undefined {
  if (receipt?.credentialMode !== 'anonymous' || input.credentialMode !== 'anonymous') return undefined;
  if (
    !receipt.publicTransfer ||
    receipt.routeKey !== currentPageKey(input) ||
    consumedPublicTransfers.has(result)
  )
    return undefined;
  const caller = new BoardPageCaller(client, input, undefined, true);
  consumedPublicTransfers.add(result);
  // Preserve the server marker for this one public transfer so later mounts cannot revive a retired session result.
  caller.adoptTransferredPublicResult(result, receipt.id);
  return caller;
}

function currentCallerForResult(
  client: QueryClient,
  result: BoardPageLoadResult,
  input: BoardPageCallerInput,
): BoardPageCaller | undefined {
  const caller = result.caller ? findCaller(client, result.caller.id) : undefined;
  if (caller && caller.ownsResult(result)) return caller;
  if (
    result.caller?.credentialMode === 'anonymous' &&
    result.caller.routeKey === currentPageKey(input) &&
    result.board.id === input.id
  )
    return transferredPublicCaller(client, input, result, result.caller);
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
  return ((typeof error === 'object' && error !== null) || typeof error === 'function'
    ? errorOwners.get(error as object)
    : undefined) as BoardPageCaller | undefined;
}

const noSubscribe = () => () => {};
const noSnapshot = () => 0;
const useCallerLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type BoardPageCallerLifecycle = {
  caller: BoardPageCaller | undefined;
  current: boolean;
  reason: RetireReason | undefined;
  retry: (callback: () => void) => boolean;
};

function useCallerLifecycle(caller: BoardPageCaller | undefined, input: BoardPageCallerInput): BoardPageCallerLifecycle {
  const client = useContext(QueryClientContext);
  const router = useRouter();
  const binding = useRef<LiveBinding>({ client: client ?? ({} as QueryClient), input });
  binding.current = { client: client ?? ({} as QueryClient), input };
  caller?.bindCurrent(() => binding.current);
  useSyncExternalStore(caller?.subscribe ?? noSubscribe, caller?.snapshot ?? noSnapshot, caller?.serverSnapshot ?? noSnapshot);
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
  children: (page: CommunityBoardPage) => ReactNode;
}) {
  const client = useContext(QueryClientContext);
  const router = useRouter();
  const [caller] = useState(() => (client ? currentCallerForResult(client, result, input) : undefined));
  const lifecycle = useCallerLifecycle(caller, input);
  const reloadFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    const needsCurrentVisit = !lifecycle.current && (lifecycle.reason === 'session' || !caller);
    if (!needsCurrentVisit || router.state.isLoading) return;
    const key = `${result.caller?.id ?? 'missing'}:${lifecycle.reason ?? 'missing'}`;
    if (reloadFor.current === key) return;
    reloadFor.current = key;
    void router.invalidate();
  }, [caller, lifecycle.current, lifecycle.reason, result.caller?.id, router]);

  if (!lifecycle.current || !caller || (!caller.ownsResult(result) && !caller.canDisplayTransferredPublic))
    return createElement(BoardCommunityStatus, { state: 'loading' });
  return children(result);
}

/** Admission sits outside the shared renderer and existing participation/start/menu controllers. */
export function BoardPageCallerHost({
  result,
  input,
  children,
}: {
  result: BoardPageLoadResult;
  input: BoardPageCallerInput;
  children: (page: CommunityBoardPage) => ReactNode;
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
