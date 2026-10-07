'use client';

import { Button } from '@rezics/ui/button';
import { useEffect, useId, useState } from 'react';
import { currentVanityHandle, normalizedHandle, suggestedHandle } from './handle.ts';
import type { OnboardingMessages } from './messages.ts';

/** `held`: kept for its previous owner (a retired handle or a lookalike of one).
 * Only that owner can take it back, and Main decides; anyone else gets its 409. */
export type HandleAvailability = 'available' | 'taken' | 'reserved' | 'held';

async function checkHandle(handle: string, signal: AbortSignal): Promise<HandleAvailability> {
  const response = await fetch(`/api/main/v1/addresses/availability?${new URLSearchParams({ scope: 'agent', alias: handle })}`, {
    signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Handle availability is unavailable');
  const answer = await response.json() as { available?: boolean; reason?: string };
  return answer.available ? 'available'
    : answer.reason === 'reserved' || answer.reason === 'invalid' ? 'reserved'
      : answer.reason === 'retained' || answer.reason === 'confusable' ? 'held' : 'taken';
}

/** Asking for the public name too: an empty required field, no default, and a
 * handle suggested from what is typed until the person edits the handle. */
export function HandleField({ action, initial, current = null, submit, messages, children,
  askName = false, checkAvailability = checkHandle }: {
  action: string; initial: string; current?: string | null; submit: string;
  messages: OnboardingMessages; children?: React.ReactNode; askName?: boolean;
  checkAvailability?: (handle: string, signal: AbortSignal) => Promise<HandleAvailability>;
}) {
  const [value, setValue] = useState(initial);
  const [name, setName] = useState('');
  const [handleEdited, setHandleEdited] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [availability, setAvailability] = useState<'checking' | 'available' | 'current' | 'taken' | 'reserved' | 'held' | 'invalid' | 'failed'>('checking');
  useEffect(() => setHydrated(true), []);
  const hintId = useId();
  const nameId = useId();
  const handle = normalizedHandle(value);
  // Onboarding has no handle of its own to take back; settings (a `current` handle) does.
  const mayTake = availability === 'available' || availability === 'held' && current !== null;
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
  const text = !value.trim() ? '' : availability === 'checking' ? messages.checking
    : availability === 'available' ? messages.available
      : availability === 'current' ? messages.current
      : availability === 'taken' ? messages.taken
        : availability === 'held' ? messages.held
        : availability === 'reserved' ? messages.reserved
          : availability === 'invalid' ? messages.invalid : messages.checkFailed;
  return <form method="post" action={action} className="grid gap-5">
    {children}
    {askName ? <div className="grid gap-2">
      <label htmlFor={nameId} className="font-medium text-sm">{messages.displayName}</label>
      <input id={nameId} name="displayName" required maxLength={200} autoComplete="off" value={name}
        aria-describedby={`${nameId}-help`} data-hydrated={hydrated ? 'true' : undefined}
        onChange={event => {
          setName(event.target.value);
          if (!handleEdited) setValue(suggestedHandle(event.target.value));
        }}
        className="min-h-11 rounded-lg border border-input bg-background px-3 py-2 outline-none
          focus-visible:ring-2 focus-visible:ring-ring" />
      <p id={`${nameId}-help`} className="text-muted-foreground text-sm">{messages.displayNameHelp}</p>
    </div> : null}
    <div className="grid gap-2">
      <label htmlFor={hintId} className="font-medium text-sm">{messages.handle}</label>
      <div className="flex min-h-11 items-center rounded-lg border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
        <span className="text-muted-foreground">@</span>
        <input id={hintId} name="handle" required maxLength={30} autoComplete="nickname"
          data-hydrated={hydrated ? 'true' : undefined}
          aria-describedby={`${hintId}-rules ${hintId}-status`}
          className="min-w-0 flex-1 border-0 bg-transparent px-1 py-2 outline-none"
          value={value}
          onChange={event => { setHandleEdited(true); setValue(event.target.value); }} />
      </div>
      <p id={`${hintId}-rules`} className="text-muted-foreground text-sm">{messages.handleHelp}</p>
      <p id={`${hintId}-status`} role="status" aria-live="polite" className="text-sm">{text}</p>
    </div>
    <Button type="submit" disabled={!mayTake || unchanged || askName && !name.trim()} className="justify-self-start">
      {submit}</Button>
  </form>;
}
