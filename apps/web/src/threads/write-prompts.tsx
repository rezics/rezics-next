import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

export function ExistingReviewNotice({ reviewId }: { reviewId: string }) {
  const locale = getLocale();
  return (
    <p className="min-w-0 [overflow-wrap:anywhere]">
      {m.thread_review_duplicate()}{' '}
      <a
        className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        href={`/${locale}/threads/${reviewId}`}
      >
        {m.thread_review_existing()}
      </a>
    </p>
  );
}

export function SignInPrompt({
  returnTo,
  label,
  compact = false,
}: {
  returnTo: string;
  label?: string;
  compact?: boolean;
}) {
  const href = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  const text = label ?? m.account_sign_in();
  if (compact)
    return (
      <a
        className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal rounded-lg border border-border px-4 py-2 font-medium text-primary underline-offset-4 [overflow-wrap:anywhere] hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        href={href}
      >
        {text}
      </a>
    );
  return (
    <p className="min-w-0 rounded-lg border border-border/70 bg-card p-4 text-muted-foreground [overflow-wrap:anywhere]">
      <a
        className="inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal rounded-sm py-2 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        href={href}
      >
        {text}
      </a>
    </p>
  );
}
