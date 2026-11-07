import { createElement, type ReactElement, type ReactNode } from 'react';
import { InboxAmbientProvider } from '../src/inbox/adapters/ambient-view.tsx';
import { createBrowserInboxAmbient } from '../src/inbox/adapters/ambient.ts';
import { SettingsAmbientProvider } from '../src/settings/adapters/ambient-view.tsx';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient.ts';

export const settingsAmbient = createBrowserSettingsAmbient();
export const inboxAmbient = createBrowserInboxAmbient();

/** Tests bind the same named adapters composition uses. No constructor fallback. */
export function performanceAmbientTree(children: ReactNode): ReactElement {
  return createElement(
    SettingsAmbientProvider,
    { ambient: settingsAmbient },
    createElement(InboxAmbientProvider, { ambient: inboxAmbient }, children),
  );
}
