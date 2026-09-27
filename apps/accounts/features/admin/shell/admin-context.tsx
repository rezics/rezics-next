'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AdminMe, Preferences } from '../api/types.ts';
import { useAdminClient } from '../api/admin-client.tsx';

export type Density = Preferences['density'];
type Permission = AdminMe['permissions'][number];

/** An action the command palette offers while a page shows its subject. */
export interface PaletteAction { id: string; label: string; hint?: string; run(): void }

interface AdminState {
  me: AdminMe;
  can(permission: Permission): boolean;
  density: Density;
  setDensity(density: Density): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  shortcutsOpen: boolean;
  setShortcutsOpen(open: boolean): void;
  pageActions: PaletteAction[];
  setPageActions(actions: PaletteAction[]): void;
}

const Context = createContext<AdminState | null>(null);

export function AdminProvider({ me, density: initialDensity, children }: { me: AdminMe; density: Density;
  children: ReactNode }) {
  const { api } = useAdminClient();
  const [density, setLocalDensity] = useState(initialDensity);
  const current = useRef(initialDensity);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pageActions, setPageActions] = useState<PaletteAction[]>([]);
  // Density is private and reversible: applied at once, saved per operator,
  // put back if the save fails.
  const setDensity = useCallback((next: Density) => {
    const previous = current.current;
    if (previous === next) return;
    current.current = next;
    setLocalDensity(next);
    void api.savePreferences({ density: next }).then(result => {
      if (!result.ok && current.current === next) { current.current = previous; setLocalDensity(previous); }
    });
  }, [api]);
  const value = useMemo<AdminState>(() => ({ me, can: permission => me.permissions.includes(permission), density, setDensity,
    paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen, pageActions, setPageActions }),
  [me, density, setDensity, paletteOpen, shortcutsOpen, pageActions]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAdmin(): AdminState {
  const value = useContext(Context);
  if (!value) throw new Error('useAdmin needs an AdminProvider');
  return value;
}

/** Offers a page's actions in the command palette while it is mounted. */
export function usePaletteActions(actions: PaletteAction[]) {
  const { setPageActions } = useAdmin();
  const latest = useRef(actions);
  useEffect(() => { latest.current = actions; });
  // Re-register only when the offer changes; running reaches the page's latest handler.
  const key = actions.map(action => `${action.id}:${action.label}:${action.hint}`).join('|');
  useEffect(() => {
    setPageActions(latest.current.map(action => ({ ...action,
      run: () => latest.current.find(item => item.id === action.id)?.run() })));
    return () => setPageActions([]);
  }, [key, setPageActions]);
}
