import { useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { OwnDraftsPage } from '../threads/own-drafts/page';
import { ownDraftBrowserWritingReader } from '../threads/own-drafts/browser-writing';
import { ownDraftNativeReader } from '../threads/own-drafts/native-reader';
import { publishOwnDraft, readOwnDraftPost } from '../threads/own-drafts/actions';
import type { OwnDraftCommands, OwnDraftIdentity } from '../threads/own-drafts/model';
import { draftFetch } from '../threads/composer';
import { erasePost, revisePost } from '../threads/actions';
import { pageHead } from '../shell/head';
import { pageHeadContext } from '../shell/head-context';
import { requireSignedIn } from '../session/guard';
import { sessionCsrfToken, useSession } from '../session/query';
import { sessionQueryKey } from '../session/browser-state';

export const Route = createFileRoute('/drafts')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.own_drafts_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: DraftsRoute,
});

function useSessionRevision(): number {
  const client = useQueryClient();
  const observation = useMemo(() => {
    let revision = 0;
    return {
      subscribe(listener: () => void) {
        return client.getQueryCache().subscribe((event) => {
          if (event.query.queryKey.length !== sessionQueryKey.length || event.query.queryKey[0] !== sessionQueryKey[0])
            return;
          revision++;
          listener();
        });
      },
      snapshot: () => revision,
    };
  }, [client]);
  return useSyncExternalStore(observation.subscribe, observation.snapshot, () => 0);
}

function DraftsRoute() {
  const session = useSession();
  const sessionRevision = useSessionRevision();
  const locale = getLocale();
  const identity = useMemo<OwnDraftIdentity>(
    () => ({
      accountId: session.subject ?? '',
      authnEpoch: 0,
      callerEpoch: String(sessionRevision),
      locale,
      source: 'content',
      address: '/drafts',
    }),
    [locale, session.subject, sessionRevision],
  );
  const localWritingReader = useMemo(() => ownDraftBrowserWritingReader(() => window.localStorage), []);
  const commands = useMemo<OwnDraftCommands>(
    () => ({
      async write(input, signal) {
        const csrfToken = sessionCsrfToken();
        if (!csrfToken) return { ok: false, reason: 'unavailable' };
        const data = {
          postId: input.postId,
          body: input.body,
          revisionId: input.revisionId,
          idempotencyKey: input.idempotencyKey,
          mediaIds: [...input.mediaIds],
        };
        if (input.action === 'publish')
          return publishOwnDraft({ data, headers: { 'X-CSRF-Token': csrfToken }, signal, fetch: draftFetch(input.body) });
        return revisePost({ data, headers: { 'X-CSRF-Token': csrfToken }, signal, fetch: draftFetch(input.body) });
      },
      async erase(input, signal) {
        const csrfToken = sessionCsrfToken();
        if (!csrfToken) return { ok: false, reason: 'unavailable' };
        return erasePost({
          data: {
            postId: input.postId,
            idempotencyKey: input.idempotencyKey,
            ...(input.opening ? { openingThreadId: input.threadId } : {}),
          },
          headers: { 'X-CSRF-Token': csrfToken },
          signal,
        });
      },
      async readback(postId, signal) {
        return readOwnDraftPost({ data: { postId }, signal });
      },
    }),
    [],
  );
  const active = session.state === 'signed-in' && !!session.subject && !!session.csrfToken;
  return (
    <OwnDraftsPage
      identity={identity}
      active={active}
      reader={ownDraftNativeReader}
      localWritingReader={localWritingReader}
      commands={commands}
    />
  );
}
