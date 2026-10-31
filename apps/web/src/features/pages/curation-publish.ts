import { platformRegistry, profileDigest, validateProfile, type PresentationProfile } from '@rezics/composition';
import type { CurationFailure, PublishInput, PublishResult } from './curate';

export type ActiveCuration = { ok: true; profile: PresentationProfile; digest: string; head: number };
export type PublicationRead = ActiveCuration | CurationFailure | { ok: false; reason: 'signed-out' };
export type PublicationTransport = {
  publish: (input: PublishInput) => Promise<PublishResult>;
  read: () => Promise<PublicationRead>;
};
export type PublicationConfirmation = { intent: PublishInput; result: Extract<PublishResult, { ok: true }> };
export type PublicationState = {
  intent: PublishInput | null;
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

  constructor(
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

  async start(profile: PresentationProfile, expectedHead: number): Promise<PublicationConfirmation | null> {
    // A changed draft cannot quietly replace an unresolved operation.
    if (this.state.busy || this.state.intent) return null;
    const errors = validateProfile(platformRegistry, profile);
    if (errors.length) {
      this.update({ result: { ok: false, reason: 'invalid', errors } });
      return null;
    }
    const intent = freeze({
      profile: structuredClone(profile),
      expectedHead,
      keys: { publish: this.key(), activate: this.key() },
    });
    this.update({ intent, result: null, active: null, readFailure: null });
    return this.retry();
  }

  async retry(): Promise<PublicationConfirmation | null> {
    const { intent, busy } = this.state;
    if (!intent || busy || (this.state.result?.ok === false && this.state.result.reason === 'invalid')) return null;
    this.update({ busy: true, readFailure: null });
    let result: PublishResult;
    try {
      // Always cross the BFF, including after a previous receipt or permission denial.
      result = await this.transport.publish(intent);
      if (result.ok && (result.digest !== profileDigest(intent.profile) || result.head !== intent.expectedHead + 1))
        result = { ok: false, reason: 'unavailable', outcome: 'unknown' };
    } catch {
      result = { ok: false, reason: 'unavailable', outcome: 'unknown' };
    }
    this.update({ result });
    if (!result.ok && result.reason === 'stale') await this.readActive();
    this.update({ busy: false, ...(result.ok ? { intent: null, active: null } : {}) });
    return result.ok ? { intent, result } : null;
  }

  private async readActive() {
    try {
      const result = await this.transport.read();
      this.update(result.ok ? { active: result, readFailure: null } : { active: null, readFailure: result });
    } catch {
      this.update({ active: null, readFailure: { ok: false, reason: 'unavailable' } });
    }
  }

  async inspect() {
    if (this.state.busy) return;
    this.update({ busy: true });
    await this.readActive();
    this.update({ busy: false });
  }

  /** Explicit review resolves a CAS refusal; inspecting a matching digest never confirms a write. */
  reconcile(profile: PresentationProfile, choice: 'keep' | 'discard'): ActiveCuration | null {
    const { active, result, busy } = this.state;
    if (busy || !active || !result || result.ok || result.reason !== 'stale') return null;
    const reviewed = { ...active, profile: choice === 'keep' ? profile : active.profile };
    this.update({ intent: null, result: null, active: null, readFailure: null });
    return reviewed;
  }

  /** Validation refusal is terminal. A revised body requires a deliberate new intent. */
  async replaceInvalid(profile: PresentationProfile, expectedHead: number) {
    if (this.state.busy || this.state.result?.ok !== false || this.state.result.reason !== 'invalid') return null;
    // Keep the original refusal and its profile until the revised draft is locally valid.
    if (validateProfile(platformRegistry, profile).length) return null;
    if (this.state.intent && profileDigest(profile) === profileDigest(this.state.intent.profile)) return null;
    this.update({ intent: null, result: null });
    return this.start(profile, expectedHead);
  }
}
