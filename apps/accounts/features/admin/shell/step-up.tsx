'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { useAdminClient } from '../api/admin-client.tsx';
import type { AdminResult } from '../api/client.ts';
import { ErrorAlert, ReauthFields, type Reauth } from '../actions/confirm.tsx';
import { useAdmin } from './admin-context.tsx';
import { useTranslation } from '../../../i18n/client.ts';

const Context = createContext<{ confirm(): Promise<boolean> } | null>(null);

/** Asks for the operator's password when the service wants a recent sign-in,
 * then lets the waiting change retry once with the same command ID. */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const confirm = useCallback(() => new Promise<boolean>(resolve => {
    resolver.current = resolve;
    setOpen(true);
  }), []);
  const finish = (confirmed: boolean) => {
    resolver.current?.(confirmed);
    resolver.current = null;
    setOpen(false);
  };
  return <Context.Provider value={{ confirm }}>{children}
    <StepUpDialog open={open} onDone={finish} /></Context.Provider>;
}

/** Runs a change; on `step_up_required` confirms the operator and retries. */
export function useStepUp() {
  const context = useContext(Context);
  return useCallback(async <T,>(attempt: () => Promise<AdminResult<T>>): Promise<AdminResult<T>> => {
    const first = await attempt();
    if (first.ok || first.code !== 'step_up_required' || !context) return first;
    return await context.confirm() ? attempt() : first;
  }, [context]);
}

function StepUpDialog({ open, onDone }: { open: boolean; onDone(confirmed: boolean): void }) {
  const { t } = useTranslation('admin');
  const { api } = useAdminClient();
  const { me } = useAdmin();
  const [reauth, setReauth] = useState<Reauth>({ password: '', totpCode: '' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (confirmed: boolean) => {
    setReauth({ password: '', totpCode: '' }); setError(null); setPending(false);
    onDone(confirmed);
  };
  async function submit() {
    setPending(true); setError(null);
    const result = await api.reauthenticate(reauth.password, me.secondFactor ? reauth.totpCode : undefined);
    setPending(false);
    if (result.ok) close(true);
    else setError(result.code === 'forbidden' ? t.stepUpFailed : result.code === 'rate_limited' ? t.errors.rate_limited
      : t.errors.temporarily_unavailable);
  }
  return <Dialog open={open} onOpenChange={details => { if (!details.open && !pending) close(false); }}
    closeOnInteractOutside={!pending} closeOnEscape={!pending}>
    <DialogContent size="sm">
      <form onSubmit={event => { event.preventDefault(); void submit(); }} className="contents">
        <DialogHeader title={t.stepUpTitle} description={t.stepUpBody} />
        <DialogBody className="flex flex-col gap-4">
          <ReauthFields value={reauth} onChange={setReauth} secondFactor={me.secondFactor} disabled={pending} autoFocus />
          <ErrorAlert message={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={pending}>{t.cancel}</Button>
          <Button type="submit" isLoading={pending} disabled={!reauth.password}>{t.stepUpContinue}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
