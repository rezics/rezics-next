'use client';

import { Button } from '@rezics/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@rezics/ui/sheet';
import { MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { LogoMark } from './logo.tsx';
import { useShell } from './shell-provider.tsx';
import { SideNav } from './side-nav.tsx';

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

/** Phones: the side navigation and preferences in a drawer. */
export function NavDrawer() {
  const { t } = useShell();
  const pathname = usePathname();
  // Remember where the drawer opened: any navigation closes it without an effect.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);
  return <Sheet open={open} onOpenChange={details => setOpen(details.open)}>
    <Button variant="ghost" size="icon-md" aria-label={t.openNavigation} aria-haspopup="dialog"
      aria-expanded={open} onClick={() => setOpen(true)} className="text-muted-foreground md:hidden">
      <MenuIcon aria-hidden="true" className="size-5" />
    </Button>
    <SheetContent placement="left" showCloseButton={false} className="w-72 max-w-[85vw] bg-sidebar">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-border/60 border-b px-4">
        <LogoMark />
        <SheetTitle className="flex-1 font-semibold text-base">{t.menu}</SheetTitle>
        <SheetClose asChild>
          <Button variant="ghost" size="icon-md" aria-label={t.close} className="text-muted-foreground">
            <XIcon aria-hidden="true" className="size-5" />
          </Button>
        </SheetClose>
      </div>
      <SideNav variant="drawer" onNavigate={() => setOpen(false)} />
    </SheetContent>
  </Sheet>;
}
