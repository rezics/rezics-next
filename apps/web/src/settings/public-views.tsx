import { useQuery } from '@tanstack/react-query';
import { useId, useLayoutEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldContent, FieldTitle } from '@rezics/ui/shadcn/field';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { csrfHeaders } from '../threads/composer';
import { readProfile, saveProfile } from './actions';
import type { ProfileValues } from './profile-data';

function profileError(status: number) {
  if (status === 400) return m.settings_profile_error_400();
  if (status === 403) return m.settings_profile_error_403();
  if (status === 409) return m.settings_profile_error_409();
  if (status === 422) return m.settings_profile_error_422();
  return m.settings_profile_network_error();
}

export function PublicViewsSection() {
  const session = useSession();
  const query = useQuery({
    ...personalRead,
    queryKey: ['settings', 'profile'],
    queryFn: () => readProfile(),
    retry: false,
  });
  const [profile, setProfile] = useState<ProfileValues | null>(null);
  const [known, setKnown] = useState<ProfileValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [savedSignal, setSavedSignal] = useState(false);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const ids = useId();
  useLayoutEffect(() => {
    if (query.data && !known) {
      setProfile(query.data);
      setKnown(query.data);
    }
  }, [query.data, known]);
  async function change(next: ProfileValues) {
    if (!profile || !known || !session?.csrfToken || saving) return;
    const key = retryKey ?? crypto.randomUUID();
    setRetryKey(key);
    setSaving(true);
    setSavedSignal(false);
    setMessage('');
    try {
      const result = await saveProfile({
        data: { before: known, after: next, idempotencyKey: key },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setProfile(result.profile);
        setKnown(result.profile);
        setRetryKey(null);
        setSavedSignal(true);
      } else {
        setProfile(next);
        setRetryKey(null);
        setMessage(result.message || profileError(result.status));
      }
    } catch {
      setProfile(next);
      setMessage(m.settings_profile_network_error());
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.settings_public_activity_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_public_activity_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? <p role="status">{m.settings_profile_loading()}</p> : null}
        {query.isError ? <p role="alert">{m.settings_profile_load_error()}</p> : null}
        {profile ? (
          <>
            {(['posts', 'reviews', 'collections', 'realms'] as const).map((view) => (
              <label key={view} htmlFor={`${ids}-${view}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{m[`settings_public_${view}`]()}</FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${ids}-${view}`}
                    checked={profile.publicViews[view]}
                    disabled={!session?.csrfToken || saving}
                    onCheckedChange={(checked) =>
                      void change({ ...profile, publicViews: { ...profile.publicViews, [view]: checked } })
                    }
                  />
                </Field>
              </label>
            ))}
            {profile.kind === 'organization' ? (
              <label htmlFor={`${ids}-speakers`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{m.settings_public_speakers()}</FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${ids}-speakers`}
                    checked={profile.speakersListed === true}
                    disabled={!session?.csrfToken || saving}
                    onCheckedChange={(checked) => void change({ ...profile, speakersListed: checked })}
                  />
                </Field>
              </label>
            ) : null}
            {savedSignal ? <p role="status">{m.settings_saved()}</p> : null}
            {message ? (
              <Alert variant="destructive">
                <AlertTitle>{m.settings_profile_error_title()}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
