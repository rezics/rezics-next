import type { SettingsAmbient, SettingsTimer } from '../ports/ambient';

const MAX_TIMER_DELAY = 2_147_483_647;

function browserTimer(): SettingsTimer {
  return Object.freeze({
    schedule(callback: () => void, delayMs: number) {
      const id = setTimeout(callback, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY));
      return Object.freeze({ cancel: () => clearTimeout(id) });
    },
  });
}

function nativeSettingsAmbient(): SettingsAmbient {
  return Object.freeze({
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    timer: browserTimer(),
  });
}

/** Browser wall clock, UUID and scheduling. Composition may override any operand. */
export function createBrowserSettingsAmbient(overrides: Partial<SettingsAmbient> = {}): SettingsAmbient {
  const native = nativeSettingsAmbient();
  return Object.freeze({
    now: overrides.now ?? native.now,
    id: overrides.id ?? native.id,
    timer: overrides.timer ?? native.timer,
  });
}

/** Server function wall clock, UUID and scheduling. Same native operands as the browser adapter. */
export function createServerSettingsAmbient(overrides: Partial<SettingsAmbient> = {}): SettingsAmbient {
  return createBrowserSettingsAmbient(overrides);
}

/** Server composition binds the named adapter once per deadline. */
export function serverSettingsTimer(): SettingsTimer {
  return createServerSettingsAmbient().timer;
}
