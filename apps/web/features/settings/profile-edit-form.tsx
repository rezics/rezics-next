'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { useEffect, useState, type FormEvent } from 'react';
import type { PublicAgentProfile } from '../auth/agent-profile.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import { AvatarFileField } from './avatar-file-field.tsx';
import type { SettingsMessages } from './messages.ts';

export function ProfileEditForm({ agent, profile, locale, t, ownPerson, operationKey }: {
  agent: string;
  profile: PublicAgentProfile | null;
  locale: UiLocale;
  t: SettingsMessages;
  ownPerson: boolean;
  operationKey: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [hydrated, setHydrated] = useState(false);
  const [bio, setBio] = useState(profile?.bio?.text ?? '');
  const [chosen, setChosen] = useState<string | null>(null);
  const reading = useReadingLanguages(agent);
  const bioLanguage = writingLanguage({ chosen, existing: profile?.bio?.language, reading });
  const written = textAttributes(bioLanguage, bio);
  useEffect(() => setHydrated(true), []);
  const action = localizedPath('/settings/profile', locale);
  const errors: Record<string, string> = { conflict: t.conflict, denied: t.denied,
    invalid: t.invalid, 'avatar-denied': t.avatarDenied,
    'avatar-unavailable': t.avatarUnavailable };
  const errorMessage = failure ? errors[failure] ?? t.failed : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !profile) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const response = await fetch(action, { method: 'POST', body: new FormData(event.currentTarget),
        credentials: 'same-origin' });
      const result = new URL(response.url);
      if (response.redirected && result.origin === window.location.origin
        && result.searchParams.get('updated') === 'profile') {
        window.location.assign(`${result.pathname}${result.search}`);
        return;
      }
      setFailure(result.searchParams.get('error') ?? 'unavailable');
    } catch { setFailure('unavailable'); }
    setBusy(false);
  }

  return <form action={action} method="post" encType="multipart/form-data"
    data-hydrated={hydrated ? 'true' : undefined}
    onSubmit={event => void submit(event)} className="grid gap-4 border-border border-t pt-4">
    <div className="grid gap-1"><h2 className="font-medium">{t.publicProfile}</h2>
      <p className="text-muted-foreground text-sm">{ownPerson ? t.accountInfo : t.otherInfo}</p></div>
    {!profile ? <p role="status" className="text-muted-foreground text-sm">{t.profileUnavailable}</p> : null}
    {failure ? <Alert variant="warning"><AlertDescription role="status">{errorMessage}</AlertDescription></Alert> : null}
    <label className="grid gap-1 text-sm font-medium">{t.displayName}
      <input name="displayName" type="text" required maxLength={200} defaultValue={profile?.displayName ?? ''}
        disabled={!profile || busy} className="h-10 rounded-md border border-input bg-background px-3" /></label>
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="profile-bio" className="font-medium text-sm">{t.bio}</label>
        <LanguageSelect value={bioLanguage} onChange={setChosen} locale={locale} reading={reading}
          disabled={!profile || busy} label={t.bioLanguage} />
      </div>
      <textarea id="profile-bio" name="bio" rows={3} maxLength={500} value={bio} lang={written.lang} dir={written.dir}
        onChange={event => setBio(event.currentTarget.value)}
        disabled={!profile || busy} className="rounded-md border border-input bg-background p-3" />
      <input type="hidden" name="bioLanguage" value={bioLanguage} />
    </div>
    <AvatarFileField label={t.avatar} choose={t.chooseAvatar} none={t.noAvatarSelected}
      disabled={!profile || busy} />
    <p className="text-muted-foreground text-sm">{t.avatarHelp}</p>
    {profile?.avatarSelection ? <label className="flex items-center gap-2 text-sm">
      <input name="removeAvatar" type="checkbox" disabled={busy} />{t.removeAvatar}</label> : null}
    <input type="hidden" name="agent" value={agent} />
    <input type="hidden" name="expectedHead" value={profile?.revision ?? ''} />
    <input type="hidden" name="key" value={operationKey} />
    <Button type="submit" className="w-fit" isLoading={busy} disabled={!profile || busy}>{t.saveProfile}</Button>
  </form>;
}
