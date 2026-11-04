import { getLocale, type Locale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { RouteState } from '../route-state';

export function DependencyUnavailablePage({
  locale = getLocale(),
  retryHref,
  returnHref,
  commandMayHaveCompleted = false,
  onRetry,
  retrying = false,
  retryFailed = false,
  retryDisabled = false,
  recovery,
}: {
  locale?: Locale;
  retryHref?: string;
  returnHref?: string;
  commandMayHaveCompleted?: boolean;
  onRetry?: (() => void) | undefined;
  retrying?: boolean;
  retryFailed?: boolean;
  retryDisabled?: boolean;
  recovery?: string;
}) {
  return (
    <RouteState
      kind="unavailable"
      locale={locale}
      message={
        commandMayHaveCompleted
          ? m.dependency_unavailable_command_message({}, { locale })
          : m.dependency_unavailable_message({}, { locale })
      }
      {...(retryHref ? { retryHref } : {})}
      {...(returnHref ? { returnHref } : {})}
      onRetry={onRetry}
      retrying={retrying}
      retryFailed={retryFailed}
      retryDisabled={retryDisabled}
      {...(recovery ? { recovery } : {})}
    />
  );
}
