import { LogIn } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import { isSessionUnavailableError } from './unavailable';
import type { SessionAccess } from './guard';

export type SessionUnavailablePage = { sessionUnavailable: true; signInHref: string };

export function isSessionUnavailablePage(value: unknown): value is SessionUnavailablePage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionUnavailable' in value &&
    value.sessionUnavailable === true &&
    'signInHref' in value &&
    typeof value.signInHref === 'string'
  );
}

/** Avoid private reads when the request session is unresolved; preserve unrelated failures. */
export async function loadPrivatePage<T>(access: SessionAccess, read: () => T | Promise<T>): Promise<T | SessionUnavailablePage> {
  const unavailable = { sessionUnavailable: true as const, signInHref: access.signInHref };
  if (access.state !== 'signed-in') return unavailable;
  try {
    return await read();
  } catch (error) {
    if (isSessionUnavailableError(error)) return unavailable;
    throw error;
  }
}

export function SessionUnavailablePrompt({ signInHref }: { signInHref: string }) {
  return (
    <section className="grid max-w-prose justify-items-start gap-4 rounded-2xl border border-border p-5">
      <p role="status" className="text-sm text-muted-foreground">
        {m.shell_account_unavailable()}
      </p>
      <a
        href={signInHref}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <LogIn aria-hidden="true" className="size-4 shrink-0" />
        {m.account_sign_in()}
      </a>
    </section>
  );
}
