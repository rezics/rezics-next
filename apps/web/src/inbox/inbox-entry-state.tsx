import { useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { productionInboxShellPort } from './adapters/shell';
import type { InboxSessionObservation } from './ports/shell';
import { SignInPrompt } from '../threads/write-prompts';
import { m } from '../paraglide/messages.js';
import { inboxEntryState, type InboxSessionRead } from './inbox-viewer';

export function retryInboxSession(client: QueryClient) {
  // Force one existing server read even when an unavailable result is fresh forever.
  return productionInboxShellPort.refreshSession(client);
}

function inboxReturnDestination(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/inbox';
  try {
    const origin = 'https://inbox.invalid';
    const target = new URL(value, origin);
    const path = target.pathname + target.search + target.hash;
    return target.origin === origin && !path.startsWith('//') ? path : '/inbox';
  } catch {
    return '/inbox';
  }
}

/** Only mounted without a current viewer; this component never reads private Inbox data. */
export function InboxEntryState({
  state,
  sessionRead,
}: {
  state: InboxSessionObservation['state'];
  sessionRead?: InboxSessionRead | undefined;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);
  const entry = inboxEntryState(state, sessionRead);
  const pending = retrying || sessionRead?.fetchStatus === 'fetching';

  if (entry === 'signed-out')
    return (
      <div className="mt-6 w-full max-w-full [&_a]:min-h-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:break-words [&_a]:py-2 [&_a]:leading-5">
        <SignInPrompt returnTo={inboxReturnDestination(location.publicHref)} label={m.inbox_sign_in()} compact />
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
        className="h-auto min-h-11 max-w-full whitespace-normal break-words py-2 text-left leading-5"
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
