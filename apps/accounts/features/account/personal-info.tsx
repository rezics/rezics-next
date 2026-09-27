'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { type FormEvent, type ReactNode, useState } from 'react';
import { SectionHeading, SettingsCard, SettingsRow } from './account-shell.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from './failure-text.ts';
import { EmailField, emailPattern, NameField } from '../auth/fields.tsx';
import { LocaleSelect } from '../shell/locale-select.tsx';
import { type AvatarUser, UserAvatar } from '../shell/user-avatar.tsx';
import { useTranslation } from '../../i18n/client.ts';

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

export function PersonalInfo({ user }: { user: AvatarUser & { emailVerified: boolean } }) {
  const { t } = useTranslation('account');
  const { api, refresh } = useAccountClient();
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
    setBusy(true);
    const result = await api.changeEmail(value);
    setBusy(false);
    if (!result.ok) return setOutcome({ row: 'email', value: { tone: 'destructive', text: failure(result.kind) } });
    setEditing(undefined);
    setOutcome({ row: 'email', value: { tone: 'info', text: t.changeEmailSent({ email: value }) } });
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
        <SettingsRow label={t.profilePicture}
          action={<Badge variant="secondary">{common.comingSoon}</Badge>}>
          <div className="flex items-center gap-4"><UserAvatar user={user} size="lg" />
            <p className="text-sm text-muted-foreground">{t.profilePictureHelp}</p></div>
        </SettingsRow>
        {editing === 'name'
          ? <InlineForm busy={busy} onSubmit={saveName} onCancel={() => setEditing(undefined)}>
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
          ? <InlineForm busy={busy} onSubmit={saveEmail} onCancel={() => setEditing(undefined)}>
            <EmailField label={t.newEmail} value={email} error={fieldError} autoComplete="email" autoFocus
              description={t.changeEmailHelp} disabled={busy}
              onChange={value => { setEmail(value); setFieldError(''); }} />
            <Note outcome={outcome?.row === 'email' ? outcome.value : undefined} />
          </InlineForm>
          : <SettingsRow label={t.email} action={<Button variant="ghost" onClick={edit('email')}>
            {t.changeEmail}</Button>}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{user.email}</span>
              <Badge variant={user.emailVerified ? 'success' : 'warning'}>
                {user.emailVerified ? t.verified : t.unverified}</Badge>
            </div>
            {user.emailVerified ? null : <Button variant="link" className="mt-1 h-auto px-0" disabled={busy}
              onClick={sendVerification}>{t.sendVerification}</Button>}
            <Note outcome={outcome?.row === 'email' ? outcome.value : undefined} />
          </SettingsRow>}
      </SettingsCard>
      <SettingsCard title={t.preferences}>
        <SettingsRow label={t.language}>
          <LocaleSelect />
          <p className="mt-2 text-sm text-muted-foreground">{t.languageHelp}</p>
        </SettingsRow>
      </SettingsCard>
    </div>
  </>;
}
