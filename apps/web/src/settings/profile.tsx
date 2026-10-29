import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { personalRead } from '../kernel/query';
import { uploadAvatar, UploadRefusal } from '../threads/upload';
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

export function ProfileSection() {
  const session = useSession();
  const query = useQuery({
    ...personalRead,
    queryKey: ['settings', 'profile'],
    queryFn: () => readProfile(),
    retry: false,
  });
  const [draft, setDraft] = useState<ProfileValues | null>(null);
  const [saved, setSaved] = useState<ProfileValues | null>(null);
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSignal, setSavedSignal] = useState(false);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (query.data && !saved) {
      setSaved(query.data);
      setDraft(query.data);
    }
  }, [query.data, saved]);
  const profile = draft;
  const update = (next: Partial<ProfileValues>) => {
    if (profile) setDraft({ ...profile, ...next });
    setSavedSignal(false);
    setMessage('');
  };
  async function submit(next = profile) {
    if (!next || !saved || !session?.csrfToken || saving) return;
    const key = retryKey ?? crypto.randomUUID();
    setRetryKey(key);
    setSaving(true);
    setSavedSignal(false);
    setMessage('');
    try {
      const result = await saveProfile({
        data: { before: saved, after: next, idempotencyKey: key },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setSaved(result.profile);
        setDraft(result.profile);
        setRetryKey(null);
        setSavedSignal(true);
      } else {
        setRetryKey(null);
        setMessage(result.message || profileError(result.status));
      }
    } catch {
      // Keep the key for a retry whose first response may have been lost.
      setMessage(m.settings_profile_network_error());
    } finally {
      setSaving(false);
    }
  }
  async function pickAvatar(file: File | undefined) {
    if (!file || !profile || !session?.csrfToken) return;
    setUploading(true);
    setMessage('');
    try {
      const controller = new AbortController();
      const uploaded = await uploadAvatar(profile.accountId, file, controller.signal);
      update({ avatar: { id: uploaded.src, url: `/media/${encodeURIComponent(uploaded.src)}/webp-240` } });
    } catch (error) {
      setMessage(
        error instanceof UploadRefusal ? m.settings_profile_avatar_error() : m.settings_profile_avatar_error(),
      );
    } finally {
      setUploading(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.settings_profile_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_profile_text()}</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? <p role="status">{m.settings_profile_loading()}</p> : null}
        {query.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{m.settings_profile_error_title()}</AlertTitle>
            <AlertDescription>{m.settings_profile_load_error()}</AlertDescription>
          </Alert>
        ) : null}
        {profile ? (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="grid gap-2 text-sm font-medium">
              {m.settings_profile_display_name()}
              <Input
                value={profile.displayName ?? ''}
                maxLength={120}
                onChange={(event) => update({ displayName: event.target.value || null })}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              {m.settings_profile_biography()}
              <Textarea
                value={profile.biography ?? ''}
                rows={6}
                maxLength={2000}
                onChange={(event) => update({ biography: event.target.value || null })}
              />
            </label>
            <div className="space-y-2">
              <p className="text-sm font-medium">{m.settings_profile_avatar()}</p>
              {profile.avatar ? (
                <img
                  className="size-20 rounded-full object-cover"
                  src={profile.avatar.url ?? `/media/${encodeURIComponent(profile.avatar.id)}/webp-240`}
                  alt=""
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center rounded-md border px-4 py-2 text-sm">
                  {m.settings_profile_choose_avatar()}
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                    disabled={uploading || saving}
                    onChange={(event) => void pickAvatar(event.target.files?.[0])}
                  />
                </label>
                {profile.avatar ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={uploading || saving}
                    onClick={() => update({ avatar: null })}
                  >
                    {m.settings_profile_remove_avatar()}
                  </Button>
                ) : null}
                {uploading ? <span role="status">{m.settings_profile_uploading()}</span> : null}
              </div>
            </div>
            <div className="space-y-3">
              <h3 className="font-medium">{m.settings_profile_links()}</h3>
              {profile.links.map((link, index) => (
                <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" key={index}>
                  <Input
                    aria-label={m.settings_profile_link_label()}
                    value={link.label}
                    maxLength={80}
                    required
                    onChange={(event) =>
                      update({
                        links: profile.links.map((item, at) =>
                          at === index ? { ...item, label: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={m.settings_profile_link_url()}
                    type="url"
                    value={link.url}
                    required
                    onChange={(event) =>
                      update({
                        links: profile.links.map((item, at) =>
                          at === index ? { ...item, url: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => update({ links: profile.links.filter((_, at) => at !== index) })}
                  >
                    {m.settings_profile_remove_link()}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={profile.links.length >= 5 || saving}
                onClick={() => update({ links: [...profile.links, { label: '', url: '' }] })}
              >
                {m.settings_profile_add_link()}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!session?.csrfToken || saving || uploading}>
                {saving ? m.settings_saving() : m.settings_profile_save()}
              </Button>
              {savedSignal ? <span role="status">{m.settings_saved()}</span> : null}
            </div>
            {message ? (
              <Alert variant="destructive">
                <AlertTitle>{m.settings_profile_error_title()}</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
