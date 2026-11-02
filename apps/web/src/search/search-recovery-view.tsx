import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import type { SearchRecoveryState } from './search-recovery';
import { useSearchRetryWait } from './search-recovery-retry';

type MessageOptions = { locale: (typeof locales)[number] };

function messageOptions(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

/** Callers may omit locale so existing ambient selection stays compatible. */
export function searchRecoveryMessage(state: SearchRecoveryState, locale?: string): string {
  const options = locale === undefined ? undefined : messageOptions(locale);
  switch (state.status) {
    case 'loading':
      return m.discovery_loading({}, options);
    case 'invalid':
      return state.problem?.code === 'unsupported_query'
        ? m.discovery_unsupported({}, options)
        : m.discovery_invalid({}, options);
    case 'invalid-cursor':
      return m.search_recovery_cursor({}, options);
    case 'session':
      return m.search_recovery_session({}, options);
    case 'closed':
      return m.discovery_closed({}, options);
    case 'denied':
      return m.discovery_denied({}, options);
    case 'restart':
      return m.discovery_restart({}, options);
    case 'index-not-ready':
    case 'source-not-ready':
      return m.search_reader_results_unavailable({}, options);
    default:
      return m.search_reader_results_unavailable({}, options);
  }
}

/** The timer enables a manual action. It never fetches, polls or advances a preparation. */
export function SearchRecovery({
  state,
  retryHref,
  restartHref,
  onRetry,
  locale,
}: {
  state: SearchRecoveryState;
  retryHref: string;
  restartHref: string;
  onRetry?: (() => void) | undefined;
  locale?: string;
}) {
  const retryAt = state.status !== 'ready' ? state.retryAt : undefined;
  const waiting = useSearchRetryWait(retryAt);
  if (state.status === 'ready') return null;
  const options = locale === undefined ? undefined : messageOptions(locale);
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
        <EmptyTitle className="text-base font-normal">{searchRecoveryMessage(state, locale)}</EmptyTitle>
      </EmptyHeader>
      {waiting && retry && <p className="text-sm text-muted-foreground">{m.search_recovery_wait({}, options)}</p>}
      {retry &&
        (onRetry ? (
          <Button type="button" variant="outline" disabled={waiting} onClick={onRetry}>
            {m.search_facet_retry({}, options)}
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
            {m.search_facet_retry({}, options)}
          </a>
        ))}
      {restart && (
        <a href={restartHref} className={buttonVariants({ variant: 'outline' })}>
          {m.discovery_restart_action({}, options)}
        </a>
      )}
      {state.status === 'invalid' && (
        <p className="text-sm text-muted-foreground">{m.search_recovery_edit({}, options)}</p>
      )}
      {state.status === 'session' && (
        <a
          href={`/auth/sign-in?return_to=${encodeURIComponent(retryHref)}`}
          className={buttonVariants({ variant: 'outline' })}
        >
          {m.account_sign_in({}, options)}
        </a>
      )}
    </Empty>
  );
}
