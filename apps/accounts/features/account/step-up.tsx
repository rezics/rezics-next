'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { FingerprintIcon } from 'lucide-react';
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { failureText } from './failure-text.ts';
import { dialogForm } from './dialog-form.ts';
import { useAccountClient } from '../api/account-client.tsx';
import type { Result } from '../api/errors.ts';
import { autofocus, CodeField, PasswordField } from '../auth/fields.tsx';
import { signInHref } from '../shell/state-panel.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** How this person can confirm it's them: the password (plus the authenticator
 * code when 2-Step Verification is on), a passkey, or both. */
export interface StepUpMethods { password: boolean; passkey: boolean; totp: boolean }

/** `password`: the form already asked for it, so it is not asked again. */
type Run = <T>(action: () => Promise<Result<T>>, known?: { password?: string }) => Promise<Result<T>>;
const StepUpContext = createContext<Run>(action => action());

/** Runs a sensitive change; when the Account service first wants the person
 * to confirm it's them (valid five minutes), confirms, then tries once more.
 * A password the form already has confirms directly unless an authenticator
 * code is also needed; otherwise a dialog asks. A dismissed prompt ends as
 * `cancelled`, which callers show as nothing. */
export function useStepUp(): Run {
  return useContext(StepUpContext);
}

export function StepUpProvider({ methods, children }: { methods: StepUpMethods; children: ReactNode }) {
  const { t } = useTranslation('account');
  const auth = useTranslation('auth').t;
  const common = useTranslation('common').t;
  const { api } = useAccountClient();
  const [open, setOpen] = useState(false);
  const pending = useRef<(confirmed: boolean) => void>(undefined);
  const [password, setPassword] = useState('');
  const [knownPassword, setKnownPassword] = useState<string>();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'password' | 'passkey'>();

  const settle = (confirmed: boolean) => {
    pending.current?.(confirmed);
    pending.current = undefined;
    setOpen(false);
    setPassword('');
    setKnownPassword(undefined);
    setCode('');
    setBusy(undefined);
  };
  const run: Run = useCallback(async (action, known = {}) => {
    const first = await action();
    if (first.ok || first.kind !== 'step-up-required') return first;
    if (known.password && !methods.totp) {
      const confirmed = await api.reauthenticate({ password: known.password });
      return confirmed.ok ? action() : confirmed;
    }
    setError('');
    setKnownPassword(known.password);
    const confirmed = await new Promise<boolean>(resolve => { pending.current = resolve; setOpen(true); });
    return confirmed ? action() : { ok: false, kind: 'cancelled', status: 0 };
  }, [api, methods.totp]);

  const fail = (result: Exclude<Result<void>, { ok: true }>, method: 'password' | 'passkey') => {
    setBusy(undefined);
    if (result.kind === 'cancelled') return;
    setError(result.kind === 'invalid-credentials' ? method === 'passkey' ? t.stepUpPasskeyFailed
      : methods.totp ? t.stepUpWrongWithCode : t.wrongCurrentPassword
      : result.kind === 'rate-limited' ? auth.tooManyAttempts : result.kind === 'unavailable' ? t.stepUpUnavailable : failureText(result.kind, common));
  };
  async function withPassword(event: FormEvent) {
    event.preventDefault();
    const secret = knownPassword ?? password;
    if (!secret) return setError(t.stepUpPasswordRequired);
    if (methods.totp && !/^\d{6}$/.test(code)) return setError(t.codeRequired);
    setBusy('password');
    setError('');
    const result = await api.reauthenticate({ password: secret, totpCode: methods.totp ? code : undefined });
    if (result.ok) return settle(true);
    fail(result, 'password');
  }
  async function withPasskey() {
    setBusy('passkey');
    setError('');
    const result = await api.reauthenticateWithPasskey();
    if (result.ok) return settle(true);
    fail(result, 'passkey');
  }

  const here = typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
  return <StepUpContext.Provider value={run}>
    {children}
    <Dialog open={open} onOpenChange={({ open: next }) => { if (!next && !busy) settle(false); }}>
      <DialogContent size="sm">
        <DialogHeader title={t.stepUpTitle} description={t.stepUpBody} />
        <form noValidate onSubmit={event => void withPassword(event)} className={dialogForm}>
          <DialogBody className="flex flex-col gap-5">
            {error ? <Alert role="alert" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {methods.passkey ? <Button type="button" variant={methods.password ? 'outline' : 'default'} size="lg"
              {...autofocus(knownPassword === undefined)}
              isLoading={busy === 'passkey'} disabled={!!busy} onClick={() => void withPasskey()}>
              <FingerprintIcon aria-hidden="true" />{t.stepUpWithPasskey}</Button> : null}
            {methods.password ? <>
              {methods.passkey ? <p className="text-center text-sm text-muted-foreground">{t.stepUpOr}</p> : null}
              {knownPassword === undefined ? <>
                <input type="text" name="username" autoComplete="username" hidden readOnly />
                <PasswordField label={auth.passwordLabel} name="password" value={password} autoFocus={!methods.passkey}
                  autoComplete="current-password" visibilityLabel={auth.showPassword} disabled={!!busy}
                  onChange={value => { setPassword(value); setError(''); }} />
              </> : null}
              {methods.totp ? <CodeField label={t.authenticatorCode} value={code} disabled={!!busy}
                autoFocus={knownPassword !== undefined} description={t.authenticatorCodeHelp}
                onChange={value => { setCode(value); setError(''); }} /> : null}
            </> : null}
            {!methods.password && !methods.passkey ? <p className="text-muted-foreground">{t.stepUpSignInAgain}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" asChild><a href={signInHref(here, true)}>{t.stepUpSignInInstead}</a></Button>
            <Button type="button" variant="outline" disabled={!!busy} onClick={() => settle(false)}>{t.cancel}</Button>
            {methods.password ? <Button type="submit" isLoading={busy === 'password'} disabled={!!busy}>
              {t.confirm}</Button> : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </StepUpContext.Provider>;
}
