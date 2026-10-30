import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { uploadAvatar } from '../threads/upload';
import { profileChanges } from './profile-data';
import { ProfileEditor, profileFieldErrors, type ProfileScope } from './profile-write';
import { useProfileEditor } from './profile-write-query';

function profileError(status: number) {
  if (status === 400 || status === 422) return m.settings_profile_invalid_error();
  if (status === 401 || status === 403) return m.settings_profile_edit_denied();
  if (status === 409) return m.settings_profile_review_needed();
  return m.settings_profile_network_error();
}

export function ProfileFeedback({
  editor,
  scope,
  writable = true,
}: {
  editor: ProfileEditor;
  scope: ProfileScope;
  writable?: boolean;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const unavailable = state.phase === 'unavailable';
  const failed = ['uncertain', 'refused', 'review'].includes(state.phase) && state.scope === scope;
  return (
    <div className="space-y-3">
      {state.phase === 'loading' ? <p role="status">{m.settings_profile_loading()}</p> : null}
      {busy && state.scope === scope ? <p role="status">{m.settings_saving()}</p> : null}
      {state.phase === 'saved' && state.scope === scope ? <p role="status">{m.settings_saved()}</p> : null}
      {unavailable || failed ? (
        <Alert variant="destructive">
          <AlertTitle>{m.settings_profile_error_title()}</AlertTitle>
          <AlertDescription>
            <p>
              {unavailable
                ? m.settings_profile_self_unavailable()
                : state.phase === 'uncertain'
                  ? m.settings_profile_network_error()
                  : state.failure
                    ? state.failure.message || profileError(state.failure.status)
                    : m.settings_profile_review_needed()}
            </p>
            <div className="flex flex-wrap gap-2">
              {state.attempt ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!writable || busy}
                  onClick={() => void editor.retry()}
                >
                  {m.settings_profile_retry_save()}
                </Button>
              ) : null}
              <Button type="button" variant="outline" disabled={!writable || busy} onClick={() => void editor.reload()}>
                {m.settings_profile_reload_current()}
              </Button>
              {state.draft ? (
                <Button type="button" variant="outline" disabled={busy} onClick={() => editor.review()}>
                  {m.settings_profile_review_draft()}
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function ProfileSection() {
  const { editor, writable } = useProfileEditor();
  return <ProfileCard key={writable ? 'signed-in' : 'unavailable'} editor={editor} writable={writable} />;
}

export function ProfileCard({ editor, writable = true }: { editor: ProfileEditor; writable?: boolean }) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const profile = state.draft;
  const ids = useId();
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [uploadError, setUploadError] = useState(false);
  const [validate, setValidate] = useState(false);
  const errors = profile && validate ? profileFieldErrors(profile) : {};
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const closed = !writable || state.phase === 'unavailable';
  const changed =
    !!profile &&
    !!state.known &&
    Object.keys(
      profileChanges(state.known, {
        ...state.known,
        displayName: profile.displayName,
        biography: profile.biography,
        avatar: profile.avatar,
        links: profile.links,
      }),
    ).length > 0;
  async function pickAvatar(file: File | undefined) {
    if (!file || !profile || closed || uploadLock.current) return;
    uploadLock.current = true;
    editor.edit({});
    setUploading(true);
    setUploadError(false);
    try {
      const uploaded = await uploadAvatar(profile.accountId, file, new AbortController().signal);
      editor.edit({ avatar: { media: uploaded.src } });
    } catch {
      setUploadError(true);
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  }
  const fieldError = (field: string) =>
    errors[field] ? (
      <p id={`${ids}-${field}-error`} className="text-sm text-destructive">
        {errors[field] === 'text'
          ? m.settings_profile_text_limit()
          : errors[field] === 'label'
            ? m.settings_profile_label_limit()
            : m.settings_profile_https_link()}
      </p>
    ) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.settings_profile_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_profile_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ProfileFeedback editor={editor} scope="profile" writable={writable} />
        {profile ? (
          <form
            className="space-y-5"
            noValidate
            aria-busy={busy || uploading}
            onSubmit={(event) => {
              event.preventDefault();
              setValidate(true);
              if (!closed && !uploading) void editor.submit('profile');
            }}
          >
            <label className="grid gap-2 text-sm font-medium">
              {m.settings_profile_display_name()}
              <Input
                value={profile.displayName ?? ''}
                maxLength={4096}
                disabled={closed}
                aria-invalid={!!errors.displayName}
                aria-describedby={errors.displayName ? `${ids}-displayName-error` : undefined}
                onChange={(event) => editor.edit({ displayName: event.target.value || null })}
              />
              {fieldError('displayName')}
            </label>
            <label className="grid gap-2 text-sm font-medium">
              {m.settings_profile_biography()}
              <Textarea
                value={profile.biography ?? ''}
                rows={6}
                maxLength={4096}
                disabled={closed}
                aria-invalid={!!errors.biography}
                aria-describedby={errors.biography ? `${ids}-biography-error` : undefined}
                onChange={(event) => editor.edit({ biography: event.target.value || null })}
              />
              {fieldError('biography')}
            </label>
            <div className="space-y-2">
              <p className="text-sm font-medium">{m.settings_profile_avatar()}</p>
              {profile.avatar ? (
                <img
                  className="size-20 rounded-full object-cover"
                  src={`/media/${encodeURIComponent(profile.avatar.media)}/webp-240`}
                  alt=""
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center rounded-md border px-4 py-2 text-sm focus-within:ring-2 focus-within:ring-ring">
                  {m.settings_profile_choose_avatar()}
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                    disabled={closed || uploading || busy}
                    onChange={(event) => {
                      void pickAvatar(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </label>
                {profile.avatar ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={closed || uploading || busy}
                    onClick={() => editor.edit({ avatar: null })}
                  >
                    {m.settings_profile_remove_avatar()}
                  </Button>
                ) : null}
                {uploading ? <span role="status">{m.settings_profile_uploading()}</span> : null}
              </div>
              {uploadError ? <p role="alert">{m.settings_profile_avatar_error()}</p> : null}
            </div>
            <div className="space-y-3">
              <h3 className="font-medium">{m.settings_profile_links()}</h3>
              {profile.links.map((link, index) => (
                <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" key={index}>
                  <div className="space-y-1">
                    <Input
                      aria-label={m.settings_profile_link_label()}
                      value={link.label}
                      required
                      disabled={closed}
                      aria-invalid={!!errors[`label-${index}`]}
                      aria-describedby={errors[`label-${index}`] ? `${ids}-label-${index}-error` : undefined}
                      onChange={(event) =>
                        editor.edit({
                          links: profile.links.map((item, at) =>
                            at === index ? { ...item, label: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    {fieldError(`label-${index}`)}
                  </div>
                  <div className="space-y-1">
                    <Input
                      aria-label={m.settings_profile_link_url()}
                      type="url"
                      value={link.url}
                      required
                      disabled={closed}
                      aria-invalid={!!errors[`url-${index}`]}
                      aria-describedby={errors[`url-${index}`] ? `${ids}-url-${index}-error` : undefined}
                      onChange={(event) =>
                        editor.edit({
                          links: profile.links.map((item, at) =>
                            at === index ? { ...item, url: event.target.value } : item,
                          ),
                        })
                      }
                    />
                    {fieldError(`url-${index}`)}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={closed}
                    onClick={() => editor.edit({ links: profile.links.filter((_, at) => at !== index) })}
                  >
                    {m.settings_profile_remove_link()}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={closed || profile.links.length >= 5}
                onClick={() => editor.edit({ links: [...profile.links, { label: '', url: '' }] })}
              >
                {m.settings_profile_add_link()}
              </Button>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={closed || busy || uploading || !!state.attempt || !changed}>
                {busy ? m.settings_saving() : m.settings_profile_save()}
              </Button>
              <Button type="button" variant="outline" disabled={!writable || busy} onClick={() => void editor.reload()}>
                {m.settings_profile_reload_current()}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
