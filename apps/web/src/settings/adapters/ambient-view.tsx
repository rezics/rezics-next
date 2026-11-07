import { createContext, useContext, type ReactNode } from 'react';
import type { SettingsAmbient } from '../ports/ambient';

const SettingsAmbientContext = createContext<SettingsAmbient | null>(null);

/** Route and page composition bind the real adapter. Cards and hooks read it here. */
export function SettingsAmbientProvider({ ambient, children }: { ambient: SettingsAmbient; children: ReactNode }) {
  return <SettingsAmbientContext.Provider value={ambient}>{children}</SettingsAmbientContext.Provider>;
}

export function useSettingsAmbient(): SettingsAmbient {
  const ambient = useContext(SettingsAmbientContext);
  if (ambient) return ambient;
  throw new Error('SettingsAmbientProvider is required');
}

export { createBrowserSettingsAmbient, createServerSettingsAmbient } from './ambient.ts';
