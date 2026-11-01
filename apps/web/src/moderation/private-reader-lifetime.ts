import type { QueryClient } from '@tanstack/react-query';
import { privateReaderFingerprint, samePrivateReader, type PrivateReaderOrigin } from './private-reader-origin';

type Session = { state: string; subject?: string | null; csrfToken?: string | null };
export type PrivateReaderNavigation = { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };
export type PrivateReaderBinding = {
  id: string;
  source: string;
  revision: number;
  key: string;
  placement: 'server' | 'browser';
  expected: PrivateReaderOrigin | null;
  retired: boolean;
};
export type PrivateReaderRead = { readerOrigin?: PrivateReaderOrigin | null; readerBinding?: PrivateReaderBinding };

const sources = new WeakMap<QueryClient, ReturnType<typeof observeSession>>();
// The cache may structurally copy a receipt. Correlation retains the original observation and
// abort signal; it never replaces the actual-origin comparison. A live receipt retains one
// observation, including its retirement, without accumulating a strongly retained page history.
type Prepared = { capture: Capture; signal?: AbortSignal; owner?: symbol; retired: boolean; release: () => void };
type PreparationIndex = Map<string, WeakRef<Prepared>>;
const preparations = new WeakMap<QueryClient, PreparationIndex>();
const receipts = new WeakMap<PrivateReaderBinding, Prepared>();
const collected = new FinalizationRegistry<{ records: PreparationIndex; id: string; reference: WeakRef<Prepared> }>(
  ({ records, id, reference }) => {
    if (records.get(id) === reference) records.delete(id);
  },
);
const consumed = new WeakSet<PrivateReaderBinding>();
const tuple = (session: Session | undefined) =>
  JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);

function observeSession(client: QueryClient) {
  const read = () => client.getQueryData<Session>(['session']);
  const query = () => client.getQueryCache().find({ queryKey: ['session'], exact: true });
  let previousQuery = query();
  let previous = tuple(read());
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
    const nextQuery = query();
    const next = tuple(read());
    const replacement =
      event.type === 'added' ||
      event.type === 'removed' ||
      (event.type === 'updated' && ['success', 'error', 'setState'].includes(event.action.type));
    if (replacement || nextQuery !== previousQuery || next !== previous) {
      revision++;
      previousQuery = nextQuery;
      previous = next;
      for (const listener of listeners) listener();
    }
  });
  return {
    // Correlation identifies a local cache only; admission always compares the actual origin too.
    id: crypto.randomUUID(),
    read,
    query,
    snapshot: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function privateReaderSessionSource(client: QueryClient) {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}
type Capture = ReturnType<typeof captureSession>;
function captureSession(client: QueryClient) {
  const source = privateReaderSessionSource(client);
  const query = source.query();
  const revision = source.snapshot();
  const session = source.read();
  const original = tuple(session);
  const healthy = !!query && query.state.status === 'success' && session?.state === 'signed-in' && !!session.subject;
  const subject = session?.subject;
  const token = session?.csrfToken ?? null;
  const expected = healthy
    ? privateReaderFingerprint(token).then((csrfFingerprint) => ({ subject: subject!, csrfFingerprint }))
    : Promise.resolve(null);
  return {
    client,
    source,
    query,
    revision,
    expected,
    current: () =>
      healthy &&
      source.query() === query &&
      source.snapshot() === revision &&
      query?.state.status === 'success' &&
      tuple(source.read()) === original,
    canCommand: () => !!token,
  };
}

function rememberPreparation(
  client: QueryClient,
  binding: PrivateReaderBinding,
  capture: Capture,
  signal?: AbortSignal,
) {
  let records = preparations.get(client);
  if (!records) {
    records = new Map();
    preparations.set(client, records);
  }
  const record: Prepared = {
    capture,
    ...(signal ? { signal } : {}),
    retired: false,
    release() {
      record.retired = true;
      signal?.removeEventListener('abort', record.release);
    },
  };
  const reference = new WeakRef(record);
  records.set(binding.id, reference);
  receipts.set(binding, record);
  collected.register(record, { records, id: binding.id, reference });
  signal?.addEventListener('abort', record.release, { once: true });
  return record;
}

/** Capture before calling the production reader. No session fetch, expected-viewer stamping or second preparation. */
export async function preparePrivateReaderRead<T extends PrivateReaderRead>(
  client: QueryClient,
  key: string,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T & { readerBinding: PrivateReaderBinding }> {
  signal?.throwIfAborted();
  const capture = captureSession(client);
  const response = await read();
  signal?.throwIfAborted();
  const expected = await capture.expected;
  signal?.throwIfAborted();
  const readerBinding: PrivateReaderBinding = {
    id: crypto.randomUUID(),
    source: capture.source.id,
    revision: capture.revision,
    key,
    placement: typeof window === 'undefined' ? 'server' : 'browser',
    expected,
    retired: !capture.current() || (!!response.readerOrigin && !samePrivateReader(expected, response.readerOrigin)),
  };
  if (!readerBinding.retired) rememberPreparation(client, readerBinding, capture, signal);
  return { ...response, readerBinding };
}

/** One original page owner. A fresh response may recover it, never replace its browser observation. */
export function createPrivateReaderLifetime(
  client: QueryClient,
  read: PrivateReaderRead,
  key: string,
  navigation?: PrivateReaderNavigation,
) {
  const binding = read.readerBinding;
  let local = binding && preparations.get(client)?.get(binding.id)?.deref();
  const identity = Symbol();
  const capture = local?.capture ?? captureSession(client);
  const source = privateReaderSessionSource(client);
  if (!local && binding?.placement === 'server') local = rememberPreparation(client, binding, capture);
  if (local && binding) receipts.set(binding, local);
  const independent = !!binding && binding.source !== capture.source.id;
  let retired =
    !binding ||
    binding.retired ||
    binding.key !== key ||
    consumed.has(binding) ||
    !!local?.retired ||
    capture.client !== client ||
    (binding.placement === 'browser' && (!local || binding.source !== source.id)) ||
    !!local?.owner ||
    (binding.source === source.id && binding.revision !== source.snapshot());
  let verified = !!local && !independent && samePrivateReader(binding?.expected, read.readerOrigin);
  const release = () => {
    if (!local?.owner || local.owner === identity) local?.release();
  };
  if (retired) release();
  let connected = false;
  let serial = 0;
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    serial++;
    if (binding) consumed.add(binding);
    release();
    publish();
  };
  const observe = () => {
    if (!capture.current() || local?.retired || local?.signal?.aborted || navigation?.isCurrent() === false) retire();
    return !retired;
  };
  if (independent && binding) {
    // Independent hydration has a separate observation, captured before this asynchronous comparison.
    void capture.expected
      .then((expected) => {
        if (!observe()) return;
        if (
          !samePrivateReader(expected, binding.expected) ||
          (read.readerOrigin && !samePrivateReader(expected, read.readerOrigin))
        )
          return retire();
        verified = samePrivateReader(expected, read.readerOrigin);
        publish();
      })
      .catch(retire);
  }
  return {
    retire,
    snapshot: () => {
      observe();
      return version;
    },
    serverSnapshot: () => 0,
    available: () => observe() && verified,
    healthy: observe,
    isCurrent: () => connected && observe(),
    canRecover: () => connected && !local?.signal?.aborted && navigation?.isCurrent() !== false,
    canCommand: () => connected && observe() && verified && capture.canCommand(),
    ticket: () => serial,
    owns: (ticket: number) => connected && observe() && ticket === serial,
    async accepts(next: PrivateReaderRead) {
      const ticket = serial;
      const expected = await capture.expected;
      if (!connected || !observe() || ticket !== serial) return false;
      verified = samePrivateReader(expected, next.readerOrigin);
      return verified;
    },
    subscribe(listener: () => void) {
      if (local?.owner && local.owner !== identity) retire();
      if (local && !local.owner) local.owner = identity;
      connected = true;
      listeners.add(listener);
      const stopSession = source.subscribe(observe);
      const stopNavigation = navigation?.subscribe(retire);
      const abort = () => retire();
      local?.signal?.addEventListener('abort', abort, { once: true });
      observe();
      return () => {
        connected = false;
        serial++;
        if (binding) consumed.add(binding);
        listeners.delete(listener);
        stopSession();
        stopNavigation?.();
        local?.signal?.removeEventListener('abort', abort);
        // Synchronous StrictMode replay reconnects only this same owner. Queued effects are already fenced.
        queueMicrotask(() => {
          if (!connected) retire();
        });
      };
    },
  };
}
