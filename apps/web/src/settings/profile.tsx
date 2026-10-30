import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Input } from '@rezics/ui/shadcn/input';
import { MediaImage } from '@rezics/ui/media-image';
import { coverSrc } from '../media/cover-src';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../paraglide/messages.js';
import { uploadAvatar } from '../threads/upload';
import { profileChanges } from './profile-data';
import { ProfileEditor, profileFieldErrors, type ProfileScope } from './profile-write';
import { useProfileEditor } from './profile-write-query';
import { ProfileAvatar, useProfileAvatarUpload } from './profile-avatar';
import type { AvatarUpload } from './profile-avatar-upload';
import { ProfileNavigation, useProfileNavigationUpload } from './profile-navigation';

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
  const { editor, writable, isCurrent } = useProfileEditor();
  return (
    <ProfileNavigation editor={editor} writable={writable} isCurrent={isCurrent}>
      <ProfileCard key={writable ? 'signed-in' : 'unavailable'} editor={editor} writable={writable} />
    </ProfileNavigation>
  );
}

export function ProfileCard({
  editor,
  writable = true,
  avatarUpload,
}: {
  editor: ProfileEditor;
  writable?: boolean;
  avatarUpload?: AvatarUpload;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const profile = state.draft;
  const ids = useId();
  const [validationAttempt, setValidationAttempt] = useState(0);
  const controls = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLDivElement | null>>({});
  const pendingFocus = useRef<string | undefined>(undefined);
  const submittedDraft = useRef<typeof profile>(null);
  const errors = profile && validationAttempt > 0 ? profileFieldErrors(profile) : {};
  useEffect(() => {
    const field = pendingFocus.current;
    pendingFocus.current = undefined;
    if (field) controls.current[field]?.focus();
  }, [validationAttempt]);
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const closed = !writable || state.phase === 'unavailable';
  const avatar = useProfileAvatarUpload(editor, closed, avatarUpload);
  useProfileNavigationUpload(avatar.controller);
  const uploading = avatar.blocked;
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
  const errorMessage = (field: string) =>
    errors[field] === 'text'
      ? m.settings_profile_text_limit()
      : errors[field] === 'label'
        ? m.settings_profile_label_limit()
        : errors[field] === 'links'
          ? m.settings_profile_links_limit()
          : m.settings_profile_https_link();
  const fieldLabel = (field: string) => {
    if (field === 'displayName') return m.settings_profile_display_name();
    if (field === 'biography') return m.settings_profile_biography();
    if (field === 'links') return m.settings_profile_links();
    const [kind, index] = field.split('-');
    return m.settings_profile_link_field({
      number: Number(index) + 1,
      field: kind === 'label' ? m.settings_profile_link_label() : m.settings_profile_link_url(),
    });
  };
  const fieldError = (field: string) =>
    errors[field] ? (
      <p id={`${ids}-${field}-error`} className="text-sm text-destructive">
        {errorMessage(field)}
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
              const invalidFields = Object.keys(profileFieldErrors(profile));
              if (invalidFields.length) {
                submittedDraft.current = profile;
                pendingFocus.current = invalidFields[0];
                setValidationAttempt((attempt) => attempt + 1);
                return;
              }
              if (!closed && !uploading) void editor.submit('profile');
            }}
          >
            {Object.keys(errors).length ? (
              <Alert variant="destructive" role="group" aria-labelledby={`${ids}-validation-summary`}>
                <AlertTitle
                  key={validationAttempt}
                  id={`${ids}-validation-summary`}
                  // Only an explicit invalid submission announces; edits update the links quietly.
                  role={submittedDraft.current === profile ? 'alert' : undefined}
                  aria-atomic="true"
                >
                  {m.settings_profile_validation_summary()}
                </AlertTitle>
                <AlertDescription>
                  <ul>
                    {Object.keys(errors).map((field) => (
                      <li key={field}>
                        <a
                          href={`#${ids}-${field}`}
                          className="block min-h-11 content-center rounded-sm py-2 break-words underline focus-visible:outline-2 focus-visible:outline-offset-2"
                          onClick={(event) => {
                            event.preventDefault();
                            controls.current[field]?.focus();
                          }}
                        >
                          {fieldLabel(field)}: {errorMessage(field)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <label htmlFor={`${ids}-displayName`} className="grid gap-2 text-sm font-medium">
              {m.settings_profile_display_name()}
              <Input
                id={`${ids}-displayName`}
                ref={(control) => {
                  controls.current.displayName = control;
                }}
                value={profile.displayName ?? ''}
                maxLength={4096}
                disabled={closed}
                aria-invalid={!!errors.displayName}
                aria-describedby={errors.displayName ? `${ids}-displayName-error` : undefined}
                onChange={(event) => editor.edit({ displayName: event.target.value || null })}
              />
              {fieldError('displayName')}
            </label>
            <label htmlFor={`${ids}-biography`} className="grid gap-2 text-sm font-medium">
              {m.settings_profile_biography()}
              <Textarea
                id={`${ids}-biography`}
                ref={(control) => {
                  controls.current.biography = control;
                }}
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
            <ProfileAvatar
              avatar={profile.avatar}
              known={state.known?.avatar ?? null}
              upload={avatar}
              disabled={closed || busy || !!state.attempt}
            />
            <div
              id={`${ids}-links`}
              ref={(control) => {
                controls.current.links = control;
              }}
              role="group"
              tabIndex={-1}
              aria-labelledby={`${ids}-links-heading`}
              aria-invalid={!!errors.links}
              aria-describedby={errors.links ? `${ids}-links-error` : undefined}
              className="space-y-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <h3 id={`${ids}-links-heading`} className="font-medium">
                {m.settings_profile_links()}
              </h3>
              {fieldError('links')}
              {profile.links.map((link, index) => (
                <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" key={index}>
                  <div className="space-y-1">
                    <Input
                      id={`${ids}-label-${index}`}
                      ref={(control) => {
                        controls.current[`label-${index}`] = control;
                      }}
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
                      id={`${ids}-url-${index}`}
                      ref={(control) => {
                        controls.current[`url-${index}`] = control;
                      }}
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
