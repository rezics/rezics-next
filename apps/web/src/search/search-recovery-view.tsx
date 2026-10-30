import { useEffect, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../paraglide/messages.js';
import type { SearchRecoveryState } from './search-recovery';

export function searchRecoveryMessage(state: SearchRecoveryState): string {
  switch (state.status) {
    case 'loading':
      return m.discovery_loading();
    case 'invalid':
      return state.problem?.code === 'unsupported_query' ? m.discovery_unsupported() : m.discovery_invalid();
    case 'invalid-cursor':
      return m.search_recovery_cursor();
    case 'session':
      return m.search_recovery_session();
    case 'closed':
      return m.discovery_closed();
    case 'denied':
      return m.discovery_denied();
    case 'restart':
      return m.discovery_restart();
    case 'index-not-ready':
      return m.discovery_not_ready();
    case 'source-not-ready':
      return m.search_recovery_source();
    default:
      return m.search_failed();
  }
}

/** The timer enables a manual action. It never fetches, polls or advances a preparation. */
export function SearchRecovery({
  state,
  retryHref,
  restartHref,
  onRetry,
}: {
  state: SearchRecoveryState;
  retryHref: string;
  restartHref: string;
  onRetry?: (() => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  const retryAt = state.status !== 'ready' ? state.retryAt : undefined;
  useEffect(() => {
    if (retryAt === undefined || retryAt <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(retryAt - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryAt, now]);
  if (state.status === 'ready') return null;
  const waiting = retryAt !== undefined && retryAt > Math.max(now, Date.now());
  const retry = ['index-not-ready', 'source-not-ready', 'unavailable'].includes(state.status);
  const restart = state.status === 'restart' || state.status === 'invalid-cursor';
  return (
    <Empty
      className="border"
      role={state.status === 'loading' || retry ? 'status' : 'alert'}
      aria-busy={state.status === 'loading'}
      data-search-recovery={state.status}
    >
      <EmptyHeader>
        <EmptyTitle className="text-base font-normal">{searchRecoveryMessage(state)}</EmptyTitle>
      </EmptyHeader>
      {waiting && retry && <p className="text-sm text-muted-foreground">{m.search_recovery_wait()}</p>}
      {retry &&
        (onRetry ? (
          <Button type="button" variant="outline" disabled={waiting} onClick={onRetry}>
            {m.search_facet_retry()}
          </Button>
        ) : (
          <a
            href={retryHref}
            aria-disabled={waiting || undefined}
            tabIndex={waiting ? -1 : undefined}
            onClick={(event) => {
              if (waiting) event.preventDefault();
            }}
            className={buttonVariants({ variant: 'outline' })}
          >
            {m.search_facet_retry()}
          </a>
        ))}
      {restart && (
        <a href={restartHref} className={buttonVariants({ variant: 'outline' })}>
          {m.discovery_restart_action()}
        </a>
      )}
      {state.status === 'invalid' && <p className="text-sm text-muted-foreground">{m.search_recovery_edit()}</p>}
      {state.status === 'session' && (
        <a
          href={`/auth/sign-in?return_to=${encodeURIComponent(retryHref)}`}
          className={buttonVariants({ variant: 'outline' })}
        >
          {m.account_sign_in()}
        </a>
      )}
    </Empty>
  );
}
