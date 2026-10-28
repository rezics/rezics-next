import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { pageHead, type HeadContext } from './head.ts';
import { ErrorPage, StatusPage } from './shell';

export function closedPageHead(context: HeadContext) {
  return pageHead({ robots: 'noindex' }, context);
}

export function ClosedPage() {
  return <StatusPage heading={m.platform_closed_heading()} message={m.platform_closed_message()} />;
}

export function ClosedErrorPage({ error }: { error: unknown }) {
  return isPlatformClosedError(error) ? <ClosedPage /> : <ErrorPage />;
}
