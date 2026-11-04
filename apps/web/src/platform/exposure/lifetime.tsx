import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { sessionQuery } from '../../session/query';
import {
  hasExposureGroup,
  type Action,
  type ExposureQuery,
  type ExposureReaderEnvelope,
  type Intent,
  type Outcome,
  type Page,
} from './data';
import { ExposureOperation } from './operation';

export type ExposureBoundIO = {
  read(query?: ExposureQuery): Promise<ExposureReaderEnvelope>;
  change(intent: Intent, query: ExposureQuery, csrfToken: string): Promise<Outcome>;
};

type SessionRecord = { state?: unknown; subject?: unknown; csrfToken?: unknown };
type SessionSnapshot = {
  queryStatus: string;
  state: string;
  subject: string | null;
  csrfToken: string | null;
};
type SessionSource = {
  client: QueryClient;
  read(): SessionSnapshot;
  revision(): number;
  subscribe(listener: () => void): () => void;
  visits: Set<ExposureVisit>;
};
type SessionEvent = 'success' | 'error' | 'removed';
type ReadTicket = {
  readonly generation: number;
  readonly query: ExposureQuery;
  readonly expectedSubject: string;
  readonly revision: number;
};
type CommandTicket = {
  readonly generation: number;
  readonly operation: ExposureOperation;
};

const sources = new WeakMap<QueryClient, SessionSource>();
const unavailable: Page = { status: 'unavailable', discovery: { status: 'unavailable' } };

function sessionSnapshot(client: QueryClient): SessionSnapshot {
  const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  const value = query?.state.data as SessionRecord | undefined;
  return {
    queryStatus: query?.state.status ?? 'pending',
    state: typeof value?.state === 'string' ? value.state : 'unknown',
    subject: typeof value?.subject === 'string' && value.subject.length > 0 ? value.subject : null,
    csrfToken: typeof value?.csrfToken === 'string' && value.csrfToken.length > 0 ? value.csrfToken : null,
  };
}

function signedIn(snapshot: SessionSnapshot): snapshot is SessionSnapshot & { state: 'signed-in'; subject: string } {
  return snapshot.queryStatus === 'success' && snapshot.state === 'signed-in' && !!snapshot.subject;
}

function observeSession(client: QueryClient): SessionSource {
  let revision = 0;
  let previous = sessionSnapshot(client);
  const listeners = new Set<() => void>();
  const visits = new Set<ExposureVisit>();
  const source: SessionSource = {
    client,
    read: () => sessionSnapshot(client),
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visits,
  };

  client.getQueryCache().subscribe((event) => {
    const queryKey = event.query.queryKey;
    if (
      queryKey.length !== sessionQuery.queryKey.length ||
      queryKey.some((part: unknown, index: number) => part !== sessionQuery.queryKey[index])
    )
      return;

    let kind: SessionEvent | null = null;
    if (event.type === 'removed') kind = 'removed';
    else if (event.type === 'updated' && event.action.type === 'success') kind = 'success';
    else if (event.type === 'updated' && event.action.type === 'error') kind = 'error';
    if (!kind) return;

    previous = sessionSnapshot(client);
    const currentRevision = ++revision;
    for (const visit of [...visits]) visit.observeSessionEvent(kind, previous, currentRevision);
    for (const listener of listeners) listener();
  });
  return source;
}

function sessionSource(client: QueryClient): SessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

/** One page visit owns its read admission and at most one immutable command continuation. */
export class ExposureVisit {
  page: Page;
  selection: ExposureQuery = {};
  reading = false;
  operation = new ExposureOperation();
  readonly source: SessionSource;
  readonly client: QueryClient;
  readonly initialEnvelope: ExposureReaderEnvelope;
  private io: ExposureBoundIO;
  private readonly listeners = new Set<() => void>();
  private active = false;
  private retiredRead = false;
  private hasPage: boolean;
  private readerSubject: string | null;
  private expectedSubject: string | null;
  private pendingRead: ReadTicket | null = null;
  private pendingCommand: CommandTicket | null = null;
  private commandIntent: Intent | null = null;
  private commandQuery: ExposureQuery | null = null;
  private readGeneration = 0;
  private commandGeneration = 0;
  private mutationRevision: number;
  private history: ExposureOperation | null;
  private revision = 0;
  private connectionSequence = 0;

  constructor(
    source: SessionSource,
    envelope: ExposureReaderEnvelope,
    io: ExposureBoundIO,
    seed: boolean,
    history: ExposureOperation | null = null,
  ) {
    this.client = source.client;
    this.source = source;
    this.initialEnvelope = envelope;
    this.io = io;
    const observed = source.read();
    const eligibleSeed = seed && signedIn(observed) && envelope.sessionSubject === observed.subject;
    this.readerSubject = eligibleSeed ? envelope.sessionSubject : null;
    this.expectedSubject = signedIn(observed) ? observed.subject : null;
    this.hasPage = eligibleSeed;
    this.page = eligibleSeed ? envelope.page : unavailable;
    this.history = history;
    this.mutationRevision = source.revision();
  }

  updateIO(io: ExposureBoundIO) {
    this.io = io;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.revision;

  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  connect = () => {
    if (this.retiredRead) return () => {};
    this.active = true;
    this.connectionSequence++;
    this.source.visits.add(this);
    this.changed();
    return () => {
      this.active = false;
      const sequence = ++this.connectionSequence;
      // StrictMode reconnects in the same turn. A real unmount retires after that replay window.
      queueMicrotask(() => {
        if (!this.active && this.connectionSequence === sequence) this.retireRead();
      });
    };
  };

  private sessionIsReadable() {
    const observed = this.source.read();
    return signedIn(observed) && (!this.readerSubject || observed.subject === this.readerSubject);
  }

  readCurrent = () =>
    !this.retiredRead &&
    this.source.client === this.client &&
    this.sessionIsReadable() &&
    (!this.expectedSubject || this.source.read().subject === this.expectedSubject);

  private mutationCurrent() {
    const observed = this.source.read();
    return (
      this.active &&
      this.readCurrent() &&
      this.hasPage &&
      !!this.readerSubject &&
      signedIn(observed) &&
      observed.subject === this.readerSubject &&
      this.source.revision() === this.mutationRevision &&
      !!observed.csrfToken
    );
  }

  get currentPage(): Page {
    return this.readCurrent() && this.hasPage ? this.page : unavailable;
  }

  get retired() {
    return this.retiredRead;
  }

  retire(notify = true) {
    this.retireRead(notify);
  }

  get intent(): Intent | null {
    return this.operation.intent;
  }

  get outcome(): Outcome | null {
    return this.operation.outcome;
  }

  get busy() {
    return this.reading || this.pendingCommand !== null || this.operation.busy;
  }

  get canSend() {
    const page = this.currentPage;
    const intent = this.operation.intent;
    return (
      this.mutationCurrent() &&
      !!intent &&
      page.status === 'ready' &&
      hasExposureGroup(page, intent.group) &&
      page.current.actions[intent.action]
    );
  }

  get canReview() {
    const page = this.currentPage;
    return (
      this.mutationCurrent() &&
      page.status === 'ready' &&
      Object.values(page.current.actions).some(Boolean) &&
      !this.busy &&
      !this.operation.intent
    );
  }

  private retainCurrentOperation() {
    const previous = this.operation;
    previous.retire();
    if (previous.intent || previous.outcome) this.history = previous;
    this.operation = new ExposureOperation();
  }

  private cancelPendingRead() {
    this.readGeneration++;
    this.pendingRead = null;
    this.reading = false;
  }

  private retireRead(notify = true) {
    if (this.retiredRead) return;
    this.retiredRead = true;
    this.hasPage = false;
    this.readerSubject = null;
    this.page = unavailable;
    this.selection = {};
    this.cancelPendingRead();
    this.pendingCommand = null;
    this.commandGeneration++;
    this.retainCurrentOperation();
    this.source.visits.delete(this);
    if (notify) this.changed();
  }

  observeSessionEvent(kind: SessionEvent, current: SessionSnapshot, revision: number) {
    if (this.retiredRead) return;
    if (kind !== 'success' || !signedIn(current)) {
      this.retireRead();
      return;
    }

    if (this.readerSubject && current.subject !== this.readerSubject) {
      this.retireRead();
      return;
    }
    if (!this.readerSubject && this.expectedSubject && current.subject !== this.expectedSubject) {
      this.retireRead();
      return;
    }

    // A committed successful replacement invalidates delayed reads and the original CSRF continuation.
    this.cancelPendingRead();
    this.pendingCommand = null;
    this.commandGeneration++;
    this.retainCurrentOperation();
    this.expectedSubject = current.subject;
    this.mutationRevision = revision;
    this.changed();
  }

  review(group: string, action: Action) {
    if (!this.mutationCurrent() || this.busy || this.operation.intent) return false;
    const reviewed = this.operation.review({ group, action, key: crypto.randomUUID(), body: {} });
    if (reviewed) {
      this.commandIntent = null;
      this.commandQuery = null;
      this.changed();
    }
    return reviewed;
  }

  cancel() {
    if (!this.mutationCurrent() || !this.operation.cancel()) return false;
    this.changed();
    return true;
  }

  async read(query: ExposureQuery = this.selection) {
    if (!this.active || !this.readCurrent() || this.reading || this.pendingCommand) return;
    const observed = this.source.read();
    if (!signedIn(observed)) return;
    const ticket: ReadTicket = {
      generation: ++this.readGeneration,
      query: { ...query },
      expectedSubject: observed.subject,
      revision: this.source.revision(),
    };
    this.pendingRead = ticket;
    this.reading = true;
    this.changed();

    let result: ExposureReaderEnvelope | null = null;
    try {
      result = await this.io.read(ticket.query);
    } catch {
      // A failed current read becomes unavailable; obsolete catches have no publication rights.
    }
    if (
      !this.readCurrent() ||
      this.pendingRead !== ticket ||
      ticket.generation !== this.readGeneration ||
      ticket.revision !== this.source.revision()
    )
      return;

    if (
      result &&
      result.sessionSubject === ticket.expectedSubject &&
      this.source.read().subject === ticket.expectedSubject
    ) {
      this.readerSubject = result.sessionSubject;
      this.expectedSubject = result.sessionSubject;
      this.page = result.page;
      this.hasPage = true;
      this.selection = ticket.query;
      this.mutationRevision = this.source.revision();
    } else {
      this.readerSubject = null;
      this.page = unavailable;
      this.hasPage = false;
    }
    this.pendingRead = null;
    this.reading = false;
    this.changed();
  }

  async send() {
    if (!this.canSend || this.busy || !this.operation.intent) return;
    const observed = this.source.read();
    const token = observed.csrfToken;
    if (!token) return;
    const operation = this.operation;
    const intent = operation.intent;
    if (this.commandIntent !== intent || !this.commandQuery) {
      this.commandIntent = intent;
      this.commandQuery = Object.freeze({ ...this.selection });
    }
    const query = this.commandQuery;
    const ticket: CommandTicket = { generation: ++this.commandGeneration, operation };
    this.pendingCommand = ticket;
    this.changed();

    const result = await operation.send(
      (submitted, csrfToken) => this.io.change(submitted, { ...query }, csrfToken ?? token),
      token,
    );

    if (
      this.pendingCommand !== ticket ||
      ticket.operation !== this.operation ||
      ticket.generation !== this.commandGeneration ||
      !this.mutationCurrent()
    )
      return;
    if (result) {
      this.page = result.current;
      this.hasPage = true;
    }
    this.pendingCommand = null;
    this.changed();
  }

  successorHistory() {
    if (this.operation.intent || this.operation.outcome) return this.operation;
    return this.history;
  }
}

/** Observe the installed QueryClient without treating ordinary fetch notifications as session changes. */
export function useExposureVisit(envelope: ExposureReaderEnvelope, io: ExposureBoundIO): ExposureVisit {
  const client = useQueryClient();
  const source = sessionSource(client);
  useSyncExternalStore(source.subscribe, source.revision, () => 0);
  const record = useRef<{
    client: QueryClient;
    source: SessionSource;
    envelope: ExposureReaderEnvelope;
    visit: ExposureVisit;
  } | null>(null);

  const previous = record.current;
  const newInput =
    !previous || previous.client !== client || previous.source !== source || previous.envelope !== envelope;
  if (newInput || previous!.visit.retired) {
    const history = previous?.visit.successorHistory() ?? null;
    previous?.visit.retire(false);
    const seed =
      !previous || (previous.client === client && previous.source === source && previous.envelope !== envelope);
    const visit = new ExposureVisit(source, envelope, io, seed, history);
    record.current = { client, source, envelope, visit };
  }

  const visit = record.current!.visit;
  visit.updateIO(io);
  useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  useLayoutEffect(visit.connect, [visit]);
  return visit;
}
