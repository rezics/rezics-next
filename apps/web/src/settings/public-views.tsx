import { useId, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { Field, FieldContent, FieldTitle } from '@rezics/ui/shadcn/field';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { ProfileFeedback } from './profile';
import { profileChanges, profilePatchAdmitted, profileFieldAdmitted } from './profile-model';
import type { ProfileEditor } from './profile-write';
import { useProfileEditor } from './profile-write-query';
import type { SettingsContentFailureReader } from './ports/content';
import { usePreferenceRetry } from './preferences';

export function PublicViewsSection({ mediaFailure }: { mediaFailure: SettingsContentFailureReader }) {
  const { editor, readable, writable } = useProfileEditor(mediaFailure);
  return <PublicViewsCard editor={editor} readable={readable} writable={writable} />;
}

export function PublicViewsCard({
  editor,
  writable = true,
  readable,
}: {
  editor: ProfileEditor;
  writable?: boolean;
  readable?: boolean;
}) {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const commandWaiting = usePreferenceRetry(undefined, state.commandRetryAt);
  const canRead = readable ?? writable;
  const profile = canRead && state.readAuthority === 'allowed' ? state.draft : null;
  const ids = useId();
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const closed = !writable || state.readAuthority !== 'allowed' || state.phase === 'unavailable';
  const viewsPatch =
    profile && state.known
      ? profileChanges(state.known, {
          ...state.known,
          publicViews: profile.publicViews,
          ...(profile.kind === 'organization' ? { speakersListed: profile.speakersListed } : {}),
        })
      : {};
  const changed = Object.keys(viewsPatch).length > 0;
  const canSubmitPatch = changed && profilePatchAdmitted(viewsPatch, state.editing);
  const viewLabels = {
    posts: m.settings_public_posts(),
    reviews: m.settings_public_reviews(),
    collections: m.settings_public_collections(),
    realms: m.settings_public_realms(),
  };
  return (
    <ContentSection>
      <ContentSectionHeader className="space-y-3">
        <ContentSectionTitle>
          <h2>{m.settings_public_activity_heading()}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription className="max-w-3xl leading-6">
          {m.settings_public_activity_text()}
        </ContentSectionDescription>
        <ContentSectionDescription className="max-w-3xl leading-6">
          {m.settings_profile_visibility_help()}
        </ContentSectionDescription>
      </ContentSectionHeader>
      <ContentSectionBody className="space-y-5" aria-busy={busy}>
        <div className="max-w-3xl overflow-hidden rounded-lg border">
          {profile ? (
            <div className="divide-y">
              {(['posts', 'reviews', 'collections', 'realms'] as const).map((view) => (
                <label
                  key={view}
                  htmlFor={`${ids}-${view}`}
                  className="block w-full cursor-pointer px-3 py-2"
                >
                  <Field orientation="horizontal">
                    <FieldContent className="min-w-0 flex-1">
                      <FieldTitle className="whitespace-normal break-words">{viewLabels[view]}</FieldTitle>
                    </FieldContent>
                    <Switch
                      id={`${ids}-${view}`}
                      checked={profile.publicViews[view]}
                      className="shrink-0"
                      disabled={closed || busy || !profileFieldAdmitted('publicViews', state.editing, view)}
                      onCheckedChange={(checked) => {
                        editor.edit({ publicViews: { ...profile.publicViews, [view]: checked } });
                      }}
                    />
                  </Field>
                </label>
              ))}
              {profile.kind === 'organization' ? (
                <label
                  htmlFor={`${ids}-speakers`}
                  className="block w-full cursor-pointer px-3 py-2"
                >
                  <Field orientation="horizontal">
                    <FieldContent className="min-w-0 flex-1">
                      <FieldTitle className="whitespace-normal break-words">{m.settings_public_speakers()}</FieldTitle>
                    </FieldContent>
                    <Switch
                      id={`${ids}-speakers`}
                      checked={profile.speakersListed === true}
                      className="shrink-0"
                      disabled={closed || busy || !profileFieldAdmitted('speakersListed', state.editing)}
                      onCheckedChange={(checked) => {
                        editor.edit({ speakersListed: checked });
                      }}
                    />
                  </Field>
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-4 border-t bg-muted/20 p-4 sm:p-5">
            <p className="break-words text-sm leading-6 text-muted-foreground">
              {m.settings_public_activity_save_help()}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium">
                {changed && !closed && !busy && !state.attempt && state.phase !== 'uncertain'
                  ? m.settings_public_activity_unsaved()
                  : null}
              </div>
              {changed && !busy ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full max-w-sm justify-start whitespace-normal break-words text-left sm:w-auto min-h-7"
                  disabled={closed || !!state.attempt || commandWaiting || !canSubmitPatch}
                  onClick={() => void editor.submit('views')}
                >
                  {m.settings_profile_save_activity()}
                </Button>
              ) : null}
            </div>
            <ProfileFeedback editor={editor} scope="views" writable={writable} readable={canRead} showReaderReload />
          </div>
        </div>
      </ContentSectionBody>
    </ContentSection>
  );
}
