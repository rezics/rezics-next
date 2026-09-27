'use client';

import { Button } from '@rezics/ui/button';
import { useEffect, useId, useState } from 'react';
import { currentVanityHandle, normalizedHandle } from './handle.ts';
import type { OnboardingMessages } from './messages.ts';

export type HandleAvailability = 'available' | 'taken' | 'reserved';

async function checkHandle(handle: string, signal: AbortSignal): Promise<HandleAvailability> {
  const response = await fetch(`/api/main/v1/handles/${handle}/availability`, {
    signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Handle availability is unavailable');
  const answer = await response.json() as { available?: boolean; reason?: string };
  return answer.available ? 'available'
    : answer.reason === 'reserved' || answer.reason === 'invalid' ? 'reserved' : 'taken';
}

export function HandleField({ action, initial, current = null, submit, messages, children,
  checkAvailability = checkHandle }: {
  action: string; initial: string; current?: string | null; submit: string;
  messages: OnboardingMessages; children?: React.ReactNode;
  checkAvailability?: (handle: string, signal: AbortSignal) => Promise<HandleAvailability>;
}) {
  const [value, setValue] = useState(initial);
  const [availability, setAvailability] = useState<'checking' | 'available' | 'current' | 'taken' | 'reserved' | 'invalid' | 'failed'>('checking');
  const hintId = useId();
  const handle = normalizedHandle(value);
  const unchanged = handle !== null && handle === currentVanityHandle(current);
  useEffect(() => {
    if (!handle) { setAvailability('invalid'); return; }
    if (unchanged) { setAvailability('current'); return; }
    const controller = new AbortController();
    setAvailability('checking');
    const timer = setTimeout(() => {
      checkAvailability(handle, controller.signal)
        .then(result => { if (!controller.signal.aborted) setAvailability(result); })
        .catch(() => { if (!controller.signal.aborted) setAvailability('failed'); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [handle, unchanged, checkAvailability]);
  const text = availability === 'checking' ? messages.checking
    : availability === 'available' ? messages.available
      : availability === 'current' ? messages.current
      : availability === 'taken' ? messages.taken
        : availability === 'reserved' ? messages.reserved
          : availability === 'invalid' ? messages.invalid : messages.checkFailed;
  return <form method="post" action={action} className="grid gap-5">
    {children}
    <div className="grid gap-2">
      <label htmlFor={hintId} className="font-medium text-sm">{messages.handle}</label>
      <div className="flex min-h-11 items-center rounded-lg border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
        <span className="text-muted-foreground">@</span>
        <input id={hintId} name="handle" required maxLength={30} autoComplete="nickname"
          aria-describedby={`${hintId}-rules ${hintId}-status`}
          className="min-w-0 flex-1 border-0 bg-transparent px-1 py-2 outline-none"
          value={value} onChange={event => setValue(event.target.value)} />
      </div>
      <p id={`${hintId}-rules`} className="text-muted-foreground text-sm">{messages.handleHelp}</p>
      <p id={`${hintId}-status`} role="status" aria-live="polite" className="text-sm">{text}</p>
    </div>
    <Button type="submit" disabled={availability !== 'available' || unchanged} className="justify-self-start">
      {submit}</Button>
  </form>;
}
