import type { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../session/query';

export type PostCommandSession = {
  state?: string;
  subject?: string | null;
  csrfToken?: string | null;
};

export type PostCommandSessionSource = {
  client: QueryClient | undefined;
  read: () => PostCommandSession | undefined;
  snapshot: () => number;
  serverSnapshot: () => 0;
  subscribe: (notify: () => void) => () => void;
};

const emptySource: PostCommandSessionSource = {
  client: undefined,
  read: () => undefined,
  snapshot: () => 0,
  serverSnapshot: () => 0,
  subscribe: () => () => {},
};

const sources = new WeakMap<QueryClient, PostCommandSessionSource>();

/** Observe only the existing session cache. A successful replacement is a new caller visit, even if identical. */
export function postCommandSessionSource(client: QueryClient | undefined): PostCommandSessionSource {
  if (!client) return emptySource;
  const existing = sources.get(client);
  if (existing) return existing;

  const read = () => client.getQueryData<PostCommandSession>(sessionQuery.queryKey);
  const identity = () => {
    const session = read();
    return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    const next = identity();
    const replaced =
      event.type === 'added' ||
      event.type === 'removed' ||
      (event.type === 'updated' && event.action.type === 'success');
    if (next === previous && !replaced) return;
    previous = next;
    revision += 1;
    for (const listener of listeners) listener();
  });

  const source: PostCommandSessionSource = {
    client,
    read,
    snapshot: () => revision,
    serverSnapshot: () => 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  sources.set(client, source);
  return source;
}

export function postCommandSessionIdentity(session: PostCommandSession | undefined) {
  return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
}

export type PostCommandBinding = {
  client: QueryClient | undefined;
  source: PostCommandSessionSource;
  sourceRevision: number;
  session: PostCommandSession | undefined;
  readAuthority: object | undefined;
  postId: string;
  threadId: string;
  revisionId: string | undefined;
  authorId: string | undefined;
  availability: string;
  restorableUntil: string | undefined;
  target: { kind: 'thread' | 'post'; id: string };
  signedIn: boolean;
  personalReady: boolean;
  viewerId: string | undefined;
};

export type PostCommandIntent = {
  episode: number;
  eraseKey: string | undefined;
  erasePending: boolean;
  eraseApplied: boolean;
  restoreKey: string | undefined;
  restorePending: boolean;
  restoreApplied: boolean;
  restoreUncertain: boolean;
  locallyDeleted: boolean;
  read: number;
};

let lifetimeSequence = 0;

function normalizedSession(session: PostCommandSession | undefined) {
  return {
    state: session?.state ?? 'unknown',
    subject: session?.subject ?? null,
    csrfToken: session?.csrfToken ?? null,
  };
}

function sameTarget(left: PostCommandBinding['target'], right: PostCommandBinding['target']) {
  return left.kind === right.kind && left.id === right.id;
}

function sameBinding(left: PostCommandBinding, right: PostCommandBinding) {
  return (
    left.client === right.client &&
    left.source === right.source &&
    left.sourceRevision === right.sourceRevision &&
    postCommandSessionIdentity(left.session) === postCommandSessionIdentity(right.session) &&
    left.readAuthority === right.readAuthority &&
    left.postId === right.postId &&
    left.threadId === right.threadId &&
    left.revisionId === right.revisionId &&
    left.authorId === right.authorId &&
    left.availability === right.availability &&
    left.restorableUntil === right.restorableUntil &&
    sameTarget(left.target, right.target) &&
    left.signedIn === right.signedIn &&
    left.personalReady === right.personalReady &&
    left.viewerId === right.viewerId
  );
}

/** One post caller visit. Its cache revision, native identity and mounted connection never regain old authority. */
export class PostCommandLifetime {
  readonly id = ++lifetimeSequence;
  readonly session: ReturnType<typeof normalizedSession>;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly revisionId: string | undefined;
  readonly intent: PostCommandIntent = {
    episode: 0,
    eraseKey: undefined,
    erasePending: false,
    eraseApplied: false,
    restoreKey: undefined,
    restorePending: false,
    restoreApplied: false,
    restoreUncertain: false,
    locallyDeleted: false,
    read: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly ownerRevision: number;
  private revision = 0;
  private connection = 0;
  private connected = false;
  private retired = false;

  constructor(
    readonly binding: PostCommandBinding,
    private readonly currentBinding: () => PostCommandBinding,
  ) {
    this.ownerRevision = binding.sourceRevision;
    this.session = normalizedSession(binding.session);
    this.csrfToken = this.session.csrfToken ?? '';
    this.accountId = this.session.state === 'signed-in' ? (this.session.subject ?? '') : '';
    this.revisionId = binding.revisionId;
  }

  private notify() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  private retire() {
    if (this.retired) return;
    this.retired = true;
    this.connected = false;
    this.connection += 1;
    this.notify();
  }

  private checkOwner() {
    if (this.retired) return;
    const current = this.currentBinding();
    const session = this.binding.source.read();
    if (
      this.binding.source.client !== this.binding.client ||
      this.binding.source.snapshot() !== this.ownerRevision ||
      !sameBinding(this.binding, current) ||
      postCommandSessionIdentity(session) !== postCommandSessionIdentity(this.binding.session)
    )
      this.retire();
  }

  snapshot = () => {
    this.checkOwner();
    return this.revision;
  };
  serverSnapshot = () => 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get connectionTicket() {
    return this.connection;
  }

  /** Strict Effects may reconnect this visit, but callbacks from the earlier connection stay obsolete. */
  connect = () => {
    if (this.retired) return () => {};
    this.connected = true;
    const ticket = ++this.connection;
    this.notify();
    return () => {
      if (!this.connected || ticket !== this.connection) return;
      this.connected = false;
      const disconnected = ++this.connection;
      this.notify();
      queueMicrotask(() => {
        if (!this.connected && this.connection === disconnected) this.retire();
      });
    };
  };

  isCurrent = (ticket: number) => {
    this.checkOwner();
    return !this.retired && this.connected && ticket === this.connection;
  };

  isCommandReady = (ticket: number) => {
    if (!this.isCurrent(ticket) || !this.binding.client) return false;
    const session = normalizedSession(this.binding.source.read());
    return (
      this.binding.signedIn &&
      this.binding.personalReady &&
      session.state === 'signed-in' &&
      Boolean(session.subject) &&
      Boolean(session.csrfToken) &&
      session.subject === this.binding.viewerId &&
      this.accountId === session.subject &&
      this.csrfToken === session.csrfToken
    );
  };

  continuesAfterOwnWrite(post: {
    id: string;
    threadId: string;
    revisionId?: string | undefined;
    availability: string;
  }) {
    return (
      post.id === this.binding.postId &&
      post.threadId === this.binding.threadId &&
      (((this.intent.eraseApplied || this.intent.locallyDeleted) &&
        post.availability === 'erased' &&
        (post.revisionId === undefined || post.revisionId === this.binding.revisionId)) ||
        (this.intent.restoreApplied &&
          post.availability === 'available' &&
          post.revisionId === this.binding.revisionId))
    );
  }
}
