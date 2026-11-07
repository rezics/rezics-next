import type { Locale } from '../paraglide/runtime.js';
import { DependencyUnavailablePage } from '../shell/dependency-recovery/page';
import { sessionRecoverySignInHref } from './unavailable';

/** Callers pass the visit pathname and locale; this leaf does not read the router. */
export function SessionRecoveryPage({ pathname, locale }: { pathname: string; locale: Locale }) {
  return <DependencyUnavailablePage locale={locale} signInHref={sessionRecoverySignInHref(pathname)} />;
}
