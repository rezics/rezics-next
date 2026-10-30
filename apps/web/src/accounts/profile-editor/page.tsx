import { useEffect, useState, useSyncExternalStore } from 'react';
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
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { useSession } from '../../session/query';
import { ProfileCard } from '../../settings/profile';
import { PublicViewsCard } from '../../settings/public-views';
import { csrfHeaders } from '../../threads/composer';
import { readAccountProfile, saveAccountProfile } from './actions';
import { AccountProfileEditor } from './editor';
import type { ProfilePage } from './data';

export function accountProfileHref(accountId: string, locale = getLocale()) {
  return `/${locale}/accounts/${encodeURIComponent(accountId)}/profile`;
}
export function AccountProfilePage({ accountId }: { accountId: string }) {
  const session = useSession();
  return (
    <article className="mx-auto w-full max-w-2xl space-y-6 pb-8">
      <PageHeading>{m.account_profile_title()}</PageHeading>
      {session.state === 'signed-in' && session.subject && session.csrfToken ? (
        <BoundProfile
          key={`${accountId}:${session.subject}:${session.csrfToken}`}
          accountId={accountId}
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
function BoundProfile({ accountId, viewerId, csrfToken }: { accountId: string; viewerId: string; csrfToken: string }) {
  const [page, setPage] = useState<ProfilePage | null>(null);
  const [editor] = useState(
    () =>
      new AccountProfileEditor({
        read: async () => {
          let current: ProfilePage;
          try {
            current = await readAccountProfile({ data: { accountId, viewerId } });
          } catch {
            current = { state: 'unavailable' };
          }
          // Never seed an editor from another target or viewer, including a late server response.
          if (current.state === 'ready' && (current.viewerId !== viewerId || current.profile.accountId !== accountId))
            current = { state: 'unavailable' };
          setPage(current);
          if (current.state !== 'ready') throw new Error(current.state);
          return current.profile;
        },
        save: async (attempt) => {
          if (attempt.before.accountId !== accountId || attempt.after.accountId !== accountId)
            throw new Error('Profile selection changed');
          // Capture this binding's CSRF identity rather than the mutable global session token.
          const result = await saveAccountProfile({
            data: {
              accountId,
              viewerId,
              patch: attempt.patch,
              idempotencyKey: attempt.idempotencyKey,
              confirmed: true,
            },
            headers: { ...csrfHeaders(), 'X-CSRF-Token': csrfToken },
          });
          if (!result.ok && [401, 403, 404].includes(result.status))
            setPage({ state: result.status === 404 ? 'missing' : result.status === 401 ? 'signed-out' : 'denied' });
          return result;
        },
      }),
  );
  useEffect(() => {
    void editor.reload();
  }, [editor]);
  return <AccountProfileView accountId={accountId} editor={editor} page={page} />;
}

export function AccountProfileView({
  accountId,
  editor,
  page,
}: {
  accountId: string;
  editor: AccountProfileEditor;
  page: ProfilePage | null;
}) {
  const confirmation = useSyncExternalStore(
    editor.subscribeConfirmation,
    editor.confirmationSnapshot,
    editor.confirmationSnapshot,
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  if (!page) return <p role="status">{m.settings_profile_loading()}</p>;
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
          <Button variant="outline" disabled={state.phase === 'reloading'} onClick={() => void editor.reload()}>
            {m.settings_profile_reload_current()}
          </Button>
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
