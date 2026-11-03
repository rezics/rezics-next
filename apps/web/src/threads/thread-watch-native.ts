import type { KernelClient } from '@rezics/client';

/** The private point read has no revision or command receipt. */
export type ThreadWatchState = Readonly<{ watching: boolean }>;

export type ThreadWatchOwner = Readonly<{
  threadId: string;
  viewerId: string;
  sessionStamp: string;
  /** Browser session credential owner, captured once; never looked up after an import. */
  csrfToken?: string;
  /** Local dispatch/result fence. This function is never serialized to the server. */
  isCurrent?: () => boolean;
}>;

export type ThreadWatchReadRequest = ThreadWatchOwner & Readonly<{ fetch: Readonly<{ cache: 'no-store' }> }>;
export type ThreadWatchCommand = ThreadWatchOwner & Readonly<{ watching: boolean }>;

export type ThreadWatchReadResult =
  | { kind: 'confirmed'; state: ThreadWatchState }
  | { kind: 'access-lost' }
  | { kind: 'unavailable' }
  | { kind: 'unknown' };

export type ThreadWatchCommandResult =
  | { kind: 'confirmed' }
  | { kind: 'refused'; reason: 'access-lost' | 'refused' | 'unavailable' }
  | { kind: 'unknown' };

export type ThreadWatchNative = {
  read(request: ThreadWatchReadRequest): Promise<ThreadWatchReadResult>;
  set(command: ThreadWatchCommand): Promise<ThreadWatchCommandResult>;
};

export type ThreadWatchTransport = {
  readThreadWatch(input: {
    data: { threadId: string; viewerId: string };
    headers: HeadersInit;
  }): Promise<ThreadWatchReadResult>;
  setThreadWatch(input: {
    data: { threadId: string; viewerId: string; watching: boolean };
    headers: HeadersInit;
  }): Promise<ThreadWatchCommandResult>;
};

function current(owner: ThreadWatchOwner): boolean {
  return typeof window !== 'undefined' && !!owner.csrfToken && (owner.isCurrent?.() ?? true);
}

/** Late module loading must not lend an old action the replacement reader's credentials. */
export function createThreadWatchNative(
  load: () => Promise<ThreadWatchTransport> = () => import('./thread-watch-transport'),
): ThreadWatchNative {
  return Object.freeze({
    async read(request: ThreadWatchReadRequest): Promise<ThreadWatchReadResult> {
      if (!current(request)) return { kind: 'unavailable' };
      const transport = await load();
      if (!current(request)) return { kind: 'unavailable' };
      return transport.readThreadWatch({
        data: { threadId: request.threadId, viewerId: request.viewerId },
        headers: { 'X-CSRF-Token': request.csrfToken! },
      });
    },
    async set(command: ThreadWatchCommand): Promise<ThreadWatchCommandResult> {
      if (!current(command)) return { kind: 'refused', reason: 'access-lost' };
      const transport = await load();
      if (!current(command)) return { kind: 'refused', reason: 'access-lost' };
      return transport.setThreadWatch({
        data: { threadId: command.threadId, viewerId: command.viewerId, watching: command.watching },
        headers: { 'X-CSRF-Token': command.csrfToken! },
      });
    },
  });
}

export const threadWatchNative = createThreadWatchNative();

type NativeOptions = {
  headers: { authorization: string };
  fetch: { cache: 'no-store' };
};
type NativeResponse = Promise<{ status: number; data?: unknown; error?: unknown }>;
type NativeWatch = {
  get(options: NativeOptions): NativeResponse;
  put(body: undefined, options: NativeOptions): NativeResponse;
  delete(body: undefined, options: NativeOptions): NativeResponse;
};

/** Exact handoff if generated methods are absent: Content's mounted content/routes.ts watch routes. */
export const threadWatchProducer = 'Content: generate GET/PUT/DELETE /v1/threads/:id/watch from content/routes.ts';

export function nativeThreadWatch(client: KernelClient, threadId: string): NativeWatch | undefined {
  const thread = client.threads({ id: threadId }) as ReturnType<KernelClient['threads']> & { watch?: NativeWatch };
  const watch = thread.watch;
  if (
    !watch ||
    typeof watch.get !== 'function' ||
    typeof watch.put !== 'function' ||
    typeof watch.delete !== 'function'
  )
    return undefined;
  return watch;
}

function lost(status: number) {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

/** Generated private GET, used only after current-owner authentication. */
export async function readNativeThreadWatch(
  client: KernelClient,
  threadId: string,
  authorization: string,
): Promise<ThreadWatchReadResult> {
  const auth: NativeOptions = { headers: { authorization }, fetch: { cache: 'no-store' } };
  const watch = nativeThreadWatch(client, threadId);
  if (!watch) return { kind: 'unavailable' };
  try {
    const result = await watch.get(auth);
    if (lost(result.status)) return { kind: 'access-lost' };
    if (result.status !== 200 || result.error) return { kind: result.status >= 400 ? 'unavailable' : 'unknown' };
    const body = result.data;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('watching' in body) ||
      typeof body.watching !== 'boolean'
    )
      return { kind: 'unknown' };
    return { kind: 'confirmed', state: Object.freeze({ watching: body.watching }) };
  } catch {
    return { kind: 'unknown' };
  }
}

/** A 204 confirms the requested operation, with no fabricated versioned read. */
export async function setNativeThreadWatch(
  client: KernelClient,
  threadId: string,
  watching: boolean,
  authorization: string,
): Promise<ThreadWatchCommandResult> {
  const auth: NativeOptions = { headers: { authorization }, fetch: { cache: 'no-store' } };
  const watch = nativeThreadWatch(client, threadId);
  if (!watch) return { kind: 'refused', reason: 'unavailable' };
  try {
    // Both commands are naturally idempotent; neither accepts a receipt key or revision.
    const result = watching ? await watch.put(undefined, auth) : await watch.delete(undefined, auth);
    if (result.status === 204 && !result.error) return { kind: 'confirmed' };
    if (lost(result.status)) return { kind: 'refused', reason: 'access-lost' };
    if (result.status === 429 || result.status === 503) return { kind: 'refused', reason: 'unavailable' };
    if (result.status >= 400 && result.status < 500) return { kind: 'refused', reason: 'refused' };
    // A lost response or unexpected success body cannot confirm the requested operation.
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
