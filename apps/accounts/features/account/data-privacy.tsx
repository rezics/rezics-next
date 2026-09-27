'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { SectionHeading, SettingsCard } from './account-shell.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { PasswordField } from '../auth/fields.tsx';
import { useTranslation } from '../../i18n/client.ts';

/** Account deletion through Better Auth's delete-user flow, which Account
 * enables only with its Access deletion fence. */
export function DataPrivacy() {
  const { t } = useTranslation('account');
  const showLabel = useTranslation('auth').t.showPassword;
  const { api, navigate } = useAccountClient();
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmed = phrase.trim().toLocaleLowerCase() === t.deletePhrase.toLocaleLowerCase();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed) return;
    if (!password) return setPasswordError(t.deletePassword);
    setBusy(true);
    setFailure('');
    const result = await api.deleteAccount(password);
    if (result.ok) return navigate('/sign-in?deleted=1');
    setBusy(false);
    if (result.kind === 'invalid-credentials') return setPasswordError(t.wrongCurrentPassword);
    setFailure(result.kind === 'conflict' ? t.deleteBlocked : result.kind === 'not-enabled'
      ? t.deleteNotAvailable : t.deleteRetry);
  }

  return <>
    <SectionHeading title={t.dataPrivacy} intro={t.privacyIntro} />
    <SettingsCard title={t.deleteTitle}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        <div className="flex gap-3 rounded-2xl bg-destructive/5 p-4">
          <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-destructive-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium">{t.deleteIntro}</p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-muted-foreground">
              <li>{t.deleteSignedOut}</li><li>{t.deleteApps}</li><li>{t.deleteContent}</li>
            </ul>
          </div>
        </div>
        <input type="text" name="username" autoComplete="username" hidden readOnly />
        <PasswordField label={t.deletePassword} name="password" value={password} error={passwordError}
          autoComplete="current-password" visibilityLabel={showLabel} disabled={busy}
          onChange={value => { setPassword(value); setPasswordError(''); }} />
        <Field disabled={busy}>
          <FieldLabel>{t.deleteConfirm({ phrase: t.deletePhrase })}</FieldLabel>
          <Input size="lg" name="confirmation" autoComplete="off" spellCheck={false} value={phrase}
            onChange={event => setPhrase(event.currentTarget.value)} />
          <FieldError />
        </Field>
        {failure ? <Alert role="alert" variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="destructive" size="lg" disabled={!confirmed || busy} isLoading={busy}>
            {busy ? t.deleting : t.deleteButton}</Button>
        </div>
      </form>
    </SettingsCard>
  </>;
}
