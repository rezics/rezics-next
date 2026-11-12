import type { RecoveryObservation, RecoveryObserver } from './application';
import type { Locale } from '../paraglide/runtime.js';
import {
  HOSTED_CHECKPOINT_PREDECESSORS,
  type HostedCheckpointRead,
  type HostedCheckpointResult,
} from './hosted-checkpoint-source';

export type HostedCheckpointWindowSnapshot = {
  result: HostedCheckpointResult | { state: 'loading' };
  busy: boolean;
  cursor: string | null;
  previous: boolean;
  first: boolean;
};
type Movement = { cursor: string | null; direction: 'first' | 'next' | 'previous' | 'refresh' };
const withdrawn: HostedCheckpointWindowSnapshot = {
  result: { state: 'loading' }, busy: true, cursor: null, previous: false, first: false,
};

/** A single private replacement page, eight accepted predecessors and one in-flight native read. */
export class HostedCheckpointWindow {
  private owner: RecoveryObservation;
  private snapshot: HostedCheckpointWindowSnapshot = withdrawn;
  private path: (string | null)[] = [];
  private accepted: string | null = null;
  private movement: Movement = { cursor: null, direction: 'first' };
  private listeners = new Set<() => void>();
  private stopObserver: (() => void) | undefined;
  private request: AbortController | undefined;
  private active = false;
  private episode = 0;

  constructor(private readonly observer: RecoveryObserver, private readonly locale: Locale, private readonly read: HostedCheckpointRead) {
    this.owner = observer.read();
  }

  /** Identity comparison withdraws old data even before React processes the observer notification. */
  getSnapshot = (): HostedCheckpointWindowSnapshot =>
    this.observer.read().identity === this.owner.identity ? this.snapshot : withdrawn;
  getServerSnapshot = (): HostedCheckpointWindowSnapshot => withdrawn;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start() {
    this.active = true;
    this.owner = this.observer.read();
    this.stopObserver = this.observer.subscribe(this.observe);
    this.reset();
    return () => this.dispose();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private observe = () => {
    const owner = this.observer.read();
    if (owner.identity === this.owner.identity) return;
    this.owner = owner;
    this.reset();
  };

  private reset() {
    this.request?.abort();
    this.episode += 1;
    this.path = [];
    this.accepted = null;
    this.movement = { cursor: null, direction: 'first' };
    if (!this.owner.subject) {
      this.snapshot = { result: { state: 'signed-out' }, busy: false, cursor: null, previous: false, first: false };
      this.emit();
      return;
    }
    void this.load(this.movement);
  }

  private current(owner: RecoveryObservation, episode: number) {
    return this.active && episode === this.episode && owner.identity === this.observer.read().identity;
  }

  private async load(movement: Movement) {
    const owner = this.owner;
    if (!this.active || !owner.subject || owner.identity !== this.observer.read().identity) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const episode = ++this.episode;
    this.movement = movement;
    this.snapshot = {
      result: { state: 'loading' }, busy: true, cursor: movement.cursor, previous: false, first: movement.cursor !== null,
    };
    this.emit();
    let result: HostedCheckpointResult;
    try {
      result = await this.read({
        viewer: owner.subject, locale: this.locale,
        ...(movement.cursor === null ? {} : { cursor: movement.cursor }),
      }, request.signal);
    } catch (error) {
      if (!this.current(owner, episode) || request.signal.aborted) return;
      // A rejected browser/server transport is a failed read, never an empty page.
      result = { state: 'unavailable' };
    }
    if (!this.current(owner, episode) || request.signal.aborted) return;
    if (result.state === 'loaded') {
      if (movement.direction === 'first') this.path = [];
      if (movement.direction === 'next') this.path = [...this.path, this.accepted].slice(-HOSTED_CHECKPOINT_PREDECESSORS);
      if (movement.direction === 'previous') this.path = this.path.slice(0, -1);
      this.accepted = movement.cursor;
    } else if (result.state === 'signed-out' || result.state === 'denied' || result.state === 'stale') {
      this.path = [];
      this.accepted = null;
    }
    this.snapshot = {
      result, busy: false, cursor: movement.cursor,
      previous: result.state === 'loaded' && this.path.length > 0,
      first: movement.cursor !== null || result.state === 'stale',
    };
    this.emit();
  }

  /** Controls capture the displayed snapshot; callbacks from retired pages cannot navigate a new owner. */
  private canUse(snapshot: HostedCheckpointWindowSnapshot) {
    return this.active && snapshot === this.snapshot && !snapshot.busy && this.owner.identity === this.observer.read().identity;
  }
  next(snapshot: HostedCheckpointWindowSnapshot) {
    if (!this.canUse(snapshot) || snapshot.result.state !== 'loaded' || !snapshot.result.nextCursor) return;
    void this.load({ cursor: snapshot.result.nextCursor, direction: 'next' });
  }
  previous(snapshot: HostedCheckpointWindowSnapshot) {
    if (!this.canUse(snapshot) || !snapshot.previous) return;
    void this.load({ cursor: this.path[this.path.length - 1]!, direction: 'previous' });
  }
  first(snapshot: HostedCheckpointWindowSnapshot) {
    if (!this.canUse(snapshot)) return;
    void this.load({ cursor: null, direction: 'first' });
  }
  retry(snapshot: HostedCheckpointWindowSnapshot) {
    if (!this.canUse(snapshot) || snapshot.result.state !== 'unavailable') return;
    void this.load(this.movement);
  }
  refresh(snapshot: HostedCheckpointWindowSnapshot) {
    if (!this.canUse(snapshot) || snapshot.result.state !== 'loaded') return;
    void this.load({ cursor: this.accepted, direction: 'refresh' });
  }
  dispose() {
    this.active = false;
    this.episode += 1;
    this.stopObserver?.();
    this.stopObserver = undefined;
    this.request?.abort();
    this.request = undefined;
    this.path = [];
    this.accepted = null;
    this.snapshot = withdrawn;
    this.emit();
  }
}
