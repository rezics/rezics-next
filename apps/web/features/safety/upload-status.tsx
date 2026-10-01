'use client';

import { cn } from '@rezics/ui/utils';
import { CircleCheckIcon, ClockIcon, EyeOffIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { fill, textFor, waitText } from './report.ts';
import { type Clearance, nextCheckSeconds, readClearance } from './upload-state.ts';

const look = {
  screening: { icon: LoaderCircleIcon, tone: 'text-muted-foreground', title: 'uploadChecking', body: 'uploadCheckingBody' },
  cleared: { icon: CircleCheckIcon, tone: 'text-success-foreground', title: 'uploadVisible', body: 'uploadVisibleBody' },
  held: { icon: EyeOffIcon, tone: 'text-warning-foreground', title: 'uploadHeld', body: 'uploadHeldBody' },
  rejected: { icon: TriangleAlertIcon, tone: 'text-destructive-foreground', title: 'uploadRejected', body: 'uploadRejectedBody' },
} as const;

/**
 * The one status line every image upload shows: Checking, Visible, Under
 * review or Not accepted, and what each means for who can see the image. It
 * never says why an image is held.
 */
export function UploadStatus({ clearance, locale, className }: { clearance: Clearance; locale: UiLocale; className?: string }) {
  const t = textFor(locale);
  const { icon: Icon, tone, title, body } = look[clearance];
  return <p role="status" data-clearance={clearance} className={cn('flex items-start gap-2 text-sm', className)}>
    <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', tone, clearance === 'screening' && 'animate-spin')} />
    <span><span className="font-medium">{t[title]}</span>{' '}<span className="block text-muted-foreground">{t[body]}</span></span>
  </p>;
}

/** A spent upload budget: when the uploader can try again, in their language. */
export function UploadLimited({ retryAfter, locale, className }: { retryAfter: number; locale: UiLocale; className?: string }) {
  const t = textFor(locale);
  return <p role="alert" className={cn('flex items-start gap-2 text-destructive-foreground text-sm', className)}>
    <ClockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    {fill(t.uploadLimited, { time: waitText(retryAfter, locale) })}</p>;
}

/**
 * The upload's clearance as it changes: Checking turns Visible or Under
 * review, and Under review turns Visible when staff clear it. It looks again
 * while the page is open and stops once the answer cannot change by itself.
 */
export function useClearance(upload: string | null, initial: Clearance | null, send?: typeof fetch): Clearance | null {
  const [state, setState] = useState<Clearance | null>(initial);
  useEffect(() => {
    setState(initial);
    if (!upload || !initial) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    let current: Clearance = initial, looked = 0;
    const next = () => {
      const wait = nextCheckSeconds(current, looked);
      if (wait === null || stopped) return;
      timer = setTimeout(() => {
        looked += 1;
        void readClearance(upload, send).then(seen => {
          if (stopped) return;
          if (seen) { current = seen; setState(seen); }
          next();
        });
      }, wait * 1000);
    };
    next();
    return () => { stopped = true; clearTimeout(timer); };
  }, [upload, initial, send]);
  return state;
}
