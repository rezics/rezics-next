import { createBrowserInboxAmbient } from '../inbox/adapters/ambient.ts';
import { createBrowserSettingsAmbient } from '../settings/adapters/ambient.ts';
import type { InboxAmbient } from '../inbox/ports/ambient';
import type { SettingsAmbient } from '../settings/ports/ambient';

/** Bound Settings and Inbox clocks for one website process. Composition constructs it once. */
export type PerformanceAmbient = Readonly<{
  settings: SettingsAmbient;
  inbox: InboxAmbient;
}>;

/** Real browser/server clock, UUID and timer adapters for Settings and Inbox. */
export function createPerformanceAmbient(): PerformanceAmbient {
  return Object.freeze({
    settings: createBrowserSettingsAmbient(),
    inbox: createBrowserInboxAmbient(),
  });
}
