import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { ErrorPage, StatusPage } from './shell';

export function ClosedPage() {
  return <StatusPage heading={m.platform_closed_heading()} message={m.platform_closed_message()} />;
}

export function ClosedErrorPage({ error }: { error: unknown }) {
  return isPlatformClosedError(error) ? <ClosedPage /> : <ErrorPage />;
}
