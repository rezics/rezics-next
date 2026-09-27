'use client';

import { Button } from '@rezics/ui/button';
import { XIcon } from 'lucide-react';
import { useShell } from './shell-provider.tsx';

/** A quiet note when the Account could not keep a display-mode choice; the choice still applies here. */
export function ThemeNotice() {
  const { t, themeNotSaved, dismissThemeNotice } = useShell();
  if (!themeNotSaved) return null;
  return <div role="status" className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 mx-auto
    flex max-w-md items-center gap-2 rounded-2xl border border-border/60 bg-popover px-4 py-2.5 text-popover-foreground
    text-sm shadow-lg md:bottom-4">
    <span className="flex-1">{t.displayModeNotSaved}</span>
    <Button variant="ghost" size="icon-sm" aria-label={t.close} onClick={dismissThemeNotice}>
      <XIcon aria-hidden="true" /></Button>
  </div>;
}
