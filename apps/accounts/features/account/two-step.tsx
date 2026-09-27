'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { QrCode, QrCodeFrame } from '@rezics/ui/qr-code';
import { CheckIcon, CopyIcon, DownloadIcon, KeyRoundIcon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { SectionHeading, SettingsCard, SettingsRow } from './account-shell.tsx';
import { dialogForm } from './dialog-form.ts';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import type { TotpEnrollment } from '../api/client.ts';
import type { FailureKind } from '../api/errors.ts';
import { autofocus, CodeField, PasswordField } from '../auth/fields.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** The key an authenticator app stores, in groups of four for typing it in. */
export function manualKey(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get('secret') ?? '';
  return secret.match(/.{1,4}/g)?.join(' ') ?? '';
}

function useFailure() {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  return (kind: FailureKind) => kind === 'invalid-credentials' ? t.wrongCurrentPassword
    : kind === 'invalid-code' ? t.codeWrong : failureText(kind, common);
}

/** Backup codes, each usable once when the authenticator app isn't at hand. */
function BackupCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation('account');
  const [copied, setCopied] = useState(false);
  const text = `${t.backupCodesFileTitle}\n\n${codes.join('\n')}\n`;
  return <div className="flex flex-col gap-4">
    <ul aria-label={t.backupCodes} className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-2xl border border-border/60 bg-muted/40 px-5 py-4 font-mono text-base tabular-nums">
      {codes.map(code => <li key={code}>{code}</li>)}
    </ul>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
        {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}{copied ? t.copied : t.copyCodes}</Button>
      <Button variant="outline" asChild><a download="rezics-backup-codes.txt"
        href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}><DownloadIcon aria-hidden="true" />{t.downloadCodes}</a></Button>
    </div>
  </div>;
}

function ConfirmPassword({ hasPassword, value, error, disabled, onChange }: { hasPassword: boolean; value: string;
  error?: string; disabled: boolean; onChange(value: string): void }) {
  const { t } = useTranslation('account');
  const auth = useTranslation('auth').t;
  if (!hasPassword) return null;
  return <>
    <input type="text" name="username" autoComplete="username" hidden readOnly />
    <PasswordField label={t.currentPassword} name="password" value={value} error={error} autoFocus
      autoComplete="current-password" visibilityLabel={auth.showPassword} disabled={disabled} onChange={onChange} />
  </>;
}

type SetupStep = 'password' | 'scan' | 'codes';

/** Turn on 2-Step Verification: confirm, scan, prove the app works, keep the codes. */
function TotpSetup({ hasPassword, onClose }: { hasPassword: boolean; onClose(done: boolean): void }) {
  const { t } = useTranslation('account');
  const { api } = useAccountClient();
  const stepUp = useStepUp();
  const describe = useFailure();
  const [step, setStep] = useState<SetupStep>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<TotpEnrollment>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (hasPassword && !password) return setError(t.stepUpPasswordRequired);
    setBusy(true);
    setError('');
    const result = await stepUp(() => api.enableTotp(hasPassword ? password : undefined), { password });
    setBusy(false);
    if (result.ok) { setEnrollment(result.data); return setStep('scan'); }
    if (result.kind !== 'cancelled') setError(describe(result.kind));
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError(t.codeRequired);
    setBusy(true);
    setError('');
    const result = await stepUp(() => api.confirmTotp(code), { password });
    setBusy(false);
    if (result.ok) return setStep('codes');
    if (result.kind !== 'cancelled') setError(describe(result.kind));
  }

  const body = (content: ReactNode) => <DialogBody className="flex flex-col gap-5">
    {error ? <Alert role="alert" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {content}</DialogBody>;
  return <DialogContent size="md">
    {step === 'password' ? <form noValidate onSubmit={event => void start(event)} className={dialogForm}>
      <DialogHeader title={t.twoStepSetupTitle} description={t.twoStepSetupBody} />
      {body(hasPassword ? <ConfirmPassword hasPassword value={password} disabled={busy}
        onChange={value => { setPassword(value); setError(''); }} /> : <p className="text-muted-foreground">{t.twoStepSetupPasskey}</p>)}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onClose(false)}>{t.cancel}</Button>
        <Button type="submit" isLoading={busy}>{t.next}</Button>
      </DialogFooter>
    </form> : step === 'scan' && enrollment ? <form noValidate onSubmit={event => void verify(event)} className={dialogForm}>
      <DialogHeader title={t.scanTitle} description={t.scanBody} />
      {body(<>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <QrCode value={enrollment.totpURI} encoding={{ ecc: 'M' }} className="[--qr-code-size:--spacing(40)]">
            <QrCodeFrame aria-label={t.qrLabel} role="img" className="rounded-xl border border-border/60 p-2" />
          </QrCode>
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">{t.cantScan}</p>
            <p className="mt-1 text-muted-foreground">{t.enterKey}</p>
            <p className="mt-2 rounded-xl bg-muted/60 px-3 py-2 font-mono text-base break-normal select-all tabular-nums">
              {manualKey(enrollment.totpURI)}</p>
          </div>
        </div>
        <CodeField label={t.authenticatorCode} value={code} autoFocus disabled={busy}
          description={t.authenticatorCodeHelp} onChange={value => { setCode(value); setError(''); }} />
      </>)}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onClose(false)}>{t.cancel}</Button>
        <Button type="submit" isLoading={busy}>{t.verify}</Button>
      </DialogFooter>
    </form> : enrollment ? <>
      <DialogHeader title={t.twoStepOnTitle} description={t.backupCodesBody} />
      {body(<BackupCodes codes={enrollment.backupCodes} />)}
      <DialogFooter><Button onClick={() => onClose(true)}>{t.done}</Button></DialogFooter>
    </> : null}
  </DialogContent>;
}

type Dialogs = 'setup' | 'codes' | 'rename' | 'off';

/** 2-Step Verification: an authenticator app after the password, with backup
 * codes. Passkeys already verify the person, so they skip this step. */
export function TwoStepVerification({ totp, hasPassword }: { totp: { name: string; verified: boolean } | null;
  hasPassword: boolean }) {
  const { t } = useTranslation('account');
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  const describe = useFailure();
  const on = totp?.verified === true;
  const [dialog, setDialog] = useState<Dialogs>();
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const open = (next: Dialogs) => { setDialog(next); setPassword(''); setError(''); setCodes(undefined);
    setName(totp?.name ?? ''); setNotice(''); };
  const close = () => { if (!busy) setDialog(undefined); };

  async function regenerate(event: FormEvent) {
    event.preventDefault();
    if (hasPassword && !password) return setError(t.stepUpPasswordRequired);
    setBusy(true);
    const result = await stepUp(() => api.regenerateBackupCodes(hasPassword ? password : undefined), { password });
    setBusy(false);
    if (result.ok) return setCodes(result.data);
    if (result.kind !== 'cancelled') setError(describe(result.kind));
  }
  async function turnOff(event: FormEvent) {
    event.preventDefault();
    if (hasPassword && !password) return setError(t.stepUpPasswordRequired);
    setBusy(true);
    const result = await stepUp(() => api.disableTotp(hasPassword ? password : undefined), { password });
    setBusy(false);
    if (result.ok) { setDialog(undefined); setNotice(t.twoStepTurnedOff); return refresh(); }
    if (result.kind !== 'cancelled') setError(describe(result.kind));
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError(t.passkeyNameRequired);
    setBusy(true);
    const result = await stepUp(() => api.renameTotp(name.trim()));
    setBusy(false);
    if (result.ok) { setDialog(undefined); return refresh(); }
    if (result.kind !== 'cancelled') setError(describe(result.kind));
  }
  const failure = error ? <Alert role="alert" variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null;

  return <>
    <SectionHeading back={{ href: '/security', label: t.security }} title={t.methodTwoStep} intro={t.twoStepIntro} />
    <div className="flex flex-col gap-6">
      {notice ? <Alert role="status" variant="success"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <section className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-5 shadow-(--aura-shadow-card) sm:flex-row sm:items-center sm:p-6">
        <span className={on ? 'grid size-12 shrink-0 place-items-center rounded-full bg-success/12 text-success-foreground'
          : 'grid size-12 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground'}>
          <ShieldCheckIcon className="size-6" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{on ? t.twoStepOn : t.twoStepOff}</h2>
          <p className="text-muted-foreground">{on ? t.twoStepOnBody : t.twoStepOffBody}</p>
        </div>
        {on ? <Button variant="outline" onClick={() => open('off')}>{t.turnOff}</Button>
          : <Button onClick={() => open('setup')}>{t.turnOn}</Button>}
      </section>
      {on ? <SettingsCard title={t.secondSteps}>
        <SettingsRow label={t.authenticatorApp} action={<Button variant="ghost" onClick={() => open('rename')}
          aria-label={`${t.rename} · ${t.authenticatorApp}`}>{t.rename}</Button>}>
          <span className="inline-flex items-center gap-2 font-medium"><SmartphoneIcon className="size-4 text-muted-foreground"
            aria-hidden="true" />{totp.name}</span>
        </SettingsRow>
        <SettingsRow label={t.backupCodes} action={<Button variant="ghost" onClick={() => open('codes')}>{t.newCodes}</Button>}>
          <span className="inline-flex items-center gap-2"><KeyRoundIcon className="size-4 text-muted-foreground"
            aria-hidden="true" />{t.backupCodesSummary}</span>
        </SettingsRow>
      </SettingsCard> : null}
      <p className="text-sm text-muted-foreground">{t.twoStepPasskeyNote}</p>
    </div>
    {/* Closing at any step re-reads the page: the app may already be on. */}
    <Dialog open={dialog === 'setup'} onOpenChange={({ open: next }) => { if (!next) { setDialog(undefined); refresh(); } }}>
      {dialog === 'setup' ? <TotpSetup hasPassword={hasPassword} onClose={done => { setDialog(undefined);
        if (done) { setNotice(t.twoStepTurnedOn); refresh(); } }} /> : null}
    </Dialog>
    <Dialog open={dialog === 'codes'} onOpenChange={({ open: next }) => { if (!next) close(); }}>
      <DialogContent size="md">
        {codes ? <>
          <DialogHeader title={t.newCodesTitle} description={t.backupCodesBody} />
          <DialogBody><BackupCodes codes={codes} /></DialogBody>
          <DialogFooter><Button onClick={() => setDialog(undefined)}>{t.done}</Button></DialogFooter>
        </> : <form noValidate onSubmit={event => void regenerate(event)} className={dialogForm}>
          <DialogHeader title={t.newCodesTitle} description={t.newCodesBody} />
          <DialogBody className="flex flex-col gap-5">{failure}
            <ConfirmPassword hasPassword={hasPassword} value={password} disabled={busy}
              onChange={value => { setPassword(value); setError(''); }} /></DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t.cancel}</Button>
            <Button type="submit" isLoading={busy}>{t.newCodes}</Button>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
    <Dialog open={dialog === 'rename'} onOpenChange={({ open: next }) => { if (!next) close(); }}>
      <DialogContent size="sm">
        <form noValidate onSubmit={event => void rename(event)} className={dialogForm}>
          <DialogHeader title={t.renameAuthenticatorTitle} />
          <DialogBody className="flex flex-col gap-5">{failure}
            <Field disabled={busy}>
              <FieldLabel>{t.authenticatorName}</FieldLabel>
              <Input size="lg" name="authenticator-name" autoComplete="off" {...autofocus(true)} maxLength={80} value={name}
                onChange={event => { setName(event.currentTarget.value); setError(''); }} />
              <FieldError />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t.cancel}</Button>
            <Button type="submit" isLoading={busy}>{t.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={dialog === 'off'} onOpenChange={({ open: next }) => { if (!next) close(); }}>
      <DialogContent size="sm">
        <form noValidate onSubmit={event => void turnOff(event)} className={dialogForm}>
          <DialogHeader title={t.turnOffTitle} description={t.turnOffBody} />
          <DialogBody className="flex flex-col gap-5">{failure}
            <ConfirmPassword hasPassword={hasPassword} value={password} disabled={busy}
              onChange={value => { setPassword(value); setError(''); }} /></DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t.cancel}</Button>
            <Button type="submit" variant="destructive" isLoading={busy}>{t.turnOff}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
