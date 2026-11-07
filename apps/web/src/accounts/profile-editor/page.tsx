import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import type * as ProfilePresentation from '../../settings/ports/profile-editor-view';
import { usePreferenceRetry } from '../../settings/ports/profile-editor';
import { useSettingsAmbient } from '../../settings/adapters/ambient-view.tsx';
import type { AccountProfileRuntime, ProfileSessionObservation } from './ports';
import { AccountProfileEditor } from './editor';
import { profilePageReadError, type ProfilePage } from './data';

import { accountProfileHref } from './address';
export { accountProfileHref } from './address';
export type AccountProfilePresentation = typeof ProfilePresentation;
export function AccountProfilePage({
  accountId,
  presentation,
  runtime,
}: {
  accountId: string;
  presentation: AccountProfilePresentation;
  runtime: AccountProfileRuntime;
}) {
  const boundSession = runtime.useSession();
  const { session, observation } = boundSession;
  return (
    <article className="mx-auto w-full max-w-2xl space-y-6 pb-8">
      <PageHeading>{m.account_profile_title()}</PageHeading>
      {session.state === 'signed-in' && session.subject && session.csrfToken ? (
        <BoundProfile
          key={`${accountId}:${observation}:${session.subject}:${session.csrfToken}`}
          accountId={accountId}
          presentation={presentation}
          runtime={runtime}
          boundSession={boundSession}
          viewerId={session.subject}
          csrfToken={session.csrfToken}
        />
      ) : (
        <p role="status">
          {session.state === 'unknown' ? m.settings_profile_loading() : m.account_profile_signed_out()}
        </p>
      )}
    </article>
  );
}
function BoundProfile({
  accountId,
  viewerId,
  csrfToken,
  presentation,
  runtime,
  boundSession,
}: {
  accountId: string;
  viewerId: string;
  csrfToken: string;
  presentation: AccountProfilePresentation;
  runtime: AccountProfileRuntime;
  boundSession: ProfileSessionObservation;
}) {
  const { ProfileNavigation } = presentation;
  const ambient = useSettingsAmbient();
  const [page, setPage] = useState<ProfilePage | null>(null);
  const [binding] = useState(() => {
    const lease = boundSession.bind(viewerId, csrfToken);
    const current = lease.isCurrent;
    const editor = new AccountProfileEditor({
      ambient,
      isCurrent: current,
      read: async (signal) => {
        if (!current()) throw new Error('Profile selection changed');
        let next: ProfilePage;
        try {
          next = await runtime.read({ accountId, viewerId }, signal);
        } catch {
          next = { state: 'unavailable' };
        }
        // A detached request may complete, but cannot seed or replace any live draft.
        if (!current() || signal?.aborted) throw new Error('Profile selection changed');
        if (next.state === 'ready' && (next.viewerId !== viewerId || next.profile.accountId !== accountId))
          next = { state: 'unavailable' };
        setPage(next);
        if (next.state !== 'ready') throw profilePageReadError(next);
        return next.profile;
      },
      save: async (attempt, signal) => {
        if (!current() || attempt.before.accountId !== accountId || attempt.after.accountId !== accountId)
          throw new Error('Profile selection changed');
        const result = await runtime.save(
          {
            accountId,
            viewerId,
            patch: attempt.patch,
            idempotencyKey: attempt.idempotencyKey,
            confirmed: true,
          },
          csrfToken,
          signal,
        );
        if (current() && !signal?.aborted && !result.ok && [401, 403, 404].includes(result.status))
          setPage({ state: result.status === 404 ? 'missing' : result.status === 401 ? 'signed-out' : 'denied' });
        return result;
      },
    });
    return {
      editor,
      attach: () => lease.attach(() => editor.retire()),
    };
  });
  const { editor } = binding;
  useLayoutEffect(() => binding.attach(), [binding]);
  useEffect(() => {
    void editor.reload();
  }, [editor]);
  return (
    <ProfileNavigation editor={editor}>
      <AccountProfileView accountId={accountId} editor={editor} page={page} presentation={presentation} />
    </ProfileNavigation>
  );
}

export function AccountProfileView({
  accountId,
  editor,
  page,
  presentation,
}: {
  accountId: string;
  editor: AccountProfileEditor;
  page: ProfilePage | null;
  presentation: AccountProfilePresentation;
}) {
  const { ProfileCard, ProfileFeedback, PublicViewsCard } = presentation;
  const confirmation = useSyncExternalStore(
    editor.subscribeConfirmation,
    editor.confirmationSnapshot,
    editor.confirmationSnapshot,
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  // The editor refuses reads before a captured Retry-After deadline; the control shows that wait.
  const readWaiting = usePreferenceRetry(undefined, state.readRetryAt);
  if (!page && state.readStatus !== 'failed') return <p role="status">{m.settings_profile_loading()}</p>;
  page ??= { state: 'unavailable' };
  if (page.state !== 'ready')
    return (
      <Alert>
        <AlertTitle>{m.account_profile_title()}</AlertTitle>
        <AlertDescription>
          <p role="alert">
            {page.state === 'denied'
              ? m.account_profile_denied()
              : page.state === 'missing'
                ? m.account_profile_missing()
                : page.state === 'signed-out'
                  ? m.account_profile_signed_out()
                  : m.account_profile_unavailable()}
          </p>
          {state.attempt ? (
            <ProfileFeedback
              editor={editor}
              scope={state.attempt.scope}
              writable={page.state === 'unavailable'}
              readable={page.state !== 'signed-out'}
            />
          ) : (
            <>
              {readWaiting ? (
                <p role="status">
                  {m.settings_profile_reload_current()}: {m.settings_retry_wait()}
                </p>
              ) : null}
              <Button
                variant="outline"
                disabled={state.phase === 'reloading' || readWaiting}
                onClick={() => void editor.reload()}
              >
                {m.settings_profile_reload_current()}
              </Button>
            </>
          )}
          {page.state === 'signed-out' ? (
            <a
              className="text-primary underline"
              href={`/auth/sign-in?return_to=${encodeURIComponent(accountProfileHref(accountId))}`}
            >
              {m.managed_sign_in_title()}
            </a>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  return (
    <>
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">{page.profile.displayName || m.managed_unnamed()}</h2>
        <p className="break-all text-sm text-muted-foreground">{accountId}</p>
        <p className="text-sm text-muted-foreground">{m.account_profile_authority()}</p>
      </header>
      <ProfileCard editor={editor} />
      <PublicViewsCard editor={editor} />
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) editor.cancelConfirmation();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.account_profile_confirm_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.account_profile_confirm_text()} <span className="break-all">{accountId}</span>{' '}
              {confirmation === 'views' ? m.settings_public_activity_heading() : m.settings_profile_heading()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.account_profile_cancel()}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void editor.confirm()}>{m.account_profile_confirm()}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
