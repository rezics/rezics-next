import { useId, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldContent, FieldTitle } from '@rezics/ui/shadcn/field';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { ProfileFeedback } from './profile';
import { profileChanges } from './profile-data';
import type { ProfileEditor } from './profile-write';
import { useProfileEditor } from './profile-write-query';
import { usePreferenceRetry } from './preference-failure-retry';

export function PublicViewsSection() {
  const { editor, readable, writable } = useProfileEditor();
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
  const changed =
    profile &&
    state.known &&
    Object.keys(
      profileChanges(state.known, {
        ...state.known,
        publicViews: profile.publicViews,
        ...(profile.kind === 'organization' ? { speakersListed: profile.speakersListed } : {}),
      }),
    ).length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.settings_public_activity_heading()}</h2>
        </CardTitle>
        <CardDescription>
          {m.settings_public_activity_text()} {m.settings_profile_visibility_help()}
        </CardDescription>
        <CardDescription>{m.settings_public_activity_save_help()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" aria-busy={busy}>
        <ProfileFeedback editor={editor} scope="views" writable={writable} readable={canRead} showReaderReload />
        <div role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium">
          {changed && !closed && !busy && !state.attempt && state.phase !== 'uncertain'
            ? m.settings_public_activity_unsaved()
            : null}
        </div>
        {profile ? (
          <>
            {(['posts', 'reviews', 'collections', 'realms'] as const).map((view) => (
              <label key={view} htmlFor={`${ids}-${view}`} className="block min-h-11 w-full py-3">
                <Field orientation="horizontal">
                  <FieldContent className="min-w-0">
                    <FieldTitle>{m[`settings_public_${view}`]()}</FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${ids}-${view}`}
                    checked={profile.publicViews[view]}
                    disabled={closed || busy}
                    onCheckedChange={(checked) => {
                      editor.edit({ publicViews: { ...profile.publicViews, [view]: checked } });
                    }}
                  />
                </Field>
              </label>
            ))}
            {profile.kind === 'organization' ? (
              <label htmlFor={`${ids}-speakers`} className="block min-h-11 w-full py-3">
                <Field orientation="horizontal">
                  <FieldContent className="min-w-0">
                    <FieldTitle>{m.settings_public_speakers()}</FieldTitle>
                  </FieldContent>
                  <Switch
                    id={`${ids}-speakers`}
                    checked={profile.speakersListed === true}
                    disabled={closed || busy}
                    onCheckedChange={(checked) => {
                      editor.edit({ speakersListed: checked });
                    }}
                  />
                </Field>
              </label>
            ) : null}
            {changed && !busy ? (
              <Button
                type="button"
                variant="outline"
                className="mt-2 h-auto min-h-11 w-full max-w-sm justify-start whitespace-normal break-words py-2 text-left"
                disabled={closed || !!state.attempt || commandWaiting}
                onClick={() => void editor.submit('views')}
              >
                {m.settings_profile_save_activity()}
              </Button>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
