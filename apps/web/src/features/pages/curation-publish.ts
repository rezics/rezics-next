import { platformRegistry, profileDigest, validateProfile, type PresentationProfile } from '@rezics/composition';
import type { CurationFailure, PublishInput, PublishResult } from './curate';

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
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Mounted publication intent only. The editor remains the sole owner of the draft. */
export class CurationPublication {
  private state: PublicationState = { intent: null, result: null, active: null, readFailure: null, busy: false };
  private listeners = new Set<() => void>();
  private incarnation = 0;
  private active = true;
  private operation: 'publish' | 'read' | null = null;

  constructor(
    readonly reader: string,
    private transport: PublicationTransport,
    private key: () => string = () => crypto.randomUUID(),
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<PublicationState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** A fresh mounted editor owns a new asynchronous incarnation of this reader's retained intent. */
  activate(transport: PublicationTransport) {
    this.incarnation += 1;
    this.active = true;
    this.operation = null;
    this.transport = transport;
    this.update({ busy: false, active: null, readFailure: null });
  }

  /** Retire delayed work while preserving the originating immutable intent and its exact keys. */
  retire() {
    this.incarnation += 1;
    this.active = false;
    const uncertain = this.operation === 'publish' && this.state.intent;
    this.operation = null;
    this.state = {
      ...this.state,
      busy: false,
      active: null,
      readFailure: null,
      ...(uncertain ? { result: { ok: false, reason: 'unavailable', outcome: 'unknown' } as const } : {}),
    };
  }

  async start(profile: PresentationProfile, expectedHead: number): Promise<PublicationConfirmation | null> {
    // A changed draft cannot quietly replace an unresolved operation.
    if (!this.active || this.state.busy || this.state.intent) return null;
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
    this.update({ intent, result: null, active: null, readFailure: null });
    return this.retry();
  }

  async retry(): Promise<PublicationConfirmation | null> {
    const { intent, busy } = this.state;
    if (
      !this.active ||
      !intent ||
      intent.reader !== this.reader ||
      busy ||
      (this.state.result?.ok === false && this.state.result.reason === 'invalid')
    )
      return null;
    const incarnation = this.incarnation;
    const current = () => this.active && this.incarnation === incarnation;
    this.operation = 'publish';
    this.update({ busy: true, readFailure: null });
    let result: PublishResult;
    try {
      // Always cross the BFF, including after a previous receipt or permission denial.
      const input: PublishInput = { profile: intent.profile, expectedHead: intent.expectedHead, keys: intent.keys };
      result = await this.transport.publish(input, this.reader);
      if (result.ok && (result.digest !== profileDigest(intent.profile) || result.head !== intent.expectedHead + 1))
        result = { ok: false, reason: 'unavailable', outcome: 'unknown' };
    } catch {
      result = { ok: false, reason: 'unavailable', outcome: 'unknown' };
    }
    if (!current()) return null;
    this.operation = null;
    this.update({ result });
    if (!result.ok && result.reason === 'stale') await this.readActive(incarnation);
    if (!current()) return null;
    this.update({ busy: false, ...(result.ok ? { intent: null, active: null } : {}) });
    return result.ok ? { intent, result } : null;
  }

  private async readActive(incarnation: number) {
    const current = () => this.active && this.incarnation === incarnation;
    try {
      const read = await this.transport.read(this.reader);
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

  async inspect() {
    if (!this.active || this.state.busy) return;
    const incarnation = this.incarnation;
    const current = () => this.active && this.incarnation === incarnation;
    this.operation = 'read';
    this.update({ busy: true });
    await this.readActive(incarnation);
    if (!current()) return;
    this.operation = null;
    this.update({ busy: false });
  }

  /** Explicit review resolves a CAS refusal; inspecting a matching digest never confirms a write. */
  reconcile(profile: PresentationProfile, choice: 'keep' | 'discard'): ActiveCuration | null {
    const { active, result, busy } = this.state;
    if (
      !this.active ||
      busy ||
      !active ||
      active.reader !== this.reader ||
      !result ||
      result.ok ||
      result.reason !== 'stale'
    )
      return null;
    const reviewed = { ...active, profile: choice === 'keep' ? profile : active.profile };
    this.update({ intent: null, result: null, active: null, readFailure: null });
    return reviewed;
  }

  /** Validation refusal is terminal. A revised body requires a deliberate new intent. */
  async replaceInvalid(profile: PresentationProfile, expectedHead: number) {
    if (!this.active || this.state.busy || this.state.result?.ok !== false || this.state.result.reason !== 'invalid')
      return null;
    // Keep the original refusal and its profile until the revised draft is locally valid.
    if (validateProfile(platformRegistry, profile).length) return null;
    if (this.state.intent && profileDigest(profile) === profileDigest(this.state.intent.profile)) return null;
    this.update({ intent: null, result: null });
    return this.start(profile, expectedHead);
  }
}
