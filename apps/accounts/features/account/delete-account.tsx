'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldError, FieldLabel } from '@rezics/ui/field';
import { DownloadIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { SectionHeading } from './account-shell.tsx';
import { failureText } from './failure-text.ts';
import { focusedPaths, sectionPaths } from './sections.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import { PasswordField } from '../auth/fields.tsx';
import { useTranslation } from '../../i18n/client.ts';

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <li className="flex gap-4 rounded-3xl border border-border/60 bg-card p-5 shadow-(--aura-shadow-card) sm:p-6">
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-foreground"
      aria-hidden="true">{number}</span>
    <section className="min-w-0 flex-1" aria-label={title}>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  </li>;
}

/** Account deletion as Google Account guides it: what happens, what to do
 * first (keep a copy, hand over duties), then the person's password (or
 * passkey, through step-up) and an explicit acknowledgement. Account enables
 * the delete-user flow only with its Access deletion fence. */
export function DeleteAccount({ hasPassword = true }: { hasPassword?: boolean }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const showLabel = useTranslation('auth').t.showPassword;
  const { api, navigate } = useAccountClient();
  const stepUp = useStepUp();
  const [password, setPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; acknowledged?: string }>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = { password: hasPassword && !password ? t.deletePassword : undefined,
      acknowledged: acknowledged ? undefined : t.deleteAcknowledgeRequired };
    setErrors(found);
    if (found.password || found.acknowledged) return;
    setBusy(true);
    setFailure('');
    const result = await stepUp(() => api.deleteAccount(password), { password: password || undefined });
    if (result.ok) return navigate('/sign-in?deleted=1');
    setBusy(false);
    if (result.kind === 'cancelled') return;
    if (result.kind === 'invalid-credentials') return setErrors({ password: t.wrongCurrentPassword });
    setFailure(result.kind === 'conflict' ? t.deleteBlocked : result.kind === 'not-enabled'
      ? t.deleteNotAvailable : result.kind === 'unavailable' ? t.deleteRetry : failureText(result.kind, common));
  }

  return <>
    <SectionHeading back={{ href: sectionPaths['data-privacy'], label: t.dataPrivacy }} title={t.deleteTitle}
      intro={t.deletePageIntro} />
    <ol className="flex flex-col gap-4">
      <Step number={1} title={t.deleteStepWhat}>
        <ul className="list-disc space-y-1.5 ps-5 text-muted-foreground">
          <li>{t.deleteSignedOut}</li><li>{t.deleteApps}</li><li>{t.deleteContent}</li>
          <li className="font-medium text-foreground">{t.deletePermanent}</li>
        </ul>
      </Step>
      <Step number={2} title={t.deleteStepBefore}>
        <p className="text-muted-foreground">{t.deleteDownloadFirst}</p>
        <Button variant="outline" className="mt-3" asChild><a href={focusedPaths.download}>
          <DownloadIcon aria-hidden="true" />{t.downloadTitle}</a></Button>
        <p className="mt-4 text-muted-foreground">{t.deleteDuties}</p>
      </Step>
      <Step number={3} title={t.deleteStepConfirm}>
        <form method="post" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-5">
          {hasPassword ? <>
            <input type="text" name="username" autoComplete="username" hidden readOnly />
            <PasswordField label={t.deletePassword} name="password" value={password} error={errors.password}
              autoComplete="current-password" visibilityLabel={showLabel} disabled={busy}
              onChange={value => { setPassword(value); setErrors(current => ({ ...current, password: undefined })); }} />
          </> : <p className="text-muted-foreground">{t.deletePasskeyNote}</p>}
          <Field orientation="horizontal" invalid={!!errors.acknowledged} disabled={busy}>
            <Checkbox name="acknowledge" checked={acknowledged}
              onCheckedChange={({ checked }) => { setAcknowledged(checked === true); setErrors(current => ({ ...current,
                acknowledged: undefined })); }} />
            <FieldContent>
              <FieldLabel>{t.deleteAcknowledge}</FieldLabel>
              <FieldError>{errors.acknowledged}</FieldError>
            </FieldContent>
          </Field>
          {failure ? <Alert role="alert" variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="lg" disabled={busy} asChild><a href={sectionPaths['data-privacy']}>{t.cancel}</a></Button>
            <Button type="submit" variant="destructive" size="lg" isLoading={busy}>{busy ? t.deleting : t.deleteButton}</Button>
          </div>
        </form>
      </Step>
    </ol>
  </>;
}
