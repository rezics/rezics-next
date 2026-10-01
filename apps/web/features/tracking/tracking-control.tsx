'use client';

import { Button } from '@rezics/ui/button';
import { ListChecksIcon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { useReaderActions } from '../catalogue/reader-actions.tsx';
import { copyOf } from './messages.ts';

const TrackingSheet = lazy(() => import('./tracking-sheet.tsx').then(module => ({ default: module.TrackingSheet })));

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
  const [asked, setAsked] = useState(false);
  if (actions.kind !== 'ready' || !actions.tracking) return null;
  return <>
    <Button size={size} variant={variant} pill className={className} onClick={() => { setAsked(true); setOpen(true); }}>
      <ListChecksIcon aria-hidden="true" />{copyOf(locale).details}</Button>
    {asked ? <Suspense fallback={null}>
      <TrackingSheet work={work} title={title} api={actions.tracking} locale={locale} open={open} onOpenChange={setOpen} />
    </Suspense> : null}
  </>;
}
