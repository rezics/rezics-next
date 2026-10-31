import { useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { sessionQuery, type useSession } from '../session/query';
import { SignInPrompt } from '../threads/write-prompts';
import { m } from '../paraglide/messages.js';
import { inboxEntryState, type InboxSessionRead } from './inbox-viewer';

export function retryInboxSession(client: QueryClient) {
  // Force one existing server read even when an unavailable result is fresh forever.
  return client.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

/** Only mounted without a current viewer; this component never reads private Inbox data. */
export function InboxEntryState({
  state,
  sessionRead,
}: {
  state: ReturnType<typeof useSession>['state'];
  sessionRead?: InboxSessionRead | undefined;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);
  const entry = inboxEntryState(state, sessionRead);
  const pending = retrying || sessionRead?.fetchStatus === 'fetching';

  if (entry === 'signed-out')
    return (
      <div className="mt-6">
        <SignInPrompt returnTo={location.publicHref} label={m.inbox_sign_in()} compact />
      </div>
    );
  if (entry === 'loading' && !retrying)
    return (
      <p role="status" aria-busy="true" className="mt-6 text-muted-foreground">
        {m.inbox_loading()}
      </p>
    );
  return (
    <section role="status" aria-busy={pending} className="mt-6 flex flex-col items-start gap-4">
      <p className="text-muted-foreground">{m.inbox_session_unavailable()}</p>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setRetrying(true);
          void retryInboxSession(client)
            .catch(() => {
              // The shared query retains the failure for the next deliberate retry.
            })
            .finally(() => setRetrying(false));
        }}
      >
        {m.inbox_retry()}
      </Button>
    </section>
  );
}
