import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { ErrorPage } from './shell';

export function ClosedPage() {
  return (
    <>
      <h1 className="font-serif text-3xl">{m.platform_closed_heading()}</h1>
      <p>{m.platform_closed_message()}</p>
    </>
  );
}

export function ClosedErrorPage({ error }: { error: unknown }) {
  return isPlatformClosedError(error) ? <ClosedPage /> : <ErrorPage />;
}
