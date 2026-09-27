import type { AutosaveState } from '@rezics/ui/autosave-status';

/** What one draft save did, as the editor needs to react to it. */
export type SaveOutcome =
  | { kind: 'saved'; head: string }
  /** The expected head moved: someone saved first. Nothing was written. */
  | { kind: 'conflict' }
  /** The request never reached Main (or its answer never came back). */
  | { kind: 'offline' }
  /** Main refused this Agent; retrying cannot help. */
  | { kind: 'denied' }
  | { kind: 'failed'; retryable: boolean };

export interface AutosaveSnapshot {
  state: AutosaveState;
  /** The draft head this editor writes on, or null before the first save. */
  head: string | null;
  savedAt: Date | null;
  /** The text at `head`, what Main holds. */
  saved: string;
  denied: boolean;
}

export interface AutosaveOptions {
  head: string | null;
  body: string;
  /** Saves `body` on `expectedHead`. The key is reused while the same text is retried on the same head,
   * so a save whose answer was lost replays instead of forking the draft. */
  save: (body: string, expectedHead: string | null, idempotencyKey: string) => Promise<SaveOutcome>;
  /** Keeps unsaved text on this device, written on the head it was typed on. */
  keep: (body: string, base: string | null) => void;
  /** Main holds the text; the device copy can go. */
  release: () => void;
  /** Quiet time after typing before a save. */
  delay?: number;
  now?: () => Date;
  newKey?: () => string;
}

const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * The autosave state machine behind the chapter editor, without React: debounced saves on the
 * current head, one request at a time, device copies while unsaved, offline and failure retries,
 * and a stop at a conflict until the writer keeps their text or takes Main's.
 */
export class DraftAutosave {
  #snapshot: AutosaveSnapshot;
  #current: string;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;
  /** A save sent without a definite answer, replayed before anything newer. */
  #doubt: { body: string; head: string | null; key: string } | null = null;
  #failures = 0;
  #listeners = new Set<() => void>();
  readonly #options: Required<AutosaveOptions>;

  constructor(options: AutosaveOptions) {
    this.#options = { delay: 1_500, now: () => new Date(), newKey: () => crypto.randomUUID(), ...options };
    this.#current = options.body;
    this.#snapshot = { state: 'idle', head: options.head, savedAt: null, saved: options.body, denied: false };
  }

  get snapshot(): AutosaveSnapshot { return this.#snapshot; }
  get text(): string { return this.#current; }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #set(patch: Partial<AutosaveSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #schedule(delay: number) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, delay);
  }

  /** The writer typed. The text is kept on the device at once and saved after a pause. */
  edit(body: string) {
    this.#current = body;
    const { state, head, saved, denied } = this.#snapshot;
    if (body === saved) this.#options.release();
    else this.#options.keep(body, head);
    if (state === 'conflict' || denied) return;
    if (state !== 'offline' && state !== 'error') this.#set({ state: body === saved ? 'saved' : 'unsaved' });
    if (body !== saved) this.#schedule(this.#options.delay);
  }

  /** Saves now: on blur, when the tab hides, when the network returns, or on Retry. */
  async flush(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#snapshot.state === 'conflict' || this.#snapshot.denied) return;
    // The running save reschedules itself when the text moved on while it was in flight.
    if (this.#inFlight) return this.#inFlight;
    // A save whose answer never came may have landed. Replaying it (same text, head and key) makes Main
    // answer with that save's receipt; sending newer text on the same head first would conflict with it.
    const attempt = this.#doubt ?? (this.#current === this.#snapshot.saved ? null
      : { body: this.#current, head: this.#snapshot.head, key: this.#options.newKey() });
    if (!attempt) {
      if (this.#snapshot.state !== 'idle') this.#set({ state: this.#snapshot.savedAt ? 'saved' : 'idle' });
      return;
    }
    this.#set({ state: 'saving' });
    this.#inFlight = this.#run(attempt);
    try { await this.#inFlight; } finally { this.#inFlight = null; }
  }

  async #run(attempt: { body: string; head: string | null; key: string }): Promise<void> {
    let outcome: SaveOutcome;
    try { outcome = await this.#options.save(attempt.body, attempt.head, attempt.key); }
    catch { outcome = { kind: 'offline' }; }
    this.#doubt = outcome.kind === 'offline' || (outcome.kind === 'failed' && outcome.retryable) ? attempt : null;
    switch (outcome.kind) {
      case 'saved': {
        this.#failures = 0;
        const done = this.#current === attempt.body;
        if (done) this.#options.release();
        else this.#options.keep(this.#current, outcome.head);
        this.#set({ head: outcome.head, saved: attempt.body, savedAt: this.#options.now(),
          state: done ? 'saved' : 'unsaved' });
        if (!done) this.#schedule(this.#options.delay);
        return;
      }
      case 'conflict':
        this.#set({ state: 'conflict' });
        return;
      case 'denied':
        this.#set({ state: 'error', denied: true });
        return;
      case 'offline':
        this.#set({ state: 'offline' });
        this.#retry();
        return;
      case 'failed':
        this.#set({ state: 'error' });
        if (outcome.retryable) this.#retry();
    }
  }

  #retry() {
    this.#schedule(RETRY_MS[Math.min(this.#failures, RETRY_MS.length - 1)]!);
    this.#failures += 1;
  }

  /** Main moved while this device held unsaved text (found on load): stop until the writer chooses. */
  markConflict(mine: string) {
    this.#current = mine;
    this.#set({ state: 'conflict' });
  }

  /** Keep my text: save it on top of the head someone else wrote. */
  keepMine(theirHead: string | null) {
    this.#doubt = null;
    this.#set({ state: 'unsaved', head: theirHead });
    this.#options.keep(this.#current, theirHead);
    void this.flush();
  }

  /** Take their text: my unsaved text is dropped from the editor and the device. */
  takeTheirs(theirHead: string | null, theirBody: string) {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#doubt = null;
    this.#current = theirBody;
    this.#options.release();
    this.#set({ state: 'saved', head: theirHead, saved: theirBody, savedAt: this.#options.now() });
  }

  /** Stops a pending save; the device copy stays for the next visit. Subscribers unsubscribe themselves. */
  dispose() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
