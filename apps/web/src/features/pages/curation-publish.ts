import { platformRegistry, profileDigest, validateProfile, type PresentationProfile } from '@rezics/composition';
import type { CurationFailure, PublishInput, PublishResult } from './curate';
import type { CurationAdmissionLease } from './curation-reader-admission';
import { admitPublicationRetry, publicationRetryAt } from './curation-retry-admission';

export type ActiveCuration = { ok: true; reader: string; profile: PresentationProfile; digest: string; head: number };
export type PublicationRead = ActiveCuration | CurationFailure | { ok: false; reason: 'signed-out' };
export type PublicationTransport = {
  publish: (input: PublishInput, expectedReader: string) => Promise<PublishResult>;
  read: (expectedReader: string) => Promise<PublicationRead>;
};
export type PublicationIntent = PublishInput & { reader: string };
export type PublicationConfirmation = { intent: PublicationIntent; result: Extract<PublishResult, { ok: true }> };
export type PublicationState = {
  intent: PublicationIntent | null;
  result: PublishResult | null;
  active: ActiveCuration | null;
  readFailure: Exclude<PublicationRead, { ok: true }> | null;
  busy: boolean;
  retryAt?: number | undefined;
};

export type CurationPublicationVisit = {
  readonly incarnation: number;
  isCurrent(): boolean;
  start(profile: PresentationProfile, expectedHead: number): Promise<PublicationConfirmation | null>;
  retry(): Promise<PublicationConfirmation | null>;
  inspect(): Promise<void>;
  reconcile(profile: PresentationProfile, choice: 'keep' | 'discard'): ActiveCuration | null;
  replaceInvalid(profile: PresentationProfile, expectedHead: number): Promise<PublicationConfirmation | null>;
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const retainedPublications = new Map<string, CurationPublication>();

/** Retain only unresolved publication custody across a mounted reader's retirement or unmount. */
export function retainedCurationPublication(reader: string, transport: PublicationTransport): CurationPublication {
  return retainedPublications.get(reader) ?? new CurationPublication(reader, transport, undefined, true);
}

/** Mounted publication intent only. The editor remains the sole owner of the draft. */
export class CurationPublication {
  private state: PublicationState = { intent: null, result: null, active: null, readFailure: null, busy: false };
  private listeners = new Set<() => void>();
  private incarnation = 0;
  private active = true;
  private operation: 'publish' | 'read' | null = null;
  private lease: CurationAdmissionLease | null = null;
  private stopLease: (() => void) | null = null;

  constructor(
    readonly reader: string,
    private transport: PublicationTransport,
    private key: () => string = () => crypto.randomUUID(),
    private readonly retainAcrossVisits = false,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<PublicationState>, notify = true) {
    this.state = { ...this.state, ...change };
    if (this.retainAcrossVisits) {
      if (this.state.intent) retainedPublications.set(this.reader, this);
      else if (retainedPublications.get(this.reader) === this) retainedPublications.delete(this.reader);
    }
    if (notify) for (const listener of this.listeners) listener();
  }

  /** A fresh mounted editor owns a new asynchronous incarnation of this reader's retained intent. */
  activate(transport: PublicationTransport, lease: CurationAdmissionLease | null = null): CurationPublicationVisit {
    this.stopLease?.();
    this.stopLease = null;
    this.incarnation += 1;
    this.active = true;
    this.operation = null;
    this.transport = transport;
    this.lease = lease;
    const visit = this.visit(this.incarnation);
    this.stopLease = lease?.onRetire((silent) => this.retire(visit, !silent)) ?? null;
    this.update({
      busy: false,
      active: null,
      readFailure: null,
      ...(this.state.intent ? {} : { result: null, retryAt: undefined }),
    });
    return visit;
  }

  /** Retire delayed work while preserving the originating immutable intent and its exact keys. */
  retire(visit?: CurationPublicationVisit, notify = true) {
    if (visit && visit.incarnation !== this.incarnation) return;
    if (!this.active && !this.operation) return;
    this.incarnation += 1;
    this.active = false;
    const uncertain = this.operation === 'publish' && this.state.intent;
    this.operation = null;
    this.stopLease?.();
    this.stopLease = null;
    this.update(
      {
        busy: false,
        active: null,
        readFailure: null,
        ...(uncertain ? { result: { ok: false, reason: 'unavailable', outcome: 'unknown' } as const } : {}),
      },
      notify,
    );
  }

  private visit(incarnation: number): CurationPublicationVisit {
    return {
      incarnation,
      isCurrent: () => this.isCurrent(incarnation),
      start: (profile, expectedHead) => this.start(profile, expectedHead, incarnation),
      retry: () => this.retry(incarnation),
      inspect: () => this.inspect(incarnation),
      reconcile: (profile, choice) => this.reconcile(profile, choice, incarnation),
      replaceInvalid: (profile, expectedHead) => this.replaceInvalid(profile, expectedHead, incarnation),
    };
  }

  private isCurrent(incarnation: number): boolean {
    if (!this.active || this.incarnation !== incarnation) return false;
    if (this.lease && !this.lease.isCurrent()) {
      this.retire(this.visit(incarnation));
      return false;
    }
    return this.active && this.incarnation === incarnation;
  }

  /** Install a transport for future commands; each in-flight operation keeps its own captured value. */
  setTransport(transport: PublicationTransport) {
    this.transport = transport;
  }

  async start(
    profile: PresentationProfile,
    expectedHead: number,
    expectedIncarnation = this.incarnation,
  ): Promise<PublicationConfirmation | null> {
    // A changed draft cannot quietly replace an unresolved operation.
    if (!this.isCurrent(expectedIncarnation) || this.state.busy || this.state.intent) return null;
    const errors = validateProfile(platformRegistry, profile);
    if (errors.length) {
      this.update({ result: { ok: false, reason: 'invalid', errors } });
      return null;
    }
    const intent = freeze({
      reader: this.reader,
      profile: structuredClone(profile),
      expectedHead,
      keys: { publish: this.key(), activate: this.key() },
    });
    this.update({ intent, result: null, active: null, readFailure: null, retryAt: undefined });
    return this.retry(expectedIncarnation);
  }

  async retry(expectedIncarnation = this.incarnation): Promise<PublicationConfirmation | null> {
    const { intent, busy } = this.state;
    if (
      !this.isCurrent(expectedIncarnation) ||
      !intent ||
      intent.reader !== this.reader ||
      busy ||
      !admitPublicationRetry(this.state.retryAt) ||
      (this.state.result?.ok === false &&
        this.state.result.reason === 'invalid' &&
        this.state.result.phase !== 'activate')
    )
      return null;
    const incarnation = expectedIncarnation;
    const current = () => this.isCurrent(incarnation);
    const transport = this.transport;
    this.operation = 'publish';
    this.update({ busy: true, readFailure: null });
    let result: PublishResult;
    try {
      // Always cross the BFF, including after a previous receipt or permission denial.
      const input: PublishInput = { profile: intent.profile, expectedHead: intent.expectedHead, keys: intent.keys };
      result = await transport.publish(input, this.reader);
      if (result.ok && (result.digest !== profileDigest(intent.profile) || result.head !== intent.expectedHead + 1))
        result = { ok: false, reason: 'unavailable', outcome: 'unknown' };
    } catch {
      result = { ok: false, reason: 'unavailable', outcome: 'unknown' };
    }
    if (!current()) return null;
    this.operation = null;
    this.update({
      result,
      retryAt: !result.ok && result.reason === 'rate-limited' ? publicationRetryAt(result.retryAfter) : undefined,
    });
    if (!result.ok && result.reason === 'stale') await this.readActive(incarnation, transport);
    if (!current()) return null;
    this.update({ busy: false, ...(result.ok ? { intent: null, active: null } : {}) });
    return result.ok ? { intent, result } : null;
  }

  private async readActive(incarnation: number, transport: PublicationTransport) {
    const current = () => this.isCurrent(incarnation);
    try {
      const read = await transport.read(this.reader);
      if (!current()) return;
      const result =
        read.ok && read.reader !== this.reader
          ? { ok: false as const, reason: 'forbidden' as const, admissionChanged: true }
          : read;
      this.update(result.ok ? { active: result, readFailure: null } : { active: null, readFailure: result });
    } catch {
      if (!current()) return;
      this.update({ active: null, readFailure: { ok: false, reason: 'unavailable' } });
    }
  }

  async inspect(expectedIncarnation = this.incarnation) {
    if (!this.isCurrent(expectedIncarnation) || this.state.busy) return;
    const incarnation = expectedIncarnation;
    const current = () => this.isCurrent(incarnation);
    const transport = this.transport;
    this.operation = 'read';
    this.update({ busy: true });
    await this.readActive(incarnation, transport);
    if (!current()) return;
    this.operation = null;
    this.update({ busy: false });
  }

  /** Explicit review resolves a CAS refusal; inspecting a matching digest never confirms a write. */
  reconcile(
    profile: PresentationProfile,
    choice: 'keep' | 'discard',
    expectedIncarnation = this.incarnation,
  ): ActiveCuration | null {
    const { active, result, busy } = this.state;
    if (
      !this.isCurrent(expectedIncarnation) ||
      busy ||
      !active ||
      active.reader !== this.reader ||
      !result ||
      result.ok ||
      result.reason !== 'stale'
    )
      return null;
    const reviewed = { ...active, profile: choice === 'keep' ? profile : active.profile };
    this.update({ intent: null, result: null, active: null, readFailure: null, retryAt: undefined });
    return reviewed;
  }

  /** Validation refusal is terminal. A revised body requires a deliberate new intent. */
  async replaceInvalid(profile: PresentationProfile, expectedHead: number, expectedIncarnation = this.incarnation) {
    if (
      !this.isCurrent(expectedIncarnation) ||
      this.state.busy ||
      this.state.result?.ok !== false ||
      this.state.result.reason !== 'invalid' ||
      this.state.result.phase === 'activate'
    )
      return null;
    // Keep the original refusal and its profile until the revised draft is locally valid.
    if (validateProfile(platformRegistry, profile).length) return null;
    if (this.state.intent && profileDigest(profile) === profileDigest(this.state.intent.profile)) return null;
    this.update({ intent: null, result: null, retryAt: undefined });
    return this.start(profile, expectedHead, expectedIncarnation);
  }
}
