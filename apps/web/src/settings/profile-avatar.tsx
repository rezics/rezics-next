import { useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { UserRound } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@rezics/ui/shadcn/avatar';
import { Button } from '@rezics/ui/shadcn/button';
import { MediaImage } from '@rezics/ui/media-image';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { resumeReplyImageUpload, uploadAvatar, type UploadRefusalReason } from '../threads/upload';
import type { ProfileValues } from './profile-data';
import type { ProfileEditor } from './profile-write';
import { avatarMedia, ProfileAvatarUpload, type AvatarResume, type AvatarUpload } from './profile-avatar-upload';
import { usePreferenceRetry } from './preference-failure-retry';

export function useProfileAvatarUpload(
  editor: ProfileEditor,
  closed: boolean,
  upload: AvatarUpload = uploadAvatar,
  resume: AvatarResume | undefined = upload === uploadAvatar ? resumeReplyImageUpload : undefined,
) {
  const controller = useMemo(() => new ProfileAvatarUpload(editor, upload, URL, resume), [editor, upload, resume]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useLayoutEffect(() => {
    if (!closed) return controller.connect();
  }, [controller, closed]);
  return { controller, state, blocked: state.phase === 'uploading' || state.phase === 'error' };
}

function avatarFailure(reason: UploadRefusalReason | undefined) {
  switch (reason) {
    case 'type':
      return m.settings_profile_avatar_type();
    case 'too-large':
      return m.settings_profile_avatar_too_large();
    case 'rejected':
      return m.settings_profile_avatar_rejected();
    case 'closed':
      return m.settings_profile_avatar_closed();
    case 'rate-limited':
      return m.settings_profile_avatar_rate_limited();
    default:
      return m.settings_profile_avatar_error();
  }
}

/** Product controls compose shadcn primitives with native summaries and a separately owned local preview. */
export function ProfileAvatar({
  avatar,
  known,
  upload,
  disabled,
}: {
  avatar: ProfileValues['avatar'];
  known: ProfileValues['avatar'];
  upload: ReturnType<typeof useProfileAvatarUpload>;
  disabled: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const { state, controller } = upload;
  const waiting = usePreferenceRetry(undefined, state.retryAt ?? 0);
  const local = !!state.url;
  const changed = avatarMedia(avatar) !== avatarMedia(known);
  const status =
    state.phase === 'uploading'
      ? m.settings_profile_uploading()
      : state.phase === 'ready'
        ? m.settings_profile_avatar_ready()
        : state.phase === 'error'
          ? avatarFailure(state.failure?.reason)
          : changed
            ? avatar
              ? m.settings_profile_avatar_draft()
              : m.settings_profile_avatar_removal()
            : avatar
              ? m.settings_profile_avatar_saved()
              : m.settings_profile_avatar_empty();
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="space-y-3">
      <p id={`${id}-label`} className="text-sm font-medium">
        {m.settings_profile_avatar()}
      </p>
      <div className="flex items-center gap-4">
        {local || !avatar || !('variants' in avatar) ? (
          <Avatar className="size-20 shrink-0">
            {state.url ? <AvatarImage src={state.url} alt={m.settings_profile_avatar_preview()} /> : null}
            <AvatarFallback>
              <UserRound className="size-8" aria-hidden="true" />
            </AvatarFallback>
          </Avatar>
        ) : (
          <div className="size-20 shrink-0 overflow-hidden rounded-full bg-muted">
            <MediaImage
              {...avatar}
              className="rounded-full"
              frame={1}
              sizes="80px"
              alt=""
              src={({ media, format, width }) => coverSrc(media, format, width)}
            />
          </div>
        )}
        <div className="min-w-0 space-y-1 text-sm">
          {local ? <p className="font-medium">{m.settings_profile_avatar_preview()}</p> : null}
          <p id={`${id}-status`} role={state.phase === 'error' ? 'alert' : 'status'}>
            {status}
          </p>
          {waiting && state.failure?.retryAfter !== undefined ? (
            <p role="status">{m.settings_profile_avatar_retry_after({ seconds: state.failure.retryAfter })}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button ref={choose} type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}>
          {m.settings_profile_choose_avatar()}
        </Button>
        <input
          ref={input}
          hidden
          type="file"
          accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
          aria-label={m.settings_profile_choose_avatar()}
          disabled={disabled}
          onChange={(event) => {
            controller.choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        {local || state.phase === 'error' ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              controller.cancel();
              choose.current?.focus();
            }}
          >
            {m.settings_profile_avatar_cancel()}
          </Button>
        ) : null}
        {controller.canRetry() && local ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled || waiting}
            onClick={() => {
              controller.retry();
              choose.current?.focus();
            }}
          >
            {m.settings_profile_avatar_retry()}
          </Button>
        ) : null}
        {avatar || local ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              controller.remove();
              choose.current?.focus();
            }}
          >
            {m.settings_profile_remove_avatar()}
          </Button>
        ) : null}
      </div>
      {state.phase === 'cancelled' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.settings_profile_avatar_cancelled()}
        </p>
      ) : null}
    </div>
  );
}
