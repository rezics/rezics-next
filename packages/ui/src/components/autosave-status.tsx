'use client';

import { CloudOffIcon, LoaderCircleIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { Status } from './status.tsx';

export type AutosaveState =
  /** Nothing typed since the last load; there is nothing to save. */
  | 'idle'
  /** Typed; the save waits for a pause in typing. */
  | 'unsaved'
  | 'saving'
  | 'saved'
  /** The network is unreachable; the text is kept on this device. */
  | 'offline'
  /** Someone else saved first; the writer must choose which text to keep. */
  | 'conflict'
  /** The save failed for another reason and can be retried. */
  | 'error';

export interface AutosaveLabels {
  idle: string; unsaved: string; saving: string;
  /** "Saved" — followed by " · " and the relative time of the last save. */
  saved: string;
  offline: string; conflict: string; error: string; retry: string;
}

const tone = {
  idle: 'default', unsaved: 'default', saving: 'info', saved: 'success',
  offline: 'warning', conflict: 'destructive', error: 'destructive',
} as const;

/** "2 min ago" in the interface locale, coarse enough that a writer is not distracted by it. */
export function relativeTime(then: Date, now: Date, locale?: string): string {
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (Math.abs(seconds) < 45) return format.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(then);
}

/**
 * Where a draft stands: saving, "Saved · 2 min ago", "Offline — kept on this device", a conflict
 * or a failed save with Retry. It is a polite live region, so assistive technology hears changes
 * without the writer leaving the text. The relative time refreshes every 30 seconds.
 */
export function AutosaveStatus({ state, savedAt, labels, locale, onRetry, className, ...props }:
  Omit<React.ComponentProps<'div'>, 'children'> & {
    state: AutosaveState; savedAt: Date | null; labels: AutosaveLabels; locale?: string; onRetry?: () => void;
  }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (state !== 'saved') return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [state, savedAt]);
  const text = state === 'saved' && savedAt ? `${labels.saved} · ${relativeTime(savedAt, now, locale)}` : labels[state];
  const Icon = state === 'saving' ? LoaderCircleIcon : state === 'offline' ? CloudOffIcon
    : state === 'conflict' || state === 'error' ? TriangleAlertIcon : null;
  return (
    <div className={cn('flex min-h-8 items-center gap-2 text-muted-foreground text-xs', className)}
      data-slot="autosave-status" data-state={state} {...props}>
      {Icon ? <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', state === 'saving' && 'animate-spin',
        state === 'offline' && 'text-warning-foreground',
        (state === 'conflict' || state === 'error') && 'text-destructive-foreground')} />
        : <Status variant={tone[state]} size="sm" />}
      <span role="status" aria-live="polite" className={cn((state === 'conflict' || state === 'error')
        && 'text-destructive-foreground')}>{text}</span>
      {state === 'error' && onRetry ? <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
        <RotateCwIcon aria-hidden="true" />{labels.retry}</Button> : null}
    </div>
  );
}
