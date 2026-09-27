'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { NativeSelect } from '@rezics/ui/native-select';
import { type FormEvent, type ReactNode, useState } from 'react';
import { SectionHeading, SettingsCard, SettingsRow } from './account-shell.tsx';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import type { AccountLocale } from '../api/account-data.ts';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from './failure-text.ts';
import { EmailField, emailPattern, NameField } from '../auth/fields.tsx';
import { type AvatarUser, UserAvatar } from '../shell/user-avatar.tsx';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { localeNames, uiLocales } from '../../i18n/locale.ts';

type Outcome = { tone: 'success' | 'destructive' | 'info'; text: string };

function Note({ outcome }: { outcome?: Outcome }) {
  return outcome ? <Alert role={outcome.tone === 'destructive' ? 'alert' : 'status'} variant={outcome.tone}
    className="mt-3"><AlertDescription>{outcome.text}</AlertDescription></Alert> : null;
}

function InlineForm({ onSubmit, busy, children, onCancel }: { onSubmit(event: FormEvent): void;
  busy: boolean; children: ReactNode; onCancel(): void }) {
  const { t } = useTranslation('account');
  return <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4 px-5 py-4 sm:px-6">
    {children}
    <div className="flex justify-end gap-2">
      <Button variant="outline" disabled={busy} onClick={onCancel}>{t.cancel}</Button>
      <Button type="submit" isLoading={busy}>{busy ? t.saving : t.save}</Button>
    </div>
  </form>;
}

/** The account's language: stored on the account for its pages and emails,
 * and remembered in this browser through `?hl=`. */
function LanguageRow({ chosen }: { chosen: AccountLocale | null }) {
  const { t } = useTranslation('account');
  const common = useTranslation('common').t;
  const locale = useLocale();
  const { api, navigate } = useAccountClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const value = chosen ?? (locale.current as AccountLocale);
  async function choose(next: AccountLocale) {
    setBusy(true);
    setFailure('');
    const result = await api.setLocale(next);
    if (!result.ok) { setBusy(false); return setFailure(failureText(result.kind, common)); }
    const url = new URL(window.location.href);
    url.searchParams.set('hl', next);
    navigate(url.toString());
  }
  return <SettingsRow label={t.language}>
    <NativeSelect aria-label={t.language} value={value} size="md" className="w-full max-w-60" disabled={busy}
      onChange={event => void choose(event.currentTarget.value as AccountLocale)}>
      {uiLocales.map(item => <option key={item} value={item} lang={item}>{localeNames[item]}</option>)}
    </NativeSelect>
    <p className="mt-2 text-sm text-muted-foreground">{t.languageHelp}</p>
    {failure ? <Alert role="alert" variant="destructive" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert> : null}
  </SettingsRow>;
}

export function PersonalInfo({ user }: { user: AvatarUser & { emailVerified: boolean; locale: AccountLocale | null } }) {
  const { t } = useTranslation('account');
  const { api, refresh } = useAccountClient();
  const stepUp = useStepUp();
  const [editing, setEditing] = useState<'name' | 'email'>();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ row: 'name' | 'email'; value: Outcome }>();
  const common = useTranslation('common').t;
  const failure = (kind: FailureKind) => failureText(kind, common);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setFieldError(t.nameRequired);
    setBusy(true);
    const result = await api.updateName(name.trim());
    setBusy(false);
    if (!result.ok) return setOutcome({ row: 'name', value: { tone: 'destructive', text: failure(result.kind) } });
    setEditing(undefined);
    setOutcome({ row: 'name', value: { tone: 'success', text: t.saved } });
    refresh();
  }

  async function saveEmail(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!emailPattern.test(value)) return setFieldError(t.emailInvalid);
    if (value.toLowerCase() === user.email.toLowerCase()) return setFieldError(t.emailUnchanged);
    setBusy(true);
    const result = await stepUp(() => api.changeEmail(value));
    setBusy(false);
    if (!result.ok) {
      if (result.kind === 'cancelled') return;
      return setOutcome({ row: 'email', value: { tone: 'destructive', text: failure(result.kind) } });
    }
    setEditing(undefined);
    // A verified address confirms the change first; then the new one verifies.
    setOutcome({ row: 'email', value: { tone: 'info', text: user.emailVerified
      ? t.changeEmailConfirmCurrent({ email: user.email, next: value }) : t.changeEmailSent({ email: value }) } });
  }

  async function sendVerification() {
    setBusy(true);
    const result = await api.sendVerificationEmail(user.email);
    setBusy(false);
    setOutcome({ row: 'email', value: result.ok ? { tone: 'info', text: t.verificationSent }
      : { tone: 'destructive', text: failure(result.kind) } });
  }

  const edit = (row: 'name' | 'email') => () => {
    setEditing(row); setFieldError(''); setOutcome(undefined);
    if (row === 'name') setName(user.name); else setEmail('');
  };

  return <>
    <SectionHeading title={t.personalInfo} intro={t.personalIntro} />
    <div className="flex flex-col gap-6">
      <SettingsCard title={t.basicInfo}>
        <SettingsRow label={t.profilePicture}>
          <div className="flex items-center gap-4"><UserAvatar user={user} size="lg" />
            <p className="text-sm text-muted-foreground">{t.profilePictureHelp}</p></div>
        </SettingsRow>
        {editing === 'name'
          ? <InlineForm busy={busy} onSubmit={event => void saveName(event)} onCancel={() => setEditing(undefined)}>
            <NameField label={t.fullName} value={name} error={fieldError} autoFocus disabled={busy}
              onChange={value => { setName(value); setFieldError(''); }} />
            <Note outcome={outcome?.row === 'name' ? outcome.value : undefined} />
          </InlineForm>
          : <SettingsRow label={t.fullName} action={<Button variant="ghost" onClick={edit('name')}
            aria-label={`${t.edit} · ${t.fullName}`}>{t.edit}</Button>}>
            <span className="font-medium">{user.name}</span>
            <Note outcome={outcome?.row === 'name' ? outcome.value : undefined} />
          </SettingsRow>}
      </SettingsCard>
      <SettingsCard title={t.contactInfo}>
        {editing === 'email'
          ? <InlineForm busy={busy} onSubmit={event => void saveEmail(event)} onCancel={() => setEditing(undefined)}>
            <EmailField label={t.newEmail} value={email} error={fieldError} autoComplete="email" autoFocus
              description={t.changeEmailHelp} disabled={busy}
              onChange={value => { setEmail(value); setFieldError(''); }} />
            <Note outcome={outcome?.row === 'email' ? outcome.value : undefined} />
          </InlineForm>
          : <SettingsRow label={t.email} action={<Button variant="ghost" onClick={edit('email')}>
            {t.changeEmail}</Button>}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{user.email}</span>
              {/* Rezics UI's semantic badges colour text with the fill tone; use the text-safe one. */}
              <Badge variant={user.emailVerified ? 'success' : 'warning'}
                className={user.emailVerified ? 'text-success-foreground' : 'text-warning-foreground'}>
                {user.emailVerified ? t.verified : t.unverified}</Badge>
            </div>
            {user.emailVerified ? null : <Button variant="link" className="mt-1 h-auto px-0" disabled={busy}
              onClick={() => void sendVerification()}>{t.sendVerification}</Button>}
            <Note outcome={outcome?.row === 'email' ? outcome.value : undefined} />
          </SettingsRow>}
      </SettingsCard>
      <SettingsCard title={t.preferences}>
        <LanguageRow chosen={user.locale} />
      </SettingsCard>
    </div>
  </>;
}
