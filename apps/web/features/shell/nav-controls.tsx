'use client';

import { Button } from '@rezics/ui/button';
import { MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { useShell } from './shell-provider.tsx';

export const SIDE_NAVIGATION_ID = 'side-navigation';

/** Desktop: collapses the side navigation to an icon rail and back. */
export function NavCollapseToggle() {
  const { t, collapsed, setCollapsed } = useShell();
  const label = collapsed ? t.expandNavigation : t.collapseNavigation;
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return <Button variant="ghost" size="icon-md" aria-label={label} title={label} aria-expanded={!collapsed}
    aria-controls={SIDE_NAVIGATION_ID} onClick={() => setCollapsed(!collapsed)}
    className="hidden text-muted-foreground md:inline-flex">
    <Icon aria-hidden="true" className="size-5" />
  </Button>;
}

// The drawer's sheet brings a dialog, focus trap and scroll area that pages without dialogs otherwise never load.
const NavDrawerSheet = lazy(() => import('./nav-drawer-sheet.tsx'));
const warm = () => { void import('./nav-drawer-sheet.tsx'); };

/** Phones: the side navigation in a drawer, loaded when the reader first reaches for it. */
export function NavDrawer({ communities }: { communities?: ReactNode }) {
  const { t } = useShell();
  const pathname = usePathname();
  // Remember where the drawer opened: any navigation closes it without an effect.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);
  return <>
    <Button variant="ghost" size="icon-md" aria-label={t.openNavigation} aria-haspopup="dialog"
      aria-expanded={open} onPointerEnter={warm} onFocus={warm} onTouchStart={warm}
      onClick={() => { setMounted(true); setOpen(true); }} className="text-muted-foreground md:hidden">
      <MenuIcon aria-hidden="true" className="size-5" />
    </Button>
    {mounted ? <Suspense fallback={null}>
      <NavDrawerSheet open={open} onOpenChange={setOpen} communities={communities} />
    </Suspense> : null}
  </>;
}
