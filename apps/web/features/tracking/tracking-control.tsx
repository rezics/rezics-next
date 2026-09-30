'use client';

import { Button } from '@rezics/ui/button';
import { ListChecksIcon } from 'lucide-react';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import { copyOf } from './messages.ts';
import { TrackingSheet } from './tracking-sheet.tsx';

/**
 * "Details" as a button of its own, for pages that embed tracking beside their other actions (the hub
 * page and Library). The status button reaches the same sheet from its menu. Signed out, or without
 * tracking to act with, nothing is drawn.
 */
export function TrackingControl({ work, title, locale, size = 'md', variant = 'outline', className }: {
  work: string; title: string; locale: UiLocale; size?: 'sm' | 'md' | 'lg'; variant?: 'default' | 'outline' | 'ghost'; className?: string;
}) {
  const actions = useReaderActions();
  const [open, setOpen] = useState(false);
  if (actions.kind !== 'ready' || !actions.tracking) return null;
  return <>
    <Button size={size} variant={variant} pill className={className} onClick={() => setOpen(true)}>
      <ListChecksIcon aria-hidden="true" />{copyOf(locale).details}</Button>
    <TrackingSheet work={work} title={title} api={actions.tracking} locale={locale} open={open} onOpenChange={setOpen} />
  </>;
}
