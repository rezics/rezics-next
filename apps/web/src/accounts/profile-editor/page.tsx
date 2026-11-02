import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { sessionQuery, useSession } from '../../session/query';
import { normalizeSessionObservation } from '../../session/browser-state';
import { ProfileCard } from '../../settings/profile';
import { PublicViewsCard } from '../../settings/public-views';
import { readAccountProfile, saveAccountProfile } from './actions';
import { AccountProfileEditor } from './editor';
import type { ProfilePage } from './data';

export function accountProfileHref(accountId: string, locale = getLocale()) {
  return `/${locale}/accounts/${encodeURIComponent(accountId)}/profile`;
}
export function AccountProfilePage({ accountId }: { accountId: string }) {
  const session = useSession();
  const client = useQueryClient();
  const record = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  const revision = record?.state.dataUpdateCount;
  // A new committed session observation or provider starts a fresh draft lifetime.
  const observation = useMemo(() => crypto.randomUUID(), [client, record, revision]);
  return (
    <article className="mx-auto w-full max-w-2xl space-y-6 pb-8">
      <PageHeading>{m.account_profile_title()}</PageHeading>
      {session.state === 'signed-in' && session.subject && session.csrfToken ? (
        <BoundProfile
          key={`${accountId}:${observation}:${session.subject}:${session.csrfToken}`}
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
  const client = useQueryClient();
  const [page, setPage] = useState<ProfilePage | null>(null);
  const [binding] = useState(() => {
    const record = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    const revision = record?.state.dataUpdateCount;
    let attachments = 0;
    const current = () => {
      const latest = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      if (!attachments || !record || latest !== record || latest.state.status !== 'success') return false;
      const session = normalizeSessionObservation(latest.state.data);
      return (
        latest.state.dataUpdateCount === revision &&
        session.state === 'signed-in' &&
        session.subject === viewerId &&
        session.csrfToken === csrfToken
      );
    };
    const editor = new AccountProfileEditor({
      isCurrent: current,
      read: async (signal) => {
        if (!current()) throw new Error('Profile selection changed');
        let next: ProfilePage;
        try {
          next = await readAccountProfile({ data: { accountId, viewerId }, signal });
        } catch {
          next = { state: 'unavailable' };
        }
        // A detached request may complete, but cannot seed or replace any live draft.
        if (!current() || signal?.aborted) throw new Error('Profile selection changed');
        if (next.state === 'ready' && (next.viewerId !== viewerId || next.profile.accountId !== accountId))
          next = { state: 'unavailable' };
        setPage(next);
        if (next.state !== 'ready') throw new Error(next.state);
        return next.profile;
      },
      save: async (attempt, signal) => {
        if (!current() || attempt.before.accountId !== accountId || attempt.after.accountId !== accountId)
          throw new Error('Profile selection changed');
        const result = await saveAccountProfile({
          data: {
            accountId,
            viewerId,
            patch: attempt.patch,
            idempotencyKey: attempt.idempotencyKey,
            confirmed: true,
          },
          headers: { 'X-CSRF-Token': csrfToken },
          signal,
        });
        if (current() && !signal?.aborted && !result.ok && [401, 403, 404].includes(result.status))
          setPage({ state: result.status === 404 ? 'missing' : result.status === 401 ? 'signed-out' : 'denied' });
        return result;
      },
    });
    return {
      editor,
      attach: () => {
        attachments++;
        if (!current()) editor.retire();
        // Cache notifications revoke callbacks before React renders the replacement session.
        const unsubscribe = client.getQueryCache().subscribe(() => {
          if (!current()) editor.retire();
        });
        return () => {
          attachments--;
          unsubscribe();
          // StrictMode can reconnect within the same turn. No command is current while detached.
          queueMicrotask(() => {
            if (!attachments) editor.retire();
          });
        };
      },
    };
  });
  const { editor } = binding;
  useLayoutEffect(() => binding.attach(), [binding]);
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
