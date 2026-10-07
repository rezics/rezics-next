'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { TriangleAlertIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import type { Copy } from './messages.ts';
import type { Refusal } from './store.ts';
import type { SaveRefusal } from './saves.ts';

/** A store's snapshot, re-read when it announces a change. */
export function useSnapshot<S>(store: { subscribe: (listener: () => void) => () => void; snapshot: () => S }): S {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** An icon-only action: named for assistive technology and large enough for a thumb. */
export function IconAction({ label, children, className, ...props }: Omit<ComponentProps<typeof Button>, 'aria-label' | 'size'> & {
  label: string; children: ReactNode;
}) {
  return <Button type="button" variant="ghost" size="icon-md" aria-label={label} title={label}
    className={cn('pointer-coarse:size-11', className)} {...props}>{children}</Button>;
}

/** The headline for a refusal the person can act on; Main's own reason, when it gave one, follows. */
export function refusalTitle(t: Copy, refusal: Refusal | { kind: SaveRefusal }): string {
  switch (refusal.kind) {
    case 'sign-in': return t.failSignIn;
    case 'denied': return t.failDenied;
    case 'invalid': return t.failInvalid;
    case 'pending': return t.failPending;
    case 'moved': return t.failMoved;
    case 'gone': return t.failGone;
    case 'too-many': return t.failTooMany;
    case 'yield-required': return t.failYield;
    case 'empty': return t.failEmptyNotes;
    default: return t.failUnavailable;
  }
}

export function FailureAlert({ t, refusal, detail, onRetry, onDismiss }: {
  t: Copy; refusal: Refusal | { kind: SaveRefusal }; detail?: string | null; onRetry?: () => void; onDismiss: () => void;
}) {
  const retryable = refusal.kind === 'unavailable' || refusal.kind === 'pending';
  return <Alert variant="warning" role="alert" data-recipe-alert>
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{refusalTitle(t, refusal)}</AlertTitle>
    {detail ? <AlertDescription><span className="font-medium">{t.mainSays}: </span>{detail}</AlertDescription> : null}
    <div className="col-start-2 mt-2 flex flex-wrap gap-2">
      {retryable && onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t.retry}</Button> : null}
      <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{t.dismiss}</Button>
    </div>
  </Alert>;
}
