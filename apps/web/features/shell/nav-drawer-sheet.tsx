'use client';

import { Button } from '@rezics/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@rezics/ui/sheet';
import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { LogoMark } from './logo.tsx';
import { useShell } from './shell-provider.tsx';
import { SideNav } from './side-nav.tsx';

/** The phone drawer itself: the side navigation in a sheet. NavDrawer loads it on the first open. */
export default function NavDrawerSheet({ open, onOpenChange, communities }: {
  open: boolean; onOpenChange: (open: boolean) => void; communities?: ReactNode;
}) {
  const { t } = useShell();
  return <Sheet open={open} onOpenChange={details => onOpenChange(details.open)}>
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
      <SideNav variant="drawer" onNavigate={() => onOpenChange(false)} communities={communities} />
    </SheetContent>
  </Sheet>;
}
