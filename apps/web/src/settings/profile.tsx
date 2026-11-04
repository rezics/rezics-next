import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from '@tanstack/react-router';
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
import { ProfileEditor, profileFieldErrors, type ProfileScope, type ProfileEditorState } from './profile-write';
import { useProfileEditor } from './profile-write-query';
import { ProfileAvatar, useProfileAvatarUpload } from './profile-avatar';
import { ProfileLinks } from './profile-links';
import { ProfilePreview } from './profile-preview';
import type { AvatarResume, AvatarUpload } from './profile-avatar-upload';
import { ProfileNavigation, useProfileNavigationUpload } from './profile-navigation';
import { usePreferenceRetry } from './preference-failure-retry';

function profileError(scope: ProfileScope, failure: ProfileEditorState['failure']) {
  const activity = scope === 'views';
  if (failure?.status === 403 && failure.code === 'platform_closed')
    return activity ? m.settings_public_activity_closed() : m.settings_profile_save_closed();
  if (failure?.status === 400 || failure?.status === 422)
    return activity ? m.settings_public_activity_invalid() : m.settings_profile_invalid_error();
  if (failure?.status === 401 || failure?.status === 403)
    return activity ? m.settings_public_activity_denied() : m.settings_profile_edit_denied();
  if (failure?.status === 409)
    return activity ? m.settings_public_activity_conflict() : m.settings_profile_save_conflict();
  return activity ? m.settings_public_activity_unavailable() : m.settings_profile_save_unavailable();
}

export function ProfileFeedback({
  editor,
  scope,
  writable = true,
  readable,
  showReaderReload = false,
}: {
  editor: ProfileEditor;
  scope: ProfileScope;
  writable?: boolean;
  readable?: boolean;
  showReaderReload?: boolean;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const commandWaiting = usePreferenceRetry(undefined, state.commandRetryAt);
  const readWaiting = usePreferenceRetry(undefined, state.readRetryAt);
  const canRead = readable ?? writable;
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const denied = state.readAuthority === 'denied';
  const unavailable = state.readStatus === 'failed' || state.phase === 'unavailable' || denied;
  const failed = ['uncertain', 'refused', 'review'].includes(state.phase) && state.scope === scope;
  const uncertainScope = state.attempt?.scope ?? state.scope;
  const commandWaitLabel = state.attempt
    ? uncertainScope === 'views'
      ? m.settings_public_activity_retry()
      : m.settings_profile_retry_save()
    : state.scope === 'views'
      ? m.settings_profile_save_activity()
      : m.settings_profile_save();
  const uncertain =
    uncertainScope === 'views' ? m.settings_public_activity_unknown() : m.settings_profile_save_unknown();
  return (
    <div className="space-y-3">
      {state.phase === 'loading' ? <p role="status">{m.settings_profile_loading()}</p> : null}
      {state.phase === 'saving' && state.scope === scope ? <p role="status">{m.settings_saving()}</p> : null}
      {state.phase === 'reloading' ? (
        <p role="status">
          {state.readStatus === 'confirming' ? m.settings_profile_confirming() : m.settings_profile_checking()}
        </p>
      ) : null}
      {state.phase === 'saved' && state.scope === scope ? <p role="status">{m.settings_saved()}</p> : null}
      {commandWaiting ? (
        <p role="status">
          {commandWaitLabel}: {m.settings_retry_wait()}
        </p>
      ) : null}
      {readWaiting ? (
        <p role="status">
          {m.settings_profile_reload_current()}: {m.settings_retry_wait()}
        </p>
      ) : null}
      {unavailable || failed ? (
        <Alert
          variant="destructive"
          data-response-status={state.failure?.status}
          data-response-code={state.failure?.code}
          data-retry-after={state.failure?.retryAfter}
        >
          <AlertTitle>
            {unavailable
              ? m.settings_profile_error_title()
              : scope === 'views'
                ? m.settings_public_activity_error_title()
                : m.settings_profile_save_error_title()}
          </AlertTitle>
          <AlertDescription>
            <p>
              {unavailable
                ? state.failure?.status === 403 && state.failure.code === 'platform_closed'
                  ? m.settings_profile_read_closed()
                  : denied
                    ? m.settings_profile_read_denied()
                    : m.settings_profile_read_failed()
                : state.failure
                  ? profileError(scope, state.failure)
                  : state.phase === 'uncertain'
                    ? uncertain
                    : m.settings_profile_review_needed()}
            </p>
            {state.acknowledged ? (
              <p>{m.settings_profile_acknowledged_stale()}</p>
            ) : state.attempt && (unavailable || state.failure) ? (
              <p>{uncertain}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {state.attempt && !state.acknowledged ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                  disabled={!writable || busy || commandWaiting}
                  onClick={() => void editor.retry()}
                >
                  {uncertainScope === 'views' ? m.settings_public_activity_retry() : m.settings_profile_retry_save()}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                disabled={!canRead || busy || readWaiting}
                onClick={() => void editor.reload()}
              >
                {m.settings_profile_reload_current()}
              </Button>
              {state.draft ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                  disabled={!writable || busy || denied}
                  onClick={() => editor.review()}
                >
                  {m.settings_profile_review_draft()}
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {showReaderReload && canRead && !writable && !unavailable && !failed ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
          disabled={busy || readWaiting}
          onClick={() => void editor.reload()}
        >
          {m.settings_profile_reload_current()}
        </Button>
      ) : null}
    </div>
  );
}

export function ProfileSection() {
  const location = useLocation();
  const { editor, readable, writable, isCurrent, observationKey } = useProfileEditor();
  const previewActive = new URL(location.publicHref, 'https://rezics.local').hash === '#profile';
  return (
    <ProfileNavigation editor={editor} writable={writable} isCurrent={isCurrent}>
      <ProfileCard
        key={observationKey}
        editor={editor}
        writable={writable}
        readable={readable}
        previewActive={previewActive}
      />
    </ProfileNavigation>
  );
}

export function ProfileCard({
  editor,
  writable = true,
  readable,
  previewActive = false,
  avatarUpload,
  avatarResume,
}: {
  editor: ProfileEditor;
  writable?: boolean;
  readable?: boolean;
  previewActive?: boolean;
  avatarUpload?: AvatarUpload;
  avatarResume?: AvatarResume;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const commandWaiting = usePreferenceRetry(undefined, state.commandRetryAt);
  const readWaiting = usePreferenceRetry(undefined, state.readRetryAt);
  const canRead = readable ?? writable;
  const profile = canRead && state.readAuthority === 'allowed' ? state.draft : null;
  const ids = useId();
  const [validationAttempt, setValidationAttempt] = useState(0);
  const controls = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLDivElement | null>>({});
  const pendingFocus = useRef<string | undefined>(undefined);
  const submittedDraft = useRef<typeof profile>(null);
  const validationErrors = profile ? profileFieldErrors(profile) : {};
  const errors = profile && validationAttempt > 0 ? validationErrors : {};
  useEffect(() => {
    const field = pendingFocus.current;
    pendingFocus.current = undefined;
    if (field && editor.canWrite()) (controls.current[field] ?? document.getElementById(`${ids}-${field}`))?.focus();
  }, [editor, validationAttempt]);
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const unreadable = !canRead || state.readAuthority !== 'allowed' || state.phase === 'unavailable';
  const closed = !writable || unreadable;
  const avatar = useProfileAvatarUpload(editor, unreadable, avatarUpload, avatarResume);
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
        <CardDescription>{m.settings_profile_save_help()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ProfileFeedback editor={editor} scope="profile" writable={writable} readable={canRead} />
        <div role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium">
          {changed && !closed && !busy && !state.attempt && state.phase !== 'uncertain'
            ? m.settings_profile_unsaved()
            : null}
        </div>
        {profile ? (
          <form
            className="space-y-5"
            noValidate
            aria-busy={busy || uploading}
            onSubmit={(event) => {
              event.preventDefault();
              if (closed || !editor.canWrite()) return;
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
                            if (!editor.canWrite()) return;
                            (controls.current[field] ?? document.getElementById(`${ids}-${field}`))?.focus();
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
                className="min-h-11"
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
              disabled={unreadable || busy || !!state.attempt}
              referenceDisabled={closed || busy || !!state.attempt}
              saving={state.phase === 'saving' || state.phase === 'reloading' || state.phase === 'uncertain'}
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
              className="min-w-0 space-y-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <h3 id={`${ids}-links-heading`} className="font-medium">
                {m.settings_profile_links()}
              </h3>
              {fieldError('links')}
              <ProfileLinks
                links={profile.links}
                disabled={closed}
                onChange={(links) => editor.edit({ links })}
                ids={ids}
                errors={errors}
                fieldError={fieldError}
              />
            </div>
            {previewActive && profile && !closed ? (
              <ProfilePreview
                displayName={profile.displayName}
                biography={profile.biography}
                avatar={profile.avatar}
                localAvatarUrl={avatar.state.url}
                hasUnsavedChanges={changed || !!avatar.state.url}
                links={profile.links.slice(0, 5).map((link, index) => ({
                  label: link.label,
                  url: link.url,
                  valid: !validationErrors[`label-${index}`] && !validationErrors[`url-${index}`],
                }))}
              />
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                disabled={closed || busy || uploading || !!state.attempt || commandWaiting || !changed}
              >
                {state.phase === 'saving' && state.scope === 'profile'
                  ? m.settings_saving()
                  : m.settings_profile_save()}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                disabled={!canRead || busy || readWaiting}
                onClick={() => void editor.reload()}
              >
                {m.settings_profile_reload_current()}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
