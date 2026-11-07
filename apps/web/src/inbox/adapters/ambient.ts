import type { InboxAmbient, InboxTimer } from '../ports/ambient';

const MAX_TIMER_DELAY = 2_147_483_647;

function browserTimer(): InboxTimer {
  return Object.freeze({
    schedule(callback: () => void, delayMs: number) {
      const id = setTimeout(callback, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY));
      return Object.freeze({ cancel: () => clearTimeout(id) });
    },
  });
}

function nativeInboxAmbient(): InboxAmbient {
  return Object.freeze({
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    timer: browserTimer(),
  });
}

/** Browser wall clock, UUID and scheduling. Composition may override any operand. */
export function createBrowserInboxAmbient(overrides: Partial<InboxAmbient> = {}): InboxAmbient {
  const native = nativeInboxAmbient();
  return Object.freeze({
    now: overrides.now ?? native.now,
    id: overrides.id ?? native.id,
    timer: overrides.timer ?? native.timer,
  });
}

/** Server function wall clock, UUID and scheduling. Same native operands as the browser adapter. */
export function createServerInboxAmbient(overrides: Partial<InboxAmbient> = {}): InboxAmbient {
  return createBrowserInboxAmbient(overrides);
}
