'use client';

import { Button } from '@rezics/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@rezics/ui/sheet';
import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** The account menu's phone sheet. AccountMenu loads it on the first press, so pages without another dialog
 * never download the dialog machinery. */
export default function AccountSheet({ open, onOpenChange, title, closeLabel, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; closeLabel: string; children: ReactNode;
}) {
  return <Sheet open={open} onOpenChange={details => onOpenChange(details.open)}>
    <SheetContent placement="bottom" showCloseButton={false} className="max-h-[85dvh]">
      <div className="flex items-center justify-between border-border/60 border-b px-5 py-4">
        <SheetTitle>{title}</SheetTitle>
        <SheetClose asChild><Button variant="ghost" size="icon-sm" aria-label={closeLabel}>
          <XIcon aria-hidden="true" /></Button></SheetClose>
      </div>
      {children}
    </SheetContent>
  </Sheet>;
}
